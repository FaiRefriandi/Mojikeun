// Main-thread side of the Moji Studio engine: downloads the ONNX models
// (local /models first, Hugging Face CDN fallback), starts the Web Worker,
// and exposes generate() with per-step progress.
//
// The worker (public/moji/worker.js) loads onnxruntime-web 1.22.0 from the
// vendored copy in public/ort/, installed from the onnxruntime-web npm
// package by scripts/copy-ort.mjs. The original Space loads the same file
// from the jsDelivr CDN instead.

import { BAD_OUTPUT } from "./pixels";

export type LoadStage = "download" | "load" | "check";
export type Progress = { stage: LoadStage; loaded: number; total: number };
export type SelfTestResult = { agreement: number; meanTopDiff: number; failure: string | null };

const CDN_BASE =
  "https://huggingface.co/Morphkite/Mojikeun/resolve/main/";
const CACHE = "moji-studio-v1";
const FORCE_CPU_KEY = "moji-studio:force-cpu";
const LOADING_KEY = "moji-studio:loading";
const STEP_MS = 45; // show every diffusion step long enough to see the pixels fill in

export const FILES = [
  { key: "den", path: "models/tessera_w8.onnx", bytes: 50840032 },
  { key: "clip", path: "models/clip_text_w8.onnx", bytes: 64060515 },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(CACHE);
  } catch {
    return null;
  }
}

async function fetchJson(path: string): Promise<unknown> {
  const local = await fetch(`/${path}`);
  if (local.ok) return local.json();
  const remote = await fetch(CDN_BASE + path.split("/").pop());
  if (!remote.ok) throw new Error(`Couldn't download ${path} (HTTP ${remote.status})`);
  return remote.json();
}

/**
 * Download one model file into a buffer of its known size. Tries the local
 * /models copy first, then the Hugging Face CDN copy when local is missing.
 */
async function fetchBytes(
  file: (typeof FILES)[number],
  onBytes: (n: number) => void,
): Promise<ArrayBuffer> {
  const cache = await openCache();
  const localPath = `/${file.path}`;
  if (cache) {
    try {
      const hit = await cache.match(localPath);
      if (hit) {
        const buf = await hit.arrayBuffer();
        if (buf.byteLength === file.bytes) {
          onBytes(buf.byteLength);
          return buf;
        }
        await cache.delete(localPath);
      }
    } catch {
      // A broken cache entry is not fatal; download again.
    }
  }

  let res = await fetch(localPath);
  let url = localPath;
  if (!res.ok) {
    res = await fetch(CDN_BASE + file.path.split("/").pop());
    url = CDN_BASE + file.path.split("/").pop();
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${file.path} (HTTP ${res.status})`);
  }
  if (!res.body) throw new Error(`Couldn't download ${file.path} (empty response)`);

  const saved = cache
    ? cache.put(url, res.clone()).catch(() => cache.delete(url).catch(() => {}))
    : null;
  const out = new Uint8Array(file.bytes);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.byteLength > out.length)
      throw new Error(`${file.path} is bigger than expected. Reload the page to try again.`);
    out.set(value, got);
    got += value.byteLength;
    onBytes(got);
  }
  if (got !== out.length)
    throw new Error(`The download of ${file.path} stopped early (${got} of ${out.length} bytes). Reload to try again.`);
  await saved;
  return out.buffer;
}

function shouldForceCpu(): boolean {
  if (new URLSearchParams(location.search).has("cpu")) return true;
  try {
    return localStorage.getItem(FORCE_CPU_KEY) === "1";
  } catch {
    return false;
  }
}

function setLoadingMarker(on: boolean) {
  try {
    if (on) localStorage.setItem(LOADING_KEY, "1");
    else localStorage.removeItem(LOADING_KEY);
  } catch {
    // Storage blocked: we just can't detect a crash on the next visit.
  }
}

/** True if the last visit was killed while loading the model. */
export function crashedLastTime(): boolean {
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

/**
 * Download the models, start the worker, and resolve once it is ready.
 * onProgress gets { stage, loaded, total }.
 */
export async function loadEngine(onProgress?: (p: Progress) => void): Promise<MojiClient> {
  const [tokJson, meta, selfTest] = await Promise.all([
    fetchJson("models/tokenizer.json"),
    fetchJson("models/meta.json"),
    fetchJson("models/selftest.json"),
  ]);
  const total = FILES.reduce((s, f) => s + f.bytes, 0);
  const seen: Record<string, number> = Object.fromEntries(FILES.map((f) => [f.key, 0]));
  const [den, clip] = await Promise.all(
    FILES.map((f) =>
      fetchBytes(f, (n) => {
        seen[f.key] = n;
        onProgress?.({ stage: "download", loaded: Object.values(seen).reduce((a, b) => a + b, 0), total });
      }),
    ),
  );
  const palette = new Uint8ClampedArray(512 * 4);
  (meta as { palette_rgba: number[][] }).palette_rgba.forEach((c, i) => palette.set(c, i * 4));

  const worker = new Worker("/moji/worker.js", { type: "module" });
  const started = new Promise<{ device: string; fallbackReason: string | null; selfTest: SelfTestResult }>(
    (resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.type === "stage")
          onProgress?.({ stage: e.data.stage as LoadStage, loaded: total, total });
        else if (e.data.type === "ready") resolve(e.data);
        else if (e.data.type === "error") reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || "The model worker failed to start"));
      worker.postMessage(
        { type: "init", bytes: { den, clip }, tokJson, palette, selfTest, forceCpu: shouldForceCpu() },
        [den, clip],
      );
    },
  );
  setLoadingMarker(true);
  let ready: { device: string; fallbackReason: string | null; selfTest: SelfTestResult };
  try {
    ready = await started;
  } finally {
    setLoadingMarker(false);
  }
  if (ready.fallbackReason === "gpu-bad-output") rememberForceCpu();
  return new MojiClient(worker, palette, ready.device, ready.fallbackReason, ready.selfTest);
}

export class MojiClient {
  readonly device: string;
  readonly fallbackReason: string | null;
  readonly selfTest: SelfTestResult;
  readonly palette: Uint8ClampedArray;
  private worker: Worker;
  private nextId = 1;

  constructor(
    worker: Worker,
    palette: Uint8ClampedArray,
    device: string,
    fallbackReason: string | null,
    selfTest: SelfTestResult,
  ) {
    this.worker = worker;
    this.palette = palette;
    this.device = device;
    this.fallbackReason = fallbackReason;
    this.selfTest = selfTest;
  }

  /** Generate n sprites; onStep(step, tokens, masked) is called for every step, paced for display. */
  generate(
    prompt: string,
    { n = 4, seed = 0, onStep }: { n?: number; seed?: number; onStep?: (k: number, x: Int32Array, masked: Uint8Array) => void },
  ): Promise<Int32Array> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let chain = Promise.resolve();
      let step = 0;
      this.worker.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === "step") {
          const k = step++;
          chain = chain.then(async () => {
            const t = performance.now();
            onStep?.(k, m.x as Int32Array, m.masked as Uint8Array);
            await sleep(Math.max(0, STEP_MS - (performance.now() - t)));
          });
        } else if (m.type === "done") chain.then(() => resolve(m.x as Int32Array));
        else if (m.type === "error") {
          if (m.message !== BAD_OUTPUT) return reject(new Error(m.message));
          rememberForceCpu();
          reject(
            new Error(
              "Your GPU returned broken numbers for this model. Reload the page and it will run on your CPU instead.",
            ),
          );
        }
      };
      this.worker.postMessage({ type: "generate", id, prompt, n, seed });
    });
  }
}
