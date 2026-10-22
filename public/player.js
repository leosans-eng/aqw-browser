const GAME_URL = "https://game.aq.com/game/gamefiles/Loader4.swf?ver=b";
const status = document.getElementById("status");

function showError(message) {
  status.innerHTML = `<p class="error">${message}</p>`;
}

function rewriteRules() {
  return [
    [
      /^https?:\/\/((?:[a-z0-9-]+\.)*(?:aq\.com|aqworlds\.com|artix\.com|battleon\.com))([/?#].*)?$/i,
      `${location.origin}/proxy/$1$2`,
    ],
  ];
}

async function start() {
  if (!window.RufflePlayer) {
    showError("Ruffle did not load. Stop the server and run npm install, then start it again.");
    return;
  }

  let socketProxy;
  try {
    const response = await fetch("/api/socket-proxies");
    if (!response.ok) throw new Error(`socket list returned ${response.status}`);
    socketProxy = await response.json();
  } catch (error) {
    showError(`Could not load the Artix server list. ${error.message}`);
    return;
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
    quality: "low",
    menu: false,
    base: "https://game.aq.com/game/gamefiles/",
    parameters: {
      sLang: "",
      isweb: "true",
    },
    urlRewriteRules: rewriteRules(),
    socketProxy,
    logLevel: "warn",
    maxExecutionDuration: 20,
    credentialAllowList: [location.origin, "https://game.aq.com", "https://www.aq.com"],
  };
  window.RufflePlayer.config = { ...options, polyfills: false };
  const game = document.getElementById("game");
  const fit = () => {
    const scale = Math.min(window.innerWidth / 960, window.innerHeight / 550);
    game.style.transform = `translate(-50%, -50%) scale(${scale})`;
  };
  fit();
  window.addEventListener("resize", fit);
  const ruffle = window.RufflePlayer.newest();
  const player = ruffle.createPlayer();
  document.getElementById("game").appendChild(player);

  try {
    await player.load(options);
    status.remove();
  } catch (error) {
    showError(`The game client did not start. ${error.message || error}`);
  }
}

start();
