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
} from "./core.js";

const ALLOWED_ORIGINS: string[] = parseOrigins(Deno.env.get("ALLOWED_ORIGINS"));
if (!ALLOWED_ORIGINS.length) {
  console.warn("ALLOWED_ORIGINS is not set; any website can use this relay to reach Artix servers");
}

const sockets = createSocketDirectory();

function json(body: unknown, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function proxyHttp(req: Request, url: URL, cors: Record<string, string>) {
  const target = parseProxyPath(url.pathname, url.search)!;
  if (!target.allowed) return new Response("Host not allowed", { status: 403, headers: cors });

  const headers = upstreamRequestHeaders(target.host, (name: string) => req.headers.get(name));
  delete headers.host;
  delete headers["content-length"];

  let upstream: Response;
  try {
    upstream = await fetch(`https://${target.host}${target.path}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return new Response(`Upstream failed: ${(error as Error).message}`, { status: 502, headers: cors });
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (DROPPED_RESPONSE_HEADERS.has(key) || key === "set-cookie") return;
    if (key === "content-encoding" || key === "content-length") return;
    out.set(key, key === "location" ? rewriteLocation(value, target.host, url.origin) : value);
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    out.append("set-cookie", rewriteSetCookie(cookie, url.protocol === "https:"));
  }
  for (const [key, value] of Object.entries(cors)) out.set(key, value);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function bridgeSocket(req: Request, host: string, port: number) {
  const { socket: ws, response } = Deno.upgradeWebSocket(req);
  ws.binaryType = "arraybuffer";
  const encoder = new TextEncoder();
  const queued: Uint8Array[] = [];
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let tcp: Deno.TcpConn | null = null;
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    try {
      tcp?.close();
    } catch {
      // already closed
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };

  ws.onmessage = (event) => {
    const data = typeof event.data === "string" ? encoder.encode(event.data) : new Uint8Array(event.data);
    if (writer) writer.write(data).catch(closeBoth);
    else queued.push(data);
  };
  ws.onclose = closeBoth;
  ws.onerror = closeBoth;
  ws.onopen = async () => {
    try {
      tcp = await Deno.connect({ hostname: host, port, transport: "tcp" });
      tcp.setNoDelay(true);
      tcp.setKeepAlive(true);
      writer = tcp.writable.getWriter();
      for (const chunk of queued.splice(0)) await writer.write(chunk);
      console.log(`socket open ${host}:${port}`);
      for await (const chunk of tcp.readable) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(chunk);
      }
    } catch (error) {
      console.warn(`socket ${host}:${port} ${(error as Error).message}`);
    } finally {
      console.log(`socket closed ${host}:${port}`);
      closeBoth();
    }
  };
  return response;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin, ALLOWED_ORIGINS);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: originAllowed(origin, ALLOWED_ORIGINS) ? 204 : 403, headers: cors });
  }
  if (!originAllowed(origin, ALLOWED_ORIGINS)) {
    return new Response("Origin not allowed", { status: 403 });
  }
  if (url.pathname === "/socket") {
    const host = (url.searchParams.get("host") || "").toLowerCase();
    const port = Number(url.searchParams.get("port"));
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    if (!(await sockets.allows(host, port))) {
      return new Response("Socket not allowed", { status: 403 });
    }
    return bridgeSocket(req, host, port);
  }
  if (url.pathname === "/api/sockets") return json(await sockets.list(), cors);
  if (url.pathname.startsWith("/proxy/")) return proxyHttp(req, url, cors);
  return new Response("AQW relay is running", { headers: { "content-type": "text/plain; charset=utf-8", ...cors } });
});
