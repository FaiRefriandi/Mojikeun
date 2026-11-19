// CDP driver for the 32x32 mode: loads the page, switches the size dropdown
// to 32x32, waits for the Pixelart 50m model, generates once, screenshots,
// and checks the result pixels (opaque, at most 16 colours) and overflow.
// Usage: node verify/drive50m.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const SHOTS = `${ROOT}verify/shots`;
mkdirSync(SHOTS, { recursive: true });
const CHROME = "/tmp/chrome-nosandbox.sh";
const PORT = 3001;
const DEBUG_PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", `${ROOT}out`], { stdio: "ignore" });
await sleep(1500);

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--user-data-dir=/tmp/moji-verify50m-profile",
  "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(1000);
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const j = await res.json();
    wsUrl = j.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
if (!wsUrl) { console.log("FAIL: chrome did not start"); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const pageWs = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { pageWs.onopen = res; pageWs.onerror = rej; });
const pid2 = new Map();
let id2 = 0;
const consoleErrs = [];
pageWs.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pid2.has(m.id)) { pid2.get(m.id)(m); pid2.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") consoleErrs.push("EXC: " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrs.push("CONSOLE: " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
};
const psend = (method, params = {}) => new Promise((res) => {
  const mid = ++id2;
  pid2.set(mid, res);
  pageWs.send(JSON.stringify({ id: mid, method, params }));
});
const peval = async (expr) => {
  const r = await psend("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await psend("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${SHOTS}/${name}`, Buffer.from(r.result.data, "base64"));
  console.log("saved", name);
};

await psend("Page.enable");
await psend("Runtime.enable");
await psend("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await psend("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });

console.log("waiting for 16x16 model load...");
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(5000);
  ready = await peval(`!document.body.innerText.includes('Loading model') && !document.querySelector('button[type=submit]').disabled`);
}
console.log("16x16 ready:", ready);
if (!ready) { console.log("FAIL: model did not load in 5 min"); process.exit(1); }

// Switch to 32x32
await peval(`(() => { const s = document.querySelector('#moji-size'); s.value = '32'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
console.log("waiting for 32x32 model load...");
let ready50 = false;
for (let i = 0; i < 60 && !ready50; i++) {
  await sleep(5000);
  ready50 = await peval(`!document.body.innerText.includes('Loading model') && !document.querySelector('button[type=submit]').disabled`);
  if (i % 6 === 5) console.log("  still loading 32x32...", await peval(`document.body.innerText.slice(0, 120)`).catch(() => "?"));
}
console.log("32x32 ready:", ready50);
if (!ready50) { console.log("FAIL: 32x32 model did not load in 5 min"); process.exit(1); }
console.log("dropdown value:", await peval(`document.querySelector('#moji-size').value`));

// Generate
await peval(`document.querySelector('button[type=submit]').click()`);
console.log("generating 32x32...");
let done = false;
let saw30 = false;
for (let i = 0; i < 120 && !done; i++) {
  await sleep(5000);
  const st = await peval(`(document.querySelector('[role=status]')||{}).innerText || ''`).catch(() => "");
  if (st.includes("of 30")) saw30 = true;
  done = await peval(`document.querySelector('button[type=submit]').textContent.trim() === 'Generate'`);
  if (i % 6 === 5) console.log("  still painting...", st);
}
console.log("generated:", done, "| saw 'step N of 30':", saw30);
if (!done) { console.log("FAIL: generation did not finish in 10 min"); process.exit(1); }
await sleep(500);
await shot("1440-32-filled.png");

// Check the preview pixels: opaque count and distinct colours (<= 16 expected)
const px = await peval(`(() => {
  const cs = [...document.querySelectorAll('canvas')].sort((a, b) => b.width - a.width);
  const c = cs[0];
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  const colours = new Set();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) {
      opaque++;
      colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
  }
  return { canvas: c.width, opaque, colours: colours.size };
})()`);
console.log("preview pixels:", JSON.stringify(px));
console.log("overflow 1440:", await peval(`document.documentElement.scrollWidth + ' vs ' + window.innerWidth`));
console.log("console errors:", consoleErrs.length ? consoleErrs.join(" | ") : "none");

// Phone size
await psend("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(800);
await shot("390-32-filled.png");
console.log("overflow 390:", await peval(`document.documentElement.scrollWidth + ' vs ' + window.innerWidth`));

ws.close(); pageWs.close();
chrome.kill("SIGKILL"); server.kill("SIGKILL");
console.log("DONE");
process.exit(0);
