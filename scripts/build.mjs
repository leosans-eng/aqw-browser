import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const ruffle = path.join(root, "node_modules", "@ruffle-rs", "ruffle");
const relay = (process.env.RELAY_URL || "").trim().replace(/\/$/, "");

if (!fs.existsSync(path.join(ruffle, "ruffle.js"))) {
  console.error("Ruffle is not installed. Run: npm install");
  process.exit(1);
}
if (relay && !/^https?:\/\//.test(relay)) {
  console.error(`RELAY_URL must start with http:// or https:// (got "${relay}")`);
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), dist, { recursive: true });
fs.mkdirSync(path.join(dist, "vendor"));
for (const file of fs.readdirSync(ruffle)) {
  if (/\.(js|wasm)$/.test(file)) fs.copyFileSync(path.join(ruffle, file), path.join(dist, "vendor", file));
}
fs.writeFileSync(path.join(dist, "config.js"), `window.AQW_CONFIG = ${JSON.stringify({ relay }, null, 2)};\n`);
fs.writeFileSync(path.join(dist, ".nojekyll"), "");

console.log(`Built ${path.relative(root, dist)} with relay ${relay || "(same origin)"}`);
