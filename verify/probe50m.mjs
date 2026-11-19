// Probe: what happens on the 32x32 switch. Logs status/error text and console
// output every 5 s for up to 3 min. Usage: node verify/probe50m.mjs
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const CHROME = "/tmp/chrome-nosandbox.sh";
const PORT = 3001;
const DEBUG_PORT = 9224;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", `${ROOT}out`], { stdio: "ignore" });
await sleep(1500);

// Sanity: can the server serve the 50m file?
const head = await fetch(`http://127.0.0.1:${PORT}/models/pixelart50m_w8.onnx`, { method: "HEAD" });
console.log("HEAD pixelart50m_w8.onnx:", head.status, "len:", head.headers.get("content-length"));

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--user-data-dir=/tmp/moji-probe50m-profile",
  "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(1000);
  try {
    const j = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    wsUrl = j.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
if (!wsUrl) { console.log("FAIL: chrome did not start"); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const pageWs = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { pageWs.onopen = res; pageWs.onerror = rej; });
const pid2 = new Map();
let id2 = 0;
const logs = [];
pageWs.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pid2.has(m.id)) { pid2.get(m.id)(m); pid2.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") logs.push("EXC: " + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.type.toUpperCase() + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400));
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
await psend("Page.enable");
await psend("Runtime.enable");
await psend("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await psend("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(5000);
  ready = await peval(`!document.body.innerText.includes('Loading model') && !document.querySelector('button[type=submit]').disabled`);
}
console.log("16x16 ready:", ready);
if (!ready) process.exit(1);

await peval(`(() => { const s = document.querySelector('#moji-size'); s.value = '32'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
for (let i = 0; i < 36; i++) {
  await sleep(5000);
  const txt = await peval(`document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 400)`).catch(() => "?");
  console.log(`t+${(i + 1) * 5}s:`, txt);
  if (logs.length) { console.log("  logs:", logs.splice(0, logs.length).join(" || ")); }
  const done = await peval(`!document.body.innerText.includes('Loading model') && !document.querySelector('button[type=submit]').disabled`).catch(() => false);
  if (done) { console.log("32x32 ready at t+", (i + 1) * 5, "s"); break; }
}
if (logs.length) console.log("logs:", logs.join(" || "));
ws.close(); pageWs.close();
chrome.kill("SIGKILL"); server.kill("SIGKILL");
console.log("DONE");
process.exit(0);
