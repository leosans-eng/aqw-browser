const GAME_URL = "https://game.aq.com/game/gamefiles/Loader4.swf?ver=b";
const STAGE_WIDTH = 960;
const STAGE_HEIGHT = 550;

const params = new URLSearchParams(location.search);
const config = window.AQW_CONFIG || {};
const relay = (params.get("relay") || config.relay || location.origin).replace(/\/$/, "");
const relaySocket = relay.replace(/^http/, "ws");
const status = document.getElementById("status");

function showError(message) {
  status.innerHTML = "";
  const line = document.createElement("p");
  line.className = "error";
  line.textContent = message;
  status.append(line);
}

function rewriteRules() {
  return [
    [/^https?:\/\/game\.aq\.com\/game\/gamefiles\/(.*)$/i, "https://game.aq.com/game/gamefiles/$1"],
    [
      /^https?:\/\/((?:[a-z0-9-]+\.)*(?:aq\.com|aqworlds\.com|artix\.com|battleon\.com))([/?#].*)?$/i,
      `${relay}/proxy/$1$2`,
    ],
  ];
}

function startHud() {
  const hud = document.createElement("div");
  hud.id = "hud";
  document.body.append(hud);

  const sockets = { open: 0, opened: 0, closed: 0, last: "none" };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const target = new URL(url).searchParams.get("port") || "?";
      this.addEventListener("open", () => {
        sockets.open += 1;
        sockets.opened += 1;
        sockets.last = `open :${target}`;
      });
      this.addEventListener("close", (event) => {
        sockets.open = Math.max(0, sockets.open - 1);
        sockets.closed += 1;
        sockets.last = `closed :${target} (${event.code})`;
      });
    }
  };

  let frames = 0;
  let longTasks = 0;
  let longTaskMs = 0;
  let worstFrame = 0;
  let lastFrame = performance.now();
  let lastReport = lastFrame;

  if ("PerformanceObserver" in window && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks += 1;
        longTaskMs += entry.duration;
      }
    }).observe({ type: "longtask", buffered: false });
  }

  const tick = (now) => {
    frames += 1;
    worstFrame = Math.max(worstFrame, now - lastFrame);
    lastFrame = now;
    if (now - lastReport >= 1000) {
      const seconds = (now - lastReport) / 1000;
      const busy = Math.min(100, Math.round((longTaskMs / (seconds * 1000)) * 100));
      hud.textContent = [
        `page fps ${Math.round(frames / seconds)}  worst frame ${Math.round(worstFrame)} ms`,
        `blocked ${busy}%  long tasks ${longTasks}`,
        `world sockets open ${sockets.open}  reconnects ${Math.max(0, sockets.opened - 1)}`,
        `last socket ${sockets.last}`,
        `renderer ${window.AQW_RENDERER || "?"}  quality ${options.quality}`,
      ].join("\n");
      frames = 0;
      longTasks = 0;
      longTaskMs = 0;
      worstFrame = 0;
      lastReport = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const nativeLog = console.log;
  console.log = (...args) => {
    const text = args.map(String).join(" ");
    const match = text.match(/Used renderer: ([\w-]+)/);
    if (match) window.AQW_RENDERER = match[1];
    nativeLog(...args);
  };
}

const options = {
  url: GAME_URL,
  autoplay: "on",
  unmuteOverlay: "hidden",
  splashScreen: false,
  allowNetworking: "all",
  allowFullscreen: true,
  letterbox: "fullscreen",
  scale: "showAll",
  quality: params.get("quality") || "low",
  menu: false,
  base: "https://game.aq.com/game/gamefiles/",
  parameters: { sLang: "", isweb: "true" },
  urlRewriteRules: rewriteRules(),
  logLevel: "warn",
  maxExecutionDuration: 20,
  credentialAllowList: [relay],
};
if (params.get("renderer")) options.preferredRenderer = params.get("renderer");
if (params.get("fps")) options.frameRate = Number(params.get("fps"));

function fitToWindow(game) {
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
  game.style.transform = `translate(-50%, -50%) scale(${scale})`;
}

async function start() {
  if (!window.RufflePlayer) {
    showError("Ruffle did not load. Run npm install and start the server again.");
    return;
  }
  if (params.has("hud")) startHud();

  let socketProxy;
  try {
    const response = await fetch(`${relay}/api/sockets`);
    if (!response.ok) throw new Error(`the relay answered ${response.status}`);
    const targets = await response.json();
    socketProxy = targets.map(({ host, port }) => ({
      host,
      port,
      proxyUrl: `${relaySocket}/socket?host=${encodeURIComponent(host)}&port=${port}`,
    }));
  } catch (error) {
    showError(`Could not reach the game relay at ${relay}. ${error.message}`);
    return;
  }

  options.socketProxy = socketProxy;
  window.RufflePlayer.config = { ...options, polyfills: false };

  const game = document.getElementById("game");
  fitToWindow(game);
  window.addEventListener("resize", () => fitToWindow(game));

  const player = window.RufflePlayer.newest().createPlayer();
  game.appendChild(player);
  try {
    await player.load(options);
    status.remove();
  } catch (error) {
    showError(`The game client did not start. ${error.message || error}`);
  }
}

start();
