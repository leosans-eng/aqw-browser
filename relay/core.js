export const SERVERS_API = "https://game.aq.com/game/api/data/servers";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const ALLOWED_SUFFIXES = ["aq.com", "aqworlds.com", "artix.com", "battleon.com"];

const FALLBACK_HOSTS = {
  "sock7.aq.com": [5588, 5589, 5591, 5592, 5593, 5594],
  "sock8.aq.com": [5588, 5589, 5590, 5591, 5593],
  "euro.aqw.artix.com": [5588],
  "asia.game.artix.com": [5588],
};

const POLICY_PORT = 843;

export function hostAllowed(host) {
  const name = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  return ALLOWED_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

export function parseOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function originAllowed(origin, allowed) {
  if (!origin) return true;
  if (!allowed.length) return true;
  return allowed.includes(origin);
}

/** @returns {Record<string, string>} */
export function corsHeaders(origin, allowed) {
  if (!origin || !originAllowed(origin, allowed)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type, accept, x-requested-with",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function parseProxyPath(pathname, search) {
  if (!pathname.startsWith("/proxy/")) return null;
  const rest = decodeURIComponent(pathname.slice("/proxy/".length));
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  if (!hostAllowed(host)) return { host, path: "", allowed: false };
  const path = `${slash === -1 ? "/" : rest.slice(slash)}${search || ""}`;
  return { host, path, allowed: true };
}

/** @returns {Record<string, string>} */
export function upstreamRequestHeaders(host, read) {
  /** @type {Record<string, string>} */
  const headers = {
    host,
    accept: read("accept") || "*/*",
    "accept-language": read("accept-language") || "en-US,en;q=0.9",
    "user-agent": BROWSER_UA,
    referer: "https://game.aq.com/game/",
    origin: "https://game.aq.com",
  };
  for (const name of ["cookie", "content-type", "content-length"]) {
    const value = read(name);
    if (value) headers[name] = value;
  }
  return headers;
}

export function rewriteSetCookie(cookie, secureRelay) {
  let next = cookie
    .replace(/;\s*Domain=[^;]*/gi, "")
    .replace(/;\s*Secure/gi, "")
    .replace(/;\s*SameSite=[^;]*/gi, "");
  next = /;\s*Path=/i.test(next) ? next.replace(/;\s*Path=[^;]*/i, "; Path=/") : `${next}; Path=/`;
  return secureRelay ? `${next}; SameSite=None; Secure` : `${next}; SameSite=Lax`;
}

export function rewriteLocation(value, upstreamHost, relayBase) {
  try {
    const absolute = new URL(value, `https://${upstreamHost}/`);
    if (absolute.protocol !== "https:" && absolute.protocol !== "http:") return value;
    if (!hostAllowed(absolute.hostname)) return value;
    return `${relayBase}/proxy/${absolute.hostname}${absolute.pathname}${absolute.search}`;
  } catch {
    return value;
  }
}

export const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "strict-transport-security",
  "content-security-policy",
  "content-security-policy-report-only",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
]);

export function createSocketDirectory({ ttlMs = 5 * 60 * 1000, log = console } = {}) {
  let targets = null;
  let loadedAt = 0;
  let loading = null;

  function add(map, host, port) {
    const name = String(host || "").trim().toLowerCase();
    const number = Number(port);
    if (!hostAllowed(name) || !Number.isInteger(number) || number < 1 || number > 65535) return;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(number);
    map.get(name).add(POLICY_PORT);
  }

  async function load() {
    const map = new Map();
    for (const [host, ports] of Object.entries(FALLBACK_HOSTS)) {
      for (const port of ports) add(map, host, port);
    }
    try {
      const response = await fetch(SERVERS_API, {
        headers: { accept: "application/json", "user-agent": BROWSER_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`server list returned ${response.status}`);
      const servers = await response.json();
      if (!Array.isArray(servers)) throw new Error("server list was not an array");
      for (const server of servers) add(map, server.sIP, server.iPort);
      log.log(`Artix server list: ${servers.length} worlds, ${map.size} hosts`);
    } catch (error) {
      log.warn(`Artix server list unavailable (${error.message}); using the built-in host list`);
    }
    targets = map;
    loadedAt = Date.now();
    return map;
  }

  async function current() {
    if (targets && Date.now() - loadedAt < ttlMs) return targets;
    if (!loading) loading = load().finally(() => { loading = null; });
    return targets && loading ? targets : loading;
  }

  return {
    async list() {
      const map = await current();
      const entries = [];
      for (const [host, ports] of map) {
        for (const port of ports) entries.push({ host, port });
      }
      return entries;
    },
    async allows(host, port) {
      const map = await current();
      const ports = map.get(String(host || "").toLowerCase());
      return Boolean(ports && ports.has(Number(port)));
    },
  };
}
