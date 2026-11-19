// Pixelart 50m helpers: PRNG, Gaussian noise, and the post-processing that
// turns the UNet's raw [4, 32, 32] output into crisp RGBA pixel art.
//
// The post-processing mirrors pixelart/postprocess.py (to_rgba_u8):
// (x + 1) * 127.5 to uint8, binary alpha at 128, then the opaque pixels are
// quantised to at most 16 colours with a median cut. The median cut here is
// the standard population-median split; it matches Pillow's MEDIANCUT in
// look, though a few boundary pixels can land on a neighbouring colour.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal samples from a uniform PRNG (Box-Muller, cached spare). */
export function gaussian(rand) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u1 = 0;
    while (u1 <= 1e-12) u1 = rand();
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const th = 2 * Math.PI * u2;
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

/**
 * Median-cut quantisation of RGB pixels to at most maxColors colours.
 * Returns an array of [r, g, b] representatives; pixels is a flat array of
 * [r, g, b] triples. Boxes split along the channel with the largest range,
 * at the median pixel of that channel.
 */
export function medianCut(pixels, maxColors = 16) {
  if (pixels.length === 0) return [];
  const uniq = new Map();
  for (const p of pixels) uniq.set((p[0] << 16) | (p[1] << 8) | p[2], p);
  if (uniq.size <= maxColors) return [...uniq.values()];
  let boxes = [pixels];
  while (boxes.length < maxColors) {
    let bi = -1;
    let bestRange = -1;
    let bestPop = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (const p of box) {
        if (p[0] < rMin) rMin = p[0];
        if (p[0] > rMax) rMax = p[0];
        if (p[1] < gMin) gMin = p[1];
        if (p[1] > gMax) gMax = p[1];
        if (p[2] < bMin) bMin = p[2];
        if (p[2] > bMax) bMax = p[2];
      }
      const range = Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
      if (range > bestRange || (range === bestRange && box.length > bestPop)) {
        bestRange = range;
        bestPop = box.length;
        bi = i;
      }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const p of box) {
      if (p[0] < rMin) rMin = p[0];
      if (p[0] > rMax) rMax = p[0];
      if (p[1] < gMin) gMin = p[1];
      if (p[1] > gMax) gMax = p[1];
      if (p[2] < bMin) bMin = p[2];
      if (p[2] > bMax) bMax = p[2];
    }
    const chan = rMax - rMin >= gMax - gMin && rMax - rMin >= bMax - bMin ? 0 : gMax - gMin >= bMax - bMin ? 1 : 2;
    const sorted = [...box].sort((a, b) => a[chan] - b[chan]);
    const mid = (sorted.length / 2) | 0;
    boxes.splice(bi, 1, sorted.slice(0, mid), sorted.slice(mid));
  }
  return boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n = box.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

/**
 * Turn one raw UNet output (Float32Array, [4, 32, 32], values in [-1, 1])
 * into 32x32 RGBA pixels. With quantize=true the colours are cut to at
 * most 16 (the final image); intermediate steps show the raw colours.
 */
export function rawToRGBA(x, quantize = false) {
  const N = 32 * 32;
  const rgba = new Uint8ClampedArray(N * 4);
  const u8 = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 4; c++) {
      let v = Math.round((x[c * N + i] + 1) * 127.5);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      u8[i * 4 + c] = v;
    }
  }
  const opaque = [];
  for (let i = 0; i < 32 * 32; i++) {
    const a = u8[i * 4 + 3] >= 128;
    if (a) opaque.push([u8[i * 4], u8[i * 4 + 1], u8[i * 4 + 2]]);
  }
  let palette = null;
  if (quantize && opaque.length > 0) palette = medianCut(opaque, 16);
  for (let i = 0; i < 32 * 32; i++) {
    const a = u8[i * 4 + 3] >= 128;
    let r = u8[i * 4];
    let g = u8[i * 4 + 1];
    let b = u8[i * 4 + 2];
    if (palette && a) {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < palette.length; j++) {
        const dr = palette[j][0] - r;
        const dg = palette[j][1] - g;
        const db = palette[j][2] - b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      r = palette[best][0];
      g = palette[best][1];
      b = palette[best][2];
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a ? 255 : 0;
  }
  return rgba;
}
