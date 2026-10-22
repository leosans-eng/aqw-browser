const GAME_URL = "https://game.aq.com/game/gamefiles/Loader4.swf?ver=b";
const SETTINGS_KEY = "aqw-settings";
const RESOLUTIONS = {
  960: { width: 960, height: 550 },
  75: { width: 720, height: 412 },
  50: { width: 480, height: 275 },
};
// Ruffle's "webgl" and "canvas" backends lack BitmapData.draw, which AQW needs to build characters.
const RENDERERS = ["auto", "webgpu", "wgpu-webgl"];

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    saved = {};
  }
  const requested = params.get("resolution") || saved.resolution || "window";
  const renderer = params.get("renderer") || saved.renderer || "auto";
  return {
    hud: params.has("hud") || Boolean(saved.hud),
    resolution: requested === "window" || RESOLUTIONS[requested] ? requested : "window",
    renderer: RENDERERS.includes(renderer) ? renderer : "auto",
  };
}

function saveSettings(next) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

const params = new URLSearchParams(location.search);
const config = window.AQW_CONFIG || {};
const relay = (params.get("relay") || config.relay || location.origin).replace(/\/$/, "");
const relaySocket = relay.replace(/^http/, "ws");
const status = document.getElementById("status");
const settings = loadSettings();

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

function installHud() {
  const hud = document.createElement("div");
  hud.id = "hud";
  hud.hidden = !settings.hud;
  document.body.append(hud);

  const sockets = { open: 0, opened: 0, closed: 0, last: "none" };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const target = new URL(url, location.href).searchParams.get("port") || "?";
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

  const nativeLog = console.log;
  console.log = (...args) => {
    const text = args.map(String).join(" ");
    const match = text.match(/Used renderer: ([\w-]+)/);
    if (match) window.AQW_RENDERER = match[1];
    nativeLog(...args);
  };

  const tick = (now) => {
    frames += 1;
    worstFrame = Math.max(worstFrame, now - lastFrame);
    lastFrame = now;
    if (!hud.hidden && now - lastReport >= 1000) {
      const seconds = (now - lastReport) / 1000;
      const canvas = document.querySelector("ruffle-player")?.shadowRoot?.querySelector("canvas");
      const drawn = canvas
        ? `${Math.round(canvas.width / devicePixelRatio)}×${Math.round(canvas.height / devicePixelRatio)}`
        : "…";
      const busy = Math.min(100, Math.round((longTaskMs / (seconds * 1000)) * 100));
      hud.textContent = [
        `page fps ${Math.round(frames / seconds)}  worst frame ${Math.round(worstFrame)} ms`,
        `blocked ${busy}%  long tasks ${longTasks}`,
        `world sockets open ${sockets.open}  reconnects ${Math.max(0, sockets.opened - 1)}`,
        `last socket ${sockets.last}`,
        `renderer ${window.AQW_RENDERER || "?"}  drawn ${drawn}`,
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
  return hud;
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
  quality: "high",
  menu: false,
  base: "https://game.aq.com/game/gamefiles/",
  parameters: { sLang: "", isweb: "true" },
  urlRewriteRules: rewriteRules(),
  logLevel: "warn",
  maxExecutionDuration: 20,
  credentialAllowList: [relay],
};
if (settings.renderer !== "auto") options.preferredRenderer = settings.renderer;
if (params.get("fps")) options.frameRate = Number(params.get("fps"));

function fitToWindow(game) {
  const player = game.querySelector("ruffle-player");
  if (settings.resolution === "window") {
    game.style.left = "0";
    game.style.top = "0";
    game.style.width = "100%";
    game.style.height = "100%";
    game.style.transform = "none";
    if (player) {
      player.style.width = "100%";
      player.style.height = "100%";
    }
    return;
  }
  const { width, height } = RESOLUTIONS[settings.resolution];
  game.style.left = "50%";
  game.style.top = "50%";
  game.style.width = `${width}px`;
  game.style.height = `${height}px`;
  if (player) {
    player.style.width = `${width}px`;
    player.style.height = `${height}px`;
  }
  const scale = Math.min(window.innerWidth / width, window.innerHeight / height);
  game.style.transform = `translate(-50%, -50%) scale(${scale})`;
}

function setupSettings(hud) {
  const button = document.getElementById("settings-button");
  const form = document.getElementById("settings");
  form.elements.hud.checked = settings.hud;
  form.elements.resolution.value = settings.resolution;
  form.elements.renderer.value = settings.renderer;
  button.addEventListener("click", () => {
    form.hidden = !form.hidden;
  });
  document.addEventListener("pointerdown", (event) => {
    if (!form.hidden && !form.contains(event.target) && !button.contains(event.target)) form.hidden = true;
  }, true);
  form.elements.renderer.addEventListener("change", () => {
    settings.renderer = form.elements.renderer.value;
    saveSettings(settings);
    const url = new URL(location.href);
    url.searchParams.delete("renderer");
    location.assign(url);
  });
  form.elements.hud.addEventListener("change", () => {
    settings.hud = form.elements.hud.checked;
    hud.hidden = !settings.hud;
    saveSettings(settings);
  });
  form.elements.resolution.addEventListener("change", () => {
    settings.resolution = form.elements.resolution.value;
    saveSettings(settings);
    fitToWindow(document.getElementById("game"));
  });
  form.addEventListener("submit", (event) => event.preventDefault());
}

async function start() {
  const hud = installHud();
  setupSettings(hud);
  if (!window.RufflePlayer) {
    showError("Ruffle did not load. Run npm install and start the server again.");
    return;
  }

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
  const { stage, ...ruffleOptions } = options;
  window.RufflePlayer.config = { ...ruffleOptions, polyfills: false };

  const game = document.getElementById("game");
  const player = window.RufflePlayer.newest().createPlayer();
  game.appendChild(player);
  fitToWindow(game);
  window.addEventListener("resize", () => fitToWindow(game));
  try {
    await player.load(ruffleOptions);
    status.remove();
  } catch (error) {
    showError(`The game client did not start. ${error.message || error}`);
  }
}

start();
