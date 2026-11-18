// Main-thread side: downloads (with progress and the Cache API), the worker, and pixels.
import { BAD_OUTPUT } from "./engine.js";

export const GRID = 16;
export const N = GRID * GRID;
const K = 512;
const CACHE = "tessera-small-v3";
const FORCE_CPU_KEY = "slack-moji:force-cpu";
// Set while the model loads into memory, cleared once it is ready. If it is still set on the next
// visit, the browser killed the tab mid-load, almost always because it ran out of memory.
const LOADING_KEY = "slack-moji:loading";
const STEP_MS = 45; // show every step long enough to see the pixels fill in

export const FILES = [
  { key: "den", path: "models/tessera_w8.onnx", bytes: 50840032 },
  { key: "clip", path: "models/clip_text_w8.onnx", bytes: 64060515 },
];

/** Private static Spaces authenticate same-origin files with the page's __sign token. */
function signed(url) {
  const sign = new URLSearchParams(location.search).get("__sign");
  if (!sign) return url;
  return url + (url.includes("?") ? "&" : "?") + "__sign=" + encodeURIComponent(sign);
}

async function openCache() {
  try {
    return await caches.open(CACHE);
  } catch {
    return null;
  }
}

/** Drop caches from older versions of the models so they don't keep using the phone's storage. */
async function deleteOldCaches() {
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("tessera-small-") && n !== CACHE).map((n) => caches.delete(n)));
  } catch {
    // No Cache API (private mode, some webviews): nothing to clean up.
  }
}

/**
 * Download one model into a single buffer of its known size. Phones have little memory, so
 * the bytes are never held twice: no chunk list plus a joined copy, and the cache is fed from
 * a clone of the stream instead of a copy of the finished buffer.
 */
async function fetchBytes(file, onBytes) {
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(file.path);
      if (hit) {
        const buf = await hit.arrayBuffer();
        if (buf.byteLength === file.bytes) {
          onBytes(buf.byteLength);
          return buf;
        }
        // A tab killed mid-write can leave a truncated entry; download it again.
        await cache.delete(file.path);
      }
    } catch {
      // A broken cache entry is not fatal; download again.
    }
  }
  const res = await fetch(signed(file.path));
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${file.path} (HTTP ${res.status})`);
  // Out of quota or private mode: skip caching, but never keep a partial entry.
  const saved = cache ? cache.put(file.path, res.clone()).catch(() => cache.delete(file.path).catch(() => {})) : null;
  const out = new Uint8Array(file.bytes);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.byteLength > out.length) throw new Error(`${file.path} is bigger than expected. Reload the page to get the latest version.`);
    out.set(value, got);
    got += value.byteLength;
    onBytes(got);
  }
  if (got !== out.length) throw new Error(`The download of ${file.path} stopped early (${got} of ${out.length} bytes). Reload to try again.`);
  await saved;
  return out.buffer;
}

function shouldForceCpu() {
  if (new URLSearchParams(location.search).has("cpu")) return true;
  try {
    return localStorage.getItem(FORCE_CPU_KEY) === "1";
  } catch {
    return false;
  }
}

function setLoadingMarker(on) {
  try {
    if (on) localStorage.setItem(LOADING_KEY, "1");
    else localStorage.removeItem(LOADING_KEY);
  } catch {
    // Storage blocked: we just can't detect a crash on the next visit.
  }
}

/** True if the last visit was killed while loading the model, so we shouldn't retry on our own. */
export function crashedLastTime() {
  try {
    return localStorage.getItem(LOADING_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberForceCpu() {
  try {
    localStorage.setItem(FORCE_CPU_KEY, "1");
  } catch {
    // Storage blocked: the user can still add ?cpu to the URL.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download the models, start the worker, and resolve once it's ready. onProgress gets
 * { stage, loaded, total } where stage is "download", "load" (into memory) or "check" (GPU test).
 */
export async function loadEngine(onProgress) {
  deleteOldCaches();
  const [tokJson, meta, selfTest] = await Promise.all([
    fetch(signed("models/tokenizer.json")).then((r) => r.json()),
    fetch(signed("models/meta.json")).then((r) => r.json()),
    fetch(signed("models/selftest.json")).then((r) => r.json()),
  ]);
  const total = FILES.reduce((s, f) => s + f.bytes, 0);
  const seen = Object.fromEntries(FILES.map((f) => [f.key, 0]));
  const [den, clip] = await Promise.all(
    FILES.map((f) =>
      fetchBytes(f, (n) => {
        seen[f.key] = n;
        onProgress?.({ stage: "download", loaded: Object.values(seen).reduce((a, b) => a + b, 0), total });
      }),
    ),
  );
  const palette = new Uint8ClampedArray(K * 4);
  meta.palette_rgba.forEach((c, i) => palette.set(c, i * 4));

  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const started = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.type === "stage") onProgress?.({ stage: e.data.stage, loaded: total, total });
      else if (e.data.type === "ready") resolve(e.data);
      else if (e.data.type === "error") reject(new Error(e.data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || "The model worker failed to start"));
    worker.postMessage({ type: "init", bytes: { den, clip }, tokJson, palette, selfTest, forceCpu: shouldForceCpu() }, [den, clip]);
  });
  // Only a killed tab leaves the marker behind: a normal error still clears it.
  setLoadingMarker(true);
  let device, fallbackReason;
  try {
    ({ device, fallbackReason } = await started);
  } finally {
    setLoadingMarker(false);
  }
  if (fallbackReason === "gpu-bad-output") rememberForceCpu();
  return new Client(worker, palette, device, fallbackReason);
}

class Client {
  constructor(worker, palette, device, fallbackReason) {
    this.worker = worker;
    this.palette = palette;
    this.device = device;
    this.fallbackReason = fallbackReason;
    this.nextId = 1;
  }

  /** Generate n sprites; onStep(step, tokens, masked) is called for every step, paced for display. */
  generate(prompt, { n = 4, seed = 0, onStep } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let chain = Promise.resolve();
      let step = 0;
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === "step") {
          const k = step++;
          chain = chain.then(async () => {
            const t = performance.now();
            await onStep?.(k, m.x, m.masked);
            await sleep(Math.max(0, STEP_MS - (performance.now() - t)));
          });
        } else if (m.type === "done") chain.then(() => resolve(m.x));
        else if (m.type === "error") {
          if (m.message !== BAD_OUTPUT) return reject(new Error(m.message));
          rememberForceCpu();
          reject(new Error("Your GPU returned broken numbers for this model. Reload the page and it will run on your CPU instead."));
        }
      };
      this.worker.postMessage({ type: "generate", id, prompt, n, seed });
    });
  }

  /** RGBA pixels for sprite b. Masked pixels get `maskColor`; token 0 is transparent. */
  toRGBA(x, masked, b, maskColor = [220, 220, 225, 255]) {
    const px = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      if (masked && masked[b * N + i]) px.set(maskColor, i * 4);
      else px.set(this.palette.subarray(x[b * N + i] * 4, x[b * N + i] * 4 + 4), i * 4);
    }
    return px;
  }
}
