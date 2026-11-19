# Mojikeun

Pixel emoji atelier. Describe an emoji and Mojikeun paints four pixel
versions, right in your browser. Pick one, fix it pixel by pixel, export
a PNG. The size dropdown at the top right switches between 16 by 16
(Tessera-small) and 32 by 32 (Pixelart 50m).

Run it on your own machine, or clone it from GitHub at
`FaiRefriandi/Mojikeun`.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static export into out/
npm start        # serves the export on port 3001 (npx serve out -l 3001 also works)
```

The three ONNX model files (`tessera_w8.onnx`, `clip_text_w8.onnx`,
`pixelart50m_w8.onnx`) are not
in this repo because GitHub file uploads from here cannot carry binaries
that large. They are downloaded automatically from the public Hugging Face
model repo on first run (see the CDN fallback in `src/lib/moji-client.ts`),
or you can place them in `public/models/` yourself from
`huggingface.co/Morphkite/Mojikeun/resolve/main/`. The Pixelart 50m file is
only downloaded when 32 by 32 is picked for the first time.

## How it works

The model is Tessera-small (47.6M params, CC BY-NC 4.0, non commercial demo)
plus the CLIP text encoder (MIT). Both run in the browser through
onnxruntime-web 1.22.0, vendored in `public/ort/` from the npm package by
`scripts/copy-ort.mjs` (runs on postinstall), so the app works fully offline.
The 16 step masked diffusion sampler is ported faithfully
from the Slack Moji Space: CLIP BPE tokeniser, 24 fixed tokens, CFG 3, cosine
schedule, Gumbel choice noise, 3 by 3 spatial NMS, self conditioning.

The 32 by 32 mode uses Pixelart 50m (49.8M params, MIT) by azyg0s, a
flow-matching UNet that draws 32 by 32 RGBA sprites with transparent
backgrounds, quantised to at most 16 colours. It shares the same frozen
CLIP text encoder. Its 30 step Heun sampler (CFG 4, guidance only while
t is in 0.0 to 0.75) is ported from `pixelart/model.py`, and the UNet was
exported to int8 ONNX with `pixelart-50m/export_50m_onnx2.py` in the
Hugging Face model repo (the export uses a manual attention implementation
because `nn.MultiheadAttention` bakes the batch size into the graph).

Model files live in `public/models/` (about 115 MB for the 16 by 16 mode,
plus 138 MB for the 32 by 32 mode, copied from the Space and from
azyg0s/pixelart-50m).
If a local file is missing, the loader falls back to the Hugging Face CDN copy
at `huggingface.co/Morphkite/Mojikeun/resolve/main/`.
Inference runs in a Web Worker (`public/moji/worker.js`) so the UI never
freezes. WebGPU first, WASM CPU fallback, with a one time self test at load
whose result shows in the header.

## Layout

- `src/app/page.tsx` — the whole studio: prompt bar, size dropdown, presets,
  live diffusion progress, four specimens, pixel editor, export.
- `src/lib/moji-client.ts` — model download (Cache API, CDN fallback) and the
  worker client.
- `src/lib/pixels.ts` — palette decode, canvas painting, PNG export, slug.
- `public/moji/engine.js` — the sampler ports (Tessera masked diffusion,
  Pixelart 50m Heun flow).
- `public/moji/flow50m.js` — Pixelart 50m helpers: Gaussian noise,
  median-cut quantisation, RGBA post-processing.
- `public/moji/tokenizer.js` — CLIP BPE tokeniser.
- `public/moji/worker.js` — worker entry point.
- `public/models/` — tessera_w8.onnx, pixelart50m_w8.onnx, clip_text_w8.onnx,
  tokenizer.json, meta.json, selftest.json.
- `reference/` — the research note and the original Space source files.

## Credits

Tessera-small by Jagrat Patel (TheJagStudio), CC BY-NC 4.0. CLIP text encoder
by OpenAI, MIT. Concept after the Slack Moji Space by cfahlgren1
(https://huggingface.co/spaces/cfahlgren1/slack-moji).

All generation runs in your browser. No prompt or image leaves your device.
