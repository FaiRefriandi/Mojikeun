"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MojiClient,
  crashedLastTime,
  loadEngine,
  type LoadStage,
  type Progress,
} from "@/lib/moji-client";
import {
  GRID,
  N,
  downloadBlob,
  nearestPaletteIndex,
  paintTokens,
  pngBlob,
  slug,
} from "@/lib/pixels";

const STEPS = 16;
const VARIANTS = 4;
const FORCE_CPU_KEY = "moji-studio:force-cpu";

const PRESETS = [
  "red crab waving",
  "cat wearing sunglasses",
  "sleepy owl",
  "happy axolotl",
  "slice of pizza",
  "boba tea cup",
  "rubber duck",
  "ghost",
];

type Status = "loading" | "ready" | "working" | "error";
type Tool = "brush" | "eyedropper" | "eraser";

function SpriteCanvas({
  tokens,
  palette,
  masked,
  size,
  className,
}: {
  tokens: Int32Array | number[] | null;
  palette: Uint8ClampedArray | null;
  masked?: Uint8Array | null;
  size: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && tokens && palette) paintTokens(ref.current, tokens, palette, masked ?? null);
  }, [tokens, palette, masked]);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      className={`pixelated ${className ?? ""}`}
    />
  );
}

export default function Mojikeun() {
  const clientRef = useRef<MojiClient | null>(null);
  const seedRef = useRef(1);
  const stopRef = useRef(false);

  const [status, setStatus] = useState<Status>("loading");
  const [loadStage, setLoadStage] = useState<LoadStage>("download");
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal] = useState(114900547);
  const [errorText, setErrorText] = useState("");
  const [device, setDevice] = useState("");

  const [prompt, setPrompt] = useState("red crab waving");
  const [shownPrompt, setShownPrompt] = useState("");
  const [variants, setVariants] = useState<
    ({ tokens: Int32Array; masked: Uint8Array | null } | null)[]
  >(Array(VARIANTS).fill(null));
  const [made, setMade] = useState(0);
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState(0);
  const [stopRequested, setStopRequested] = useState(false);

  const [palette, setPalette] = useState<Uint8ClampedArray | null>(null);
  const [tokens, setTokens] = useState<Int32Array | null>(null);
  const tokensRef = useRef<Int32Array | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [colorIdx, setColorIdx] = useState(1);
  const [prevTokens, setPrevTokens] = useState<Int32Array | null>(null);
  const paintingRef = useRef(false);

  const [copied, setCopied] = useState("");

  const editorRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (editorRef.current && tokens && palette) paintTokens(editorRef.current, tokens, palette);
  }, [tokens, palette]);

  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  const startLoading = useCallback(async () => {
    setStatus("loading");
    setLoadStage("download");
    setErrorText("");
    try {
      if (crashedLastTime()) {
        try {
          localStorage.setItem(FORCE_CPU_KEY, "1");
        } catch {
          // Storage blocked; the loader still tries WebGPU first.
        }
      }
      const client = await loadEngine((p: Progress) => {
        setLoadStage(p.stage);
        setLoaded(p.loaded);
        setTotal(p.total);
      });
      clientRef.current = client;
      setPalette(client.palette);
      setDevice(client.device);
      setColorIdx(nearestPaletteIndex(client.palette, 194, 80, 27));
      setStatus("ready");
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    startLoading();
  }, [startLoading]);

  const run = useCallback(
    async (text: string) => {
      const client = clientRef.current;
      const clean = text.trim();
      if (!client || !clean || status === "working") return;
      setPrompt(clean);
      setStatus("working");
      setStopRequested(false);
      stopRef.current = false;
      setCopied("");
      const perRun = client.device === "webgpu" ? VARIANTS : 1;
      const rounds = VARIANTS / perRun;
      const done: Int32Array[] = [];
      const empty = () =>
        Array(VARIANTS).fill(null) as ({ tokens: Int32Array; masked: Uint8Array | null } | null)[];
      setMade(0);
      setSelected(0);
      setTokens(null);
      try {
        for (let r = 0; r < rounds && !stopRef.current; r++) {
          setStep(0);
          seedRef.current = (seedRef.current * 7919 + 17) % 2147483647;
          const x = await client.generate(clean, {
            n: perRun,
            seed: seedRef.current,
            onStep: (k, sx, smasked) => {
              setStep(k + 1);
              // Live frame: finished rounds plus the current partial round,
              // with still masked pixels shown in pale grey.
              const partials = Array.from({ length: perRun }, (_, b) => ({
                tokens: sx.slice(b * N, (b + 1) * N),
                masked: smasked.slice(b * N, (b + 1) * N),
              }));
              setVariants([
                ...done.map((d) => ({ tokens: d, masked: null as Uint8Array | null })),
                ...partials,
                ...empty(),
              ].slice(0, VARIANTS));
            },
          });
          for (let b = 0; b < perRun; b++) done.push(x.slice(b * N, (b + 1) * N));
          setVariants([
            ...done.map((d) => ({ tokens: d, masked: null as Uint8Array | null })),
            ...empty(),
          ].slice(0, VARIANTS));
          setMade(done.length);
          setShownPrompt(clean);
        }
        if (done.length > 0) {
          const first = new Int32Array(done[0]);
          setTokens(first);
          setSelected(0);
        }
        setStatus("ready");
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [status],
  );

  const shuffle = () => {
    const v = Math.floor(Math.random() * 2147483647);
    seedRef.current = v;
    if (clientRef.current && status === "ready" && prompt.trim()) void run(prompt);
  };

  const pickPreset = (text: string) => {
    setPrompt(text);
    if (clientRef.current && status === "ready") void run(text);
  };

  const selectVariant = (i: number) => {
    const v = variants[i];
    if (!v || i >= made) return;
    setSelected(i);
    setTokens(new Int32Array(v.tokens));
    setPrevTokens(null);
  };

  const paintCell = (idx: number) => {
    const cur = tokensRef.current;
    if (!cur) return;
    if (tool === "eyedropper") {
      const picked = cur[idx];
      if (picked !== 0) setColorIdx(picked);
      setTool("brush");
      return;
    }
    const next = new Int32Array(cur);
    next[idx] = tool === "eraser" ? 0 : colorIdx;
    setTokens(next);
  };

  const cellFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): number | null => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID);
    if (x < 0 || x >= GRID || y < 0 || y >= GRID) return null;
    return y * GRID + x;
  };

  const onEditorDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const idx = cellFromEvent(e);
    if (idx === null || !tokensRef.current) return;
    paintingRef.current = true;
    setPrevTokens(new Int32Array(tokensRef.current));
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    paintCell(idx);
  };

  const onEditorMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!paintingRef.current || !(e.buttons & 1)) return;
    const idx = cellFromEvent(e);
    if (idx !== null) paintCell(idx);
  };

  const onEditorUp = () => {
    paintingRef.current = false;
  };

  const undoEdit = () => {
    if (!prevTokens) return;
    setTokens(new Int32Array(prevTokens));
    setPrevTokens(null);
  };

  const clearEditor = () => {
    if (!tokensRef.current) return;
    setPrevTokens(new Int32Array(tokensRef.current));
    setTokens(new Int32Array(N).fill(0));
  };

  const flash = (key: string) => {
    setCopied(key);
    setTimeout(() => setCopied(""), 1600);
  };

  const downloadSelected = async () => {
    if (!tokens || !palette) return;
    const blob = await pngBlob(tokens, palette, 128);
    downloadBlob(blob, `${slug(shownPrompt || prompt)}.png`);
    flash("download");
  };

  const downloadAll = async () => {
    if (!palette) return;
    const base = slug(shownPrompt || prompt);
    for (let i = 0; i < made; i++) {
      const v = variants[i];
      if (!v) continue;
      const blob = await pngBlob(v.tokens, palette, 128);
      downloadBlob(blob, `${base}-${i + 1}.png`);
      await new Promise((r) => setTimeout(r, 200));
    }
    flash("download-all");
  };

  const copyPng = async () => {
    if (!tokens || !palette) return;
    try {
      const blob = await pngBlob(tokens, palette, 128);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash("copy-png");
    } catch {
      await downloadSelected();
    }
  };

  const copyCode = async () => {
    const code = `:${slug(shownPrompt || prompt)}:`;
    try {
      await navigator.clipboard.writeText(code);
      flash("copy-code");
    } catch {
      // Clipboard can be blocked in some iframes; the code is still visible to select.
    }
  };

  const downloadFrac = total ? Math.min(1, loaded / total) : 0;
  const shortcode = `:${slug(shownPrompt || prompt)}:`;
  const busy = status === "working";
  const canMake = status === "ready" && !!prompt.trim();
  const currentTokens = tokens ?? (made > 0 ? (variants[selected]?.tokens ?? null) : null);
  const currentMasked = tokens ? null : (variants[selected]?.masked ?? null);
  const statusLine =
    status === "loading"
      ? loadStage === "download"
        ? `Loading model, ${Math.round(downloadFrac * 100)}%`
        : "Loading model"
      : status === "working"
        ? `Painting, step ${step} of ${STEPS}`
        : "";
  const statusFrac = status === "loading" ? downloadFrac : status === "working" ? step / STEPS : 0;

  return (
    <div className="min-h-screen bg-ground text-ink">
      <main className="mx-auto max-w-[680px] px-4 pb-12 sm:px-6">
        <header className="flex items-baseline justify-between pt-6">
          <h1 className="font-display text-lg font-bold tracking-tight">Mojikeun</h1>
          <span className="font-mono text-[11px] text-muted">16 x 16</span>
        </header>

        <form
          className="mt-6 flex min-w-0 items-center gap-2 rounded-full border border-line bg-card p-2 pl-5 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) {
              stopRef.current = true;
              setStopRequested(true);
            } else {
              void run(prompt);
            }
          }}
        >
          <label htmlFor="moji-prompt" className="sr-only">
            Describe an emoji
          </label>
          <input
            id="moji-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe an emoji"
            aria-label="Describe an emoji"
            maxLength={120}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-full bg-transparent text-lg font-medium outline-none placeholder:text-muted/60"
          />
          <button
            type="submit"
            disabled={busy ? device !== "cpu" || stopRequested : !canMake}
            className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-accent px-5 font-display text-sm font-semibold text-accent-ink transition hover:brightness-110 active:brightness-95 disabled:opacity-40"
          >
            {busy ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin-slow rounded-full border-2 border-accent-ink/40 border-t-accent-ink" />
                {device === "cpu" ? "Stop" : "Painting"}
              </>
            ) : (
              "Generate"
            )}
          </button>
        </form>

        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {PRESETS.map((item) => (
            <button
              key={item}
              type="button"
              disabled={busy}
              onClick={() => pickPreset(item)}
              className={`rounded-full border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${
                prompt === item
                  ? "border-ink bg-ink text-white"
                  : "border-line bg-card hover:border-ink"
              }`}
            >
              {item}
            </button>
          ))}
          <button
            type="button"
            disabled={busy || !canMake}
            onClick={shuffle}
            className="rounded-full border border-accent bg-card px-3 py-2 text-sm text-accent transition-colors disabled:opacity-40"
          >
            Shuffle
          </button>
        </div>

        {(status === "loading" || status === "working") && (
          <div className="mt-5" role="status">
            <p className="text-center font-mono text-xs text-muted">{statusLine}</p>
            <div className="mx-auto mt-2 h-1.5 w-48 overflow-hidden rounded-full bg-surface">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${statusFrac * 100}%` }}
              />
            </div>
          </div>
        )}
        {status === "error" && (
          <div className="mt-5 text-center">
            <p className="break-words text-sm text-muted">{errorText}</p>
            <button
              type="button"
              onClick={() => void startLoading()}
              className="mt-3 rounded-full bg-ink px-4 py-2 font-display text-sm font-semibold text-white"
            >
              Try again
            </button>
          </div>
        )}

        <div className="mt-6 flex flex-col items-center">
          <div className="flex aspect-square w-full max-w-[280px] items-center justify-center rounded-3xl bg-card p-4">
            {currentTokens && palette ? (
              <SpriteCanvas
                tokens={currentTokens}
                palette={palette}
                masked={currentMasked}
                size={256}
                className="h-auto w-full"
              />
            ) : (
              <span className="px-6 text-center font-mono text-xs leading-relaxed text-muted">
                Your emoji appears here.
              </span>
            )}
          </div>
          {made > 0 && (
            <button
              type="button"
              onClick={() => void copyCode()}
              title="Copy the emoji name"
              className="mt-3 truncate rounded-full bg-surface px-4 py-2 font-mono text-sm hover:bg-line"
            >
              {copied === "copy-code" ? "Copied" : shortcode}
            </button>
          )}
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2 sm:gap-3">
          {variants.map((v, i) => (
            <button
              key={i}
              type="button"
              disabled={!v || i >= made}
              onClick={() => selectVariant(i)}
              aria-label={`Variation ${i + 1}`}
              className={`flex aspect-square items-center justify-center rounded-2xl border bg-card p-2 transition-colors disabled:opacity-40 ${
                i === selected && made > 0 ? "border-accent" : "border-line hover:border-ink"
              }`}
            >
              {v && palette ? (
                <SpriteCanvas tokens={v.tokens} palette={palette} masked={v.masked} size={128} className="h-auto w-full" />
              ) : (
                <span className="font-mono text-xs text-muted">
                  {busy ? "..." : `0${i + 1}`}
                </span>
              )}
            </button>
          ))}
        </div>

        <section id="editor" className="mt-8 scroll-mt-6">
          {tokens && palette ? (
            <>
              <canvas
                ref={editorRef}
                width={256}
                height={256}
                className="pixelated mx-auto block h-auto w-full max-w-[420px] cursor-crosshair touch-none rounded-2xl bg-card p-2"
                onPointerDown={onEditorDown}
                onPointerMove={onEditorMove}
                onPointerUp={onEditorUp}
                onPointerLeave={onEditorUp}
              />
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {(
                  [
                    ["brush", "Brush"],
                    ["eyedropper", "Eyedropper"],
                    ["eraser", "Eraser"],
                  ] as [Tool, string][]
                ).map(([t, label]) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTool(t)}
                    className={`rounded-full border px-4 py-2 font-display text-sm font-semibold ${
                      tool === t ? "border-ink bg-ink text-white" : "border-line bg-card hover:border-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={undoEdit}
                  disabled={!prevTokens}
                  className="rounded-full border border-line bg-card px-4 py-2 font-display text-sm font-semibold disabled:opacity-40"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={clearEditor}
                  className="rounded-full border border-line bg-card px-4 py-2 font-display text-sm font-semibold"
                >
                  Clear
                </button>
              </div>
              <div className="scroll-thin mx-auto mt-3 flex max-h-[120px] max-w-[420px] flex-wrap justify-center gap-1 overflow-y-auto">
                {Array.from({ length: 512 }, (_, i) => {
                  const r = palette[i * 4];
                  const g = palette[i * 4 + 1];
                  const b = palette[i * 4 + 2];
                  const a = palette[i * 4 + 3];
                  return (
                    <button
                      key={i}
                      type="button"
                      title={i === 0 ? "transparent" : `colour ${i}`}
                      aria-label={i === 0 ? "transparent" : `colour ${i}`}
                      onClick={() => {
                        setColorIdx(i);
                        setTool("brush");
                      }}
                      style={{
                        background: a === 0 ? "repeating-conic-gradient(#d8d2c6 0% 25%, #faf8f4 0% 50%) 0 0 / 8px 8px" : `rgba(${r},${g},${b},${a / 255})`,
                      }}
                      className={`h-[16px] w-[16px] shrink-0 rounded-[4px] border ${
                        colorIdx === i ? "border-accent ring-2 ring-accent" : "border-line"
                      }`}
                    />
                  );
                })}
              </div>
            </>
          ) : (
            <p className="py-6 text-center font-mono text-xs leading-relaxed text-muted">
              Generate an emoji first.
            </p>
          )}
        </section>

        {made > 0 && (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => void downloadSelected()}
              disabled={!tokens}
              className="rounded-full bg-ink px-4 py-2.5 font-display text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            >
              {copied === "download" ? "Saved" : "Download PNG"}
            </button>
            <button
              type="button"
              onClick={() => void downloadAll()}
              disabled={made === 0}
              className="rounded-full border border-ink px-4 py-2.5 font-display text-sm font-semibold disabled:opacity-40"
            >
              {copied === "download-all" ? "Saved all 4" : "Download all 4"}
            </button>
            <button
              type="button"
              onClick={() => void copyPng()}
              disabled={!tokens}
              className="rounded-full border border-line bg-card px-4 py-2.5 font-display text-sm font-semibold disabled:opacity-40"
            >
              {copied === "copy-png" ? "Copied" : "Copy PNG"}
            </button>
          </div>
        )}

      </main>
    </div>
  );
}
