// Runs the model off the main thread so the page never freezes, on GPU or CPU.
import { createEngine } from "./engine.js";

let engine = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      engine = await createEngine(m.bytes, m.tokJson, m.palette, m.selfTest, {
        forceCpu: m.forceCpu,
        onStage: (stage) => self.postMessage({ type: "stage", stage }),
      });
      self.postMessage({
        type: "ready",
        device: engine.device,
        fallbackReason: engine.fallbackReason,
        selfTest: engine.selfTest,
      });
      return;
    }
    if (m.type === "init50") {
      await engine.load50m(m.bytes);
      self.postMessage({ type: "ready50", device: engine.device });
      return;
    }
    if (m.type === "generate50") {
      const frames = await engine.generate50m(m.prompt, {
        n: m.n,
        seed: m.seed,
        onStep: (_k, frames) => self.postMessage({ type: "step50", id: m.id, frames }),
      });
      self.postMessage({ type: "done50", id: m.id, frames });
    }
    if (m.type === "generate") {
      const x = await engine.generate(m.prompt, {
        n: m.n,
        seed: m.seed,
        onStep: (_k, x, masked) => self.postMessage({ type: "step", id: m.id, x: x.slice(), masked: masked.slice() }),
      });
      self.postMessage({ type: "done", id: m.id, x: x.slice() });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err?.message ?? err) });
  }
};
