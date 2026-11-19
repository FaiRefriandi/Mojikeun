// Pixel helpers for 16x16 Tessera sprites. Token 0 is transparent.

export const GRID = 16;
export const N = GRID * GRID;
export const K = 512;
export const MASK = 512;
/** Error message the engine throws when a run returns NaN or infinite logits. */
export const BAD_OUTPUT = "bad-model-output";

const MASK_COLOR: [number, number, number, number] = [220, 220, 225, 255];

/** RGBA pixels for one sprite. Masked pixels get the pale mask colour. */
export function tokensToRGBA(
  tokens: Int32Array | number[],
  palette: Uint8ClampedArray,
  masked?: Uint8Array | null,
): Uint8ClampedArray {
  const px = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    if (masked && masked[i]) {
      px.set(MASK_COLOR, i * 4);
    } else {
      const t = tokens[i];
      px.set(palette.subarray(t * 4, t * 4 + 4), i * 4);
    }
  }
  return px;
}

/** Paint RGBA pixels onto a square canvas, crisp, one fillRect per pixel. */
export function paintRGBA(canvas: HTMLCanvasElement, rgba: Uint8ClampedArray, grid = GRID) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = canvas.width;
  const s = size / grid;
  const n = grid * grid;
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    if (!a) continue;
    ctx.fillStyle = `rgba(${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]},${a / 255})`;
    ctx.fillRect((i % grid) * s, Math.floor(i / grid) * s, Math.ceil(s), Math.ceil(s));
  }
}

/** PNG blob of an RGBA sprite, upscaled to `size` px with no smoothing. */
export function pngBlobFromRGBA(rgba: Uint8ClampedArray, grid: number, size = 256): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paintRGBA(c, rgba, grid);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"),
  );
}

export function rgbaToDataURL(rgba: Uint8ClampedArray, grid: number, size = 256): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paintRGBA(c, rgba, grid);
  return c.toDataURL("image/png");
}

/** Distinct opaque colours in an RGBA sprite, in first-seen order. */
export function uniqueColors(rgba: Uint8ClampedArray, max = 16): [number, number, number, number][] {
  const seen = new Set<number>();
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < rgba.length / 4; i++) {
    const a = rgba[i * 4 + 3];
    if (!a) continue;
    const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], 255]);
    if (out.length >= max) break;
  }
  return out;
}

export function paintTokens(
  canvas: HTMLCanvasElement,
  tokens: Int32Array | number[],
  palette: Uint8ClampedArray,
  masked?: Uint8Array | null,
) {
  paintRGBA(canvas, tokensToRGBA(tokens, palette, masked));
}

/** PNG blob of a sprite, upscaled to `size` px with no smoothing. */
export function pngBlob(
  tokens: Int32Array | number[],
  palette: Uint8ClampedArray,
  size = 128,
): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paintTokens(c, tokens, palette);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"),
  );
}

export function tokensToDataURL(
  tokens: Int32Array | number[],
  palette: Uint8ClampedArray,
  size = 128,
): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paintTokens(c, tokens, palette);
  return c.toDataURL("image/png");
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "emoji"
  );
}

/** Palette index whose colour is closest to the given RGB. */
export function nearestPaletteIndex(palette: Uint8ClampedArray, r: number, g: number, b: number): number {
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < K; i++) {
    const dr = palette[i * 4] - r;
    const dg = palette[i * 4 + 1] - g;
    const db = palette[i * 4 + 2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
