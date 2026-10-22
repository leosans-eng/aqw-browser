import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8787;
const BIND = "127.0.0.1";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

const ALLOWED_SUFFIXES = ["aq.com", "aqworlds.com", "artix.com", "battleon.com"];
const SERVERS_API = "https://game.aq.com/game/api/data/servers";

const FALLBACK_HOSTS = {
  "sock7.aq.com": [5588, 5589, 5591, 5592, 5593, 5594],
  "sock8.aq.com": [5588, 5589, 5590, 5591, 5593],
  "euro.aqw.artix.com": [5588],
  "asia.game.artix.com": [5588],
};

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const fileCache = new Map();
let fileCacheBytes = 0;
const FILE_CACHE_LIMIT = 256 * 1024 * 1024;
const FILE_CACHE_ITEM_LIMIT = 16 * 1024 * 1024;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let socketTargets = new Map();

function hostAllowed(host) {
  const name = String(host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  return ALLOWED_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

function addSocket(map, host, port) {
  const name = String(host || "").trim().toLowerCase();
  const numeric = Number(port);
  if (!hostAllowed(name) || !Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return;
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(numeric);
  map.get(name).add(843);
}

function loadFallback(map) {
  for (const [host, ports] of Object.entries(FALLBACK_HOSTS)) {
    for (const port of ports) addSocket(map, host, port);
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
    url,
    { agent, headers: { accept: "application/json", "user-agent": BROWSER_UA } },
    (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`${url} returned ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("server list timeout")));
    req.on("error", reject);
  });
}

async function refreshSockets() {
  const map = new Map();
  loadFallback(map);
  try {
    const servers = await fetchJson(SERVERS_API);
    if (!Array.isArray(servers)) throw new Error("server list was not an array");
    for (const server of servers) addSocket(map, server.sIP, server.iPort);
    const ports = [...map.values()].reduce((sum, set) => sum + set.size, 0);
    console.log(`Artix server list: ${servers.length} worlds, ${map.size} hosts, ${ports} socket endpoints`);
  } catch (error) {
    console.warn(`Artix server list unavailable (${error.message}); using the built-in host list`);
  }
  socketTargets = map;
}

function socketAllowed(host, port) {
  const ports = socketTargets.get(String(host || "").toLowerCase());
  return Boolean(ports && ports.has(Number(port)));
}

function requestOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return local && String(url.port) === String(PORT);
  } catch {
    return false;
  }
}

function localHostHeader(req) {
  const host = req.headers.host || "";
  return /^(127\.0\.0\.1|localhost):\d+$/.test(host) ? host : `${BIND}:${PORT}`;
}

function proxyList(req) {
  const host = localHostHeader(req);
  const list = [];
  for (const [name, ports] of socketTargets) {
    for (const port of ports) {
      list.push({
        host: name,
        port,
        proxyUrl: `ws://${host}/socket?host=${encodeURIComponent(name)}&port=${port}`,
      });
    }
  }
  return list;
}

function rewriteCookie(cookie) {
  let next = cookie.replace(/;\s*Domain=[^;]*/gi, "").replace(/;\s*Secure/gi, "").replace(/;\s*SameSite=[^;]*/gi, "");
  next = /;\s*Path=/i.test(next) ? next.replace(/;\s*Path=[^;]*/i, "; Path=/") : `${next}; Path=/`;
  return `${next}; SameSite=Lax`;
}

function rewriteLocation(value, requestHost) {
  try {
    const absolute = new URL(value, `https://${requestHost}/`);
    if (absolute.protocol !== "https:" && absolute.protocol !== "http:") return value;
    if (!hostAllowed(absolute.hostname)) return value;
    return `http://${BIND}:${PORT}/proxy/${absolute.hostname}${absolute.pathname}${absolute.search}`;
  } catch {
    return value;
  }
}

function findRuffleDir() {
  const candidates = [
    path.join(ROOT, "node_modules", "@ruffle-rs", "ruffle"),
    path.join(ROOT, "node_modules", "@ruffle-rs", "ruffle", "dist"),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "ruffle.js"))) || null;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function resolveInside(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const full = path.resolve(root, `.${clean}`);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return full;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${BIND}`);
  if (url.pathname === "/crossdomain.xml") {
    res.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
    res.end(`<?xml version="1.0"?>
<cross-domain-policy>
  <site-control permitted-cross-domain-policies="all"/>
  <allow-access-from domain="*" secure="false"/>
  <allow-http-request-headers-from domain="*" headers="*" secure="false"/>
</cross-domain-policy>`);
    return;
  }

  if (url.pathname === "/api/socket-proxies") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(proxyList(req)));
    return;
  }

  let filePath = null;
  if (url.pathname === "/" || url.pathname === "/index.html") {
    filePath = path.join(PUBLIC_DIR, "index.html");
  } else if (url.pathname.startsWith("/vendor/")) {
    const ruffleDir = findRuffleDir();
    if (!ruffleDir) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Ruffle is not installed. Run npm install in this folder.");
      return;
    }
    filePath = resolveInside(ruffleDir, url.pathname.slice("/vendor".length));
  } else if (url.pathname.startsWith("/public/")) {
    filePath = resolveInside(PUBLIC_DIR, url.pathname.slice("/public".length));
  } else {
    filePath = resolveInside(PUBLIC_DIR, url.pathname);
  }

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  sendFile(res, filePath);
}

const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "strict-transport-security",
  "content-security-policy",
  "content-security-policy-report-only",
]);

function rememberFile(key, status, headers, body) {
  while (fileCacheBytes + body.length > FILE_CACHE_LIMIT && fileCache.size) {
    const oldest = fileCache.keys().next().value;
    fileCacheBytes -= fileCache.get(oldest).body.length;
    fileCache.delete(oldest);
  }
  fileCache.set(key, { status, headers, body });
  fileCacheBytes += body.length;
}

function proxyHttp(req, res) {
  const url = new URL(req.url, `http://${BIND}`);
  if (!url.pathname.startsWith("/proxy/")) return false;
  if (!requestOriginAllowed(req)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Origin not allowed");
    return true;
  }

  const rest = decodeURIComponent(url.pathname.slice("/proxy/".length));
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const targetPath = `${slash === -1 ? "/" : rest.slice(slash)}${url.search}`;
  if (!hostAllowed(host)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Host not allowed");
    return true;
  }

  const cacheKey = req.method === "GET" && !targetPath.includes("/api/") ? `${host}${targetPath}` : null;
  const cached = cacheKey ? fileCache.get(cacheKey) : null;
  if (cached) {
    res.writeHead(cached.status, cached.headers);
    res.end(cached.body);
    return true;
  }

  const headers = {
    host,
    accept: req.headers.accept || "*/*",
    "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
    "user-agent": BROWSER_UA,
    referer: "https://game.aq.com/game/",
    origin: "https://game.aq.com",
  };
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];

  const upstream = https.request(
    {
      agent,
      hostname: host,
      port: 443,
      method: req.method,
      path: targetPath,
      headers,
      timeout: 120000,
    },
    (up) => {
      const raw = [];
      let hasCookie = false;
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        const key = up.rawHeaders[i];
        const value = up.rawHeaders[i + 1];
        const lower = key.toLowerCase();
        if (DROPPED_RESPONSE_HEADERS.has(lower)) continue;
        if (lower === "set-cookie") {
          hasCookie = true;
          raw.push(key, rewriteCookie(value));
        } else if (lower === "location") raw.push(key, rewriteLocation(value, host));
        else raw.push(key, value);
      }
      res.writeHead(up.statusCode || 502, raw);

      const chunks = [];
      let bytes = 0;
      let store = Boolean(cacheKey) && up.statusCode === 200 && !hasCookie;
      up.on("data", (chunk) => {
        if (!store) return;
        bytes += chunk.length;
        if (bytes > FILE_CACHE_ITEM_LIMIT) {
          store = false;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      up.on("end", () => {
        if (store && cacheKey) rememberFile(cacheKey, up.statusCode, raw, Buffer.concat(chunks));
      });
      up.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (error) => {
    console.warn(`proxy ${host}${targetPath} failed: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(error.message);
  });
  req.pipe(upstream);
  return true;
}

function bridgeSocket(ws, host, port) {
  const tcp = net.createConnection({ host, port, noDelay: true });
  tcp.setKeepAlive(true, 10_000);
  let closed = false;
  const connectTimer = setTimeout(() => {
    if (!closed) tcp.destroy(new Error("connect timeout"));
  }, 15_000);

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    tcp.destroy();
  };

  tcp.on("connect", () => {
    clearTimeout(connectTimer);
    console.log(`socket open ${host}:${port}`);
  });
  tcp.on("data", (chunk) => {
    if (ws.readyState !== ws.OPEN) {
      closeBoth();
      return;
    }
    ws.send(chunk);
  });
  tcp.on("close", () => {
    console.log(`socket closed ${host}:${port}`);
    closeBoth();
  });
  tcp.on("error", (error) => {
    console.warn(`socket ${host}:${port} ${error.message}`);
    closeBoth();
  });

  ws.on("message", (data, isBinary) => {
    if (!tcp.writable) return;
    tcp.write(isBinary ? data : Buffer.from(data));
  });
  ws.on("close", () => tcp.destroy());
  ws.on("error", () => tcp.destroy());
}

const RUFFLE_DIR = findRuffleDir();
if (!RUFFLE_DIR) {
  console.error("Ruffle is not installed. Run: npm install");
  process.exit(1);
}

await refreshSockets();
setInterval(() => {
  refreshSockets().catch((error) => console.warn(error.message));
}, 5 * 60 * 1000);

const server = http.createServer((req, res) => {
  if (proxyHttp(req, res)) return;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${BIND}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/socket" || !requestOriginAllowed(req)) {
    socket.destroy();
    return;
  }
  const host = (url.searchParams.get("host") || "").toLowerCase();
  const port = Number(url.searchParams.get("port"));
  if (!socketAllowed(host, port)) {
    console.warn(`rejected socket ${host}:${port}`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => bridgeSocket(ws, host, port));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. A game server is still running at http://${BIND}:${PORT}`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, BIND, () => {
  console.log(`AQW browser: http://${BIND}:${PORT}`);
});
