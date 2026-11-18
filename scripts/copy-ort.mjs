// Copy the onnxruntime-web runtime files the worker loads into public/ort/,
// so the app is fully self contained and never needs the jsDelivr CDN.
// Files: the WebGPU bundle, the two wasm binaries it fetches at runtime
// (jsep for WebGPU, plain threaded for the CPU fallback), and their loaders.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "node_modules", "onnxruntime-web", "dist");
const out = join(root, "public", "ort");
mkdirSync(out, { recursive: true });

const FILES = [
  "ort.webgpu.min.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
];

for (const f of FILES) {
  copyFileSync(join(dist, f), join(out, f));
  console.log("copied", f);
}
