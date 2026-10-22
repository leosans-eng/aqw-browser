import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  DROPPED_RESPONSE_HEADERS,
  corsHeaders,
  createSocketDirectory,
  originAllowed,
  parseOrigins,
  parseProxyPath,
  rewriteLocation,
  rewriteSetCookie,
  upstreamRequestHeaders,
} from "./relay/core.js";

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const RUFFLE_DIR = path.join(ROOT, "node_modules", "@ruffle-rs", "ruffle");
const ALLOWED_ORIGINS = [
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  ...parseOrigins(process.env.ALLOWED_ORIGINS),
];

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const sockets = createSocketDirectory();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function relayBase(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host || `${HOST}:${PORT}`}`;
}

function resolveInside(root, urlPath) {
  const full = path.resolve(root, `.${decodeURIComponent(urlPath)}`);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return full;
}

function serveStatic(req, res, url) {
  let filePath;
  if (url.pathname === "/") filePath = path.join(PUBLIC_DIR, "index.html");
  else if (url.pathname.startsWith("/vendor/")) filePath = resolveInside(RUFFLE_DIR, url.pathname.slice("/vendor".length));
  else filePath = resolveInside(PUBLIC_DIR, url.pathname);

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": url.pathname.startsWith("/vendor/") ? "public, max-age=86400" : "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function serveSocketList(req, res) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(req.headers.origin, ALLOWED_ORIGINS),
  });
  res.end(JSON.stringify(await sockets.list()));
}

function proxyHttp(req, res, url) {
  const target = parseProxyPath(url.pathname, url.search);
  const cors = corsHeaders(req.headers.origin, ALLOWED_ORIGINS);
  if (!target.allowed) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8", ...cors });
    res.end("Host not allowed");
    return;
  }

  const base = relayBase(req);
  const secureRelay = base.startsWith("https:");
  const upstream = https.request(
    {
      agent,
      hostname: target.host,
      port: 443,
      method: req.method,
      path: target.path,
      headers: upstreamRequestHeaders(target.host, (name) => req.headers[name]),
      timeout: 120_000,
    },
    (up) => {
      const raw = [];
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        const key = up.rawHeaders[i];
        const value = up.rawHeaders[i + 1];
        const lower = key.toLowerCase();
        if (DROPPED_RESPONSE_HEADERS.has(lower)) continue;
        if (lower === "set-cookie") raw.push(key, rewriteSetCookie(value, secureRelay));
        else if (lower === "location") raw.push(key, rewriteLocation(value, target.host, base));
        else raw.push(key, value);
      }
      for (const [key, value] of Object.entries(cors)) raw.push(key, value);
      res.writeHead(up.statusCode || 502, raw);
      up.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (error) => {
    console.warn(`proxy ${target.host}${target.path} failed: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8", ...cors });
    res.end(error.message);
  });
  req.pipe(upstream);
}

function bridgeSocket(ws, host, port) {
  const tcp = net.createConnection({ host, port, noDelay: true });
  tcp.setKeepAlive(true, 10_000);
  let closed = false;
  const connectTimer = setTimeout(() => tcp.destroy(new Error("connect timeout")), 15_000);

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
    if (ws.readyState === ws.OPEN) ws.send(chunk);
    else closeBoth();
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
    if (tcp.writable) tcp.write(isBinary ? data : Buffer.from(data));
  });
  ws.on("close", closeBoth);
  ws.on("error", closeBoth);
}

if (!fs.existsSync(path.join(RUFFLE_DIR, "ruffle.js"))) {
  console.error("Ruffle is not installed. Run: npm install");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://relay.local");
  const origin = req.headers.origin;

  if (req.method === "OPTIONS") {
    res.writeHead(originAllowed(origin, ALLOWED_ORIGINS) ? 204 : 403, corsHeaders(origin, ALLOWED_ORIGINS));
    res.end();
    return;
  }
  if (url.pathname.startsWith("/proxy/") || url.pathname === "/api/sockets") {
    if (!originAllowed(origin, ALLOWED_ORIGINS)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Origin not allowed");
      return;
    }
    if (url.pathname === "/api/sockets") {
      serveSocketList(req, res).catch((error) => {
        res.writeHead(500);
        res.end(error.message);
      });
    } else {
      proxyHttp(req, res, url);
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  serveStatic(req, res, url);
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, "http://relay.local");
  const host = (url.searchParams.get("host") || "").toLowerCase();
  const port = Number(url.searchParams.get("port"));
  if (url.pathname !== "/socket" || !originAllowed(req.headers.origin, ALLOWED_ORIGINS) || !(await sockets.allows(host, port))) {
    console.warn(`rejected socket ${host}:${port}`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => bridgeSocket(ws, host, port));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. A game server is probably still running at http://${HOST}:${PORT}`);
    process.exit(1);
  }
  throw error;
});

await sockets.list();
server.listen(PORT, HOST, () => {
  console.log(`AQW browser: http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
});
