# Riset: Moji Studio — Tessera-small Pixel-Art Emoji Generator

Riset saja (18 Nov 2026). Belum ada website yang dibangun. Sumber: Space
https://huggingface.co/spaces/cfahlgren1/slack-moji (cfahlgren1, "Slack Moji",
SDK static, SvelteKit) dan model https://huggingface.co/thejagstudio/tessera-small.

## 1. Ringkasan model

**Tessera-small** oleh Jagrat Patel (TheJagStudio), 47,6 juta parameter, lisensi
**CC BY-NC 4.0** — gratis untuk edukasi/riset/proyek personal non-komersial,
**penggunaan komersial dilarang** tanpa lisensi terpisah dari penulis. Ini penting
untuk portfolio: boleh dipakai sebagai demo personal dengan kredit, bukan produk
berbayar. Text encoder CLIP (`openai/clip-vit-base-patch32`) berlisensi MIT.

Ini diffusion language model untuk pixel art 16x16, bukan LLM dan bukan model
gambar latent biasa. Satu sprite = kalimat 256 token (16x16 piksel), tiap piksel
satu token dari palet 512 warna yang dipelajari (token 0 = transparan).
Transformer bidirectional mulai dari kanvas yang seluruhnya `[MASK]` lalu
membuka semua piksel secara paralel dalam ~16 langkah, dikondisikan teks dari
CLIP text encoder yang dibekukan. Tidak ada VAE, latent space, atau autoregression.

Arsitektur (`model_config.json` di repo model): joint text+pixel bidirectional
transformer, hourglass depth 2+8+2 blok (core di-patch-merge 2x2), width/dim 512,
8 heads, QK-RMSNorm, 2D axial RoPE (theta 100), Conv-SwiGLU (`conv_ffn: true`,
MLP ratio 3.0), adaLN-single, 4 registers, self-conditioning (`self_cond: true`),
`text_dim` 512, `text_len` 24, `color_freqs` 6, vocab 512. Objective: absorbing-state
masked diffusion, cosine schedule, blob masks, perceptual label smoothing, CFG
dropout. Training: 82.342 langkah x batch 512 (30 epoch atas 1,4 juta sprite),
dataset Angais Pixel Art Atlas 1.4M, satu RTX PRO 6000 Blackwell ~5,5 jam, optimizer
Muon + AdamW, EMA 0.9995, bf16. Metrik: validasi NLL 0,859 nats/piksel, akurasi
78,8% piksel ter-mask, CLIP score 25,24 (vs 25,28 sprite asli).

File di repo model: `tessera-small-fp16.pt` (bobot EMA fp16 + config + palet +
text-encoder id), `model_config.json`, `train_config.json`, `metrics.jsonl`,
`showcase.png`. **File .pt tidak diunduh** (sesuai tugas). Tidak ditemukan repo
GitHub terpisah `thejagstudio/tessera`; kartu model menulis "code: see the demo
Space's files" — kode referensi resminya adalah file-file Space Slack Moji itu
sendiri (yang sudah diunduh di bawah).

## 2. Pipeline inferensi persis (dari `engine.js` + `client.js`, port ke Next.js)

Semua jalan di browser via onnxruntime-web 1.22.0 (CDN jsDelivr,
`ort.webgpu.min.mjs`, `ort.env.wasm.wasmPaths` diarahkan ke CDN yang sama).
Dua sesi ONNX dibuat berurutan (satu per satu agar memori puncak hanya satu
model): WebGPU dulu, fallback ke WASM CPU bila WebGPU tidak ada, gagal start,
atau gagal self-test. `graphOptimizationLevel: "all"`, ConstantFolding
dimatikan (kalau aktif, bobot int8 mengembang jadi fp32 ~4x memori). Self-test
wajib: prompt tetap dari `selftest.json` dijalankan sekali di denoiser penuh
mask; lolos bila argmax cocok >= 80% dan selisih rata-rata top-logit <= 0,5.

**Tokenisasi teks** (`tokenizer.js`, class `ClipTokenizer`, dari
`tokenizer.json` CLIP BPE): normalisasi NFC, collapse whitespace, lowercase,
regex split CLIP, byte-level BPE dengan `</w>`. `encode()` menghasilkan
`[BOS=49406, ..., EOS=49407]`; `encodeFixed(text, 24)` memotong ke 24 token
(dengan EOS terakhir dipertahankan) lalu padding dengan EOS sampai 24.

**CLIP text encoder** (`encodeText`): input `input_ids` int64 shape `[1, 24]`
(BigInt64Array). Output yang dipakai: `last_hidden_state` (float32
`[1, 24, 512]`) dan `pooler_output` (float32 `[1, 512]`). Sekali per prompt,
lalu hasilnya diduplikasi untuk batch CFG.

**Denoiser** (`Engine.generate`, default `n=4, seed=0, steps=16, cfgScale=3,
choiceTemperature=2, nmsThreshold=0.9`): batch ganda `B2 = n*2` — n baris
terkondisi + n baris unconditional (`drop_text` bool: 0 untuk n pertama,
1 untuk n kedua; `text_states`/`text_pooled` yang sama diulang ke semua baris).
Input per langkah: `x` int64 `[B2, 256]` (token piksel, awalnya semua
`MASK=512`), `text_states` float32 `[B2, 24, 512]`, `text_pooled` float32
`[B2, 512]`, `mask_ratio` float32 `[B2]` (fraksi piksel masih ter-mask per
baris), `sc_probs` float32 `[B2, 256, 512]` (distribusi self-conditioning dari
langkah sebelumnya, nol di langkah pertama), `drop_text` bool `[B2]`.
Output: `logits` float32 `[B2, 256, 512]`; NaN/Infinity langsung throw
`BAD_OUTPUT`.

Per langkah k (frac = (k+1)/steps): CFG per piksel
`guided = uncond + cfgScale * (cond - uncond)`, softmax, lalu satu sampel
kategorikal per piksel (PRNG `mulberry32(seed)`, seed per generate — di UI,
seed dirotasi tiap ronde: `seed = (seed*7919+17) % 2147483647`, mulai dari 1).
Jumlah piksel yang di-commit mengikuti cosine schedule:
`remaining = floor(256 * cos(pi/2 * frac))`, langkah terakhir 0;
`nCommit = clamp(nMasked - remaining, 1, nMasked)`. Skor pemilihan =
`log(p_terpilih) + choiceTemperature * (1-frac) * Gumbel` (noise Gumbel
dianil: besar di awal, hilang di akhir). Urutan commit: piksel "certain"
(p >= 0,9) didahulukan; yang belum certain harus jadi local-max skor di
tetangga 3x3 yang masih ter-mask (spatial NMS, bonus skor +1e4 bila eligible),
diurutkan menurun, ambil nCommit teratas. Setelah commit, distribusi guided
per piksel (`probs`) disimpan ke `sc_probs` kedua cabang CFG (self-conditioning).
`onStep(k, x, masked)` dipanggil tiap langkah untuk animasi pengisian kanvas.

**Empat varian**: satu batch n=4 dengan seed yang sama di WebGPU (sekitar 1 dtk);
di CPU, UI memanggil generate 4x dengan n=1 dan seed berbeda tiap ronde
(~10 dtk per varian). Variasi antar sprite datang dari sampling kategorikal
+ noise Gumbel yang berbeda per baris batch, bukan dari prompt berbeda.

**Decode palet dan render**: `meta.json` hanya berisi `palette_rgba`: 512
entri `[R,G,B,A]`, indeks 0 = `[0,0,0,0]` (transparan). `client.js` mengubahnya
jadi `Uint8ClampedArray(512*4)`; `toRGBA(x, masked, b, maskColor=[220,220,225,255])`
memetakan tiap token ke RGBA, piksel yang masih ter-mask diganti warna abu-abu
mask. Render: canvas 2D, `fillRect` per piksel dengan `image-rendering:
pixelated` (tidak ada upscale/interpolasi — kanvas 256x256 menampilkan grid
16x16 apa adanya). Export PNG (`+page.svelte`, `pngBlob`): gambar ulang ke
canvas 128x128 lalu `toBlob("image/png")`, nama file `slug(prompt).png`
(lowercase, non-alnum jadi `-`, maks 40 karakter); ada juga Copy ke clipboard
sebagai PNG dan shortcode Slack `:<slug>:` yang bisa di-copy.

**Fungsi/file kunci untuk di-port**: `engine.js` — `createEngine`,
`Engine.encodeText`, `Engine.generate`, `selfTest`, `mulberry32`,
`webgpuAvailable`, konstanta `GRID=16, N=256, K=512, MASK=512, TEXT_LEN=24,
TEXT_DIM=512`; `tokenizer.js` — `ClipTokenizer.encode/encodeFixed/bpe`;
`client.js` — `loadEngine`, `FILES`, `fetchBytes` (Cache API `tessera-small-v3`,
validasi ukuran byte persis, hapus cache lama), `toRGBA`; `worker.js` —
Web Worker (`init`/`generate`/`step`/`done`/`error` via postMessage);
`+page.svelte` — UI/logika ronde CPU-vs-GPU, `paint`, `pngBlob`, `slug`.
Dependensi npm Space: hanya devDependencies SvelteKit (tidak ada
`onnxruntime-web` di package.json — ORT dimuat dari CDN jsDelivr saat runtime,
jadi builder Next.js bisa memakai `onnxruntime-web` npm atau pola CDN yang
sama; adapter `@sveltejs/adapter-static`, Svelte 5, Vite 6).

## 3. File yang diunduh

Lokasi: `~/workspace/moji-studio/models/` dan
`~/workspace/moji-studio/reference/slack-moji/`.

### Model (`models/`)

| File | Ukuran (byte) | SHA-256 |
|---|---|---|
| `tessera_w8.onnx` | 50.840.032 | `93f54a5e2fa2691beb7bb8b28c226a97b849994af7f5e43845b50ebaa44256df` |
| `clip_text_w8.onnx` | 64.060.515 | `bceda6fde8023e22b2eb5fc8dd496a5e24497169869f10254a402c59066b6422` |
| `tokenizer.json` | 2.224.041 | `b556ac8c99757ffb677208af34bc8c6721572114111a6e0aaf5fa69ff0b8d842` |
| `meta.json` | 10.442 | `b8f2920237522cd95e205087a78e11dacba95c6292fb9b0bcf3fb025425760c2` |
| `selftest.json` | 2.508 | `46edaec20b404300c54e2ae2e5ed0edf60b20df6f93f833b14aa4cfdd060627e` |

Total model: 114.900.547 byte (~109,6 MiB; cocok dengan klaim "115 MB" di Space).
`meta.json` = hanya `palette_rgba` (512 warna). `selftest.json` = `ids` (24 token
prompt uji, `[49406, 320, 736, 3055, 49407, ...]`), `argmax` (256 token referensi),
`top` (256 nilai top-logit referensi).

### Source Space (`reference/slack-moji/`)

| File | Ukuran (byte) | SHA-256 |
|---|---|---|
| `engine.js` | 10.769 | `1ad2ae62e52cd60349ffae8064744ea2c1961e096b133637e015e1a718806705` |
| `client.js` | 7.934 | `18f980d2782a0d616a3fe620a7195d85e8d56e2c41b102e0cad55c6295be028a` |
| `tokenizer.js` | 2.923 | `b80a9f783e539238ee490d24688f8d7b9bc92b197228206e49fcc203d5faa322` |
| `worker.js` | 986 | `b0c3ba32b01cb4fb80e27e915d5664fe9cb0e819288362b0fac67a99db3c9773` |
| `package.json` | 518 | `437a1d669397b8d5d6d6be4a4a8d4f6227395098f5d2aea36b0745fbeaf31c1d` |
| `README.md` | 946 | `0957719507a5a40ab9525aa509934bd65d19604d6e7900230b504e9fe85612e5` |
| `+page.svelte` | 23.415 | `ae09e016e090b2664497fa859341c24d43fd3725bb411dc89b4d9769cb2f1db4` |

## 4. File yang gagal / catatan

- **Percobaan pertama gagal**: URL `.../resolve/main/models/<file>` mengembalikan
  "Entry not found" (15 byte) untuk semua file. Penyebab: folder model di repo
  Space bukan `models/` melainkan **`static/models/`** (terlihat dari daftar
  file API Space). URL benar: `.../resolve/main/static/models/<file>`.
  Semua file lalu berhasil diunduh ulang dengan ukuran persis yang diharapkan
  (kedua ONNX cocok byte-per-byte dengan angka di `client.js`).
- **Tidak ada repo GitHub `thejagstudio/tessera`** yang ditemukan lewat pencarian;
  kode referensi resmi adalah file Space itu sendiri.
- **Tidak diunduh**: `tessera-small-fp16.pt` (sengaja, sesuai tugas).
  `model_config.json`/`train_config.json` hanya dibaca (via curl ke /tmp) untuk
  arsitektur; isinya diringkas di bagian 1. Verifikasi struktur ONNX lewat
  pustaka Python `onnx` tidak dilakukan (tidak terinstal); nama node input/output
  di atas adalah nama persis yang dipakai pemanggilan `session.run` di
  `engine.js`, jadi sudah cukup sebagai spesifikasi port.
- Catatan lisensi untuk builder: model CC BY-NC 4.0 — portfolio/demo personal
  OK dengan kredit "Tessera by Jagrat Patel (TheJagStudio)", dilarang komersial.
