"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MojiClient,
  crashedLastTime,
  loadEngine,
  type LoadStage,
  type Progress,
  type SelfTestResult,
} from "@/lib/moji-client";
import {
  GRID,
  N,
  downloadBlob,
  nearestPaletteIndex,
  paintTokens,
  pngBlob,
  slug,
  tokensToDataURL,
} from "@/lib/pixels";

const STEPS = 16;
const VARIANTS = 4;
const HISTORY_KEY = "moji-studio:history";
const FORCE_CPU_KEY = "moji-studio:force-cpu";

const PRESETS: { group: string; items: string[] }[] = [
  { group: "Animals", items: ["red crab waving", "cat wearing sunglasses", "sleepy owl", "happy axolotl"] },
  { group: "Food", items: ["slice of pizza", "taco", "boba tea cup", "strawberry cake"] },
  { group: "Objects", items: ["rubber duck", "vintage camera", "rocket ship", "treasure chest"] },
  { group: "Feelings", items: ["ghost", "fire", "heart with sparkles", "sleepy moon"] },
];

const CPU_NOTES: Record<string, string> = {
  "no-webgpu": "No WebGPU here, so it runs on your CPU.",
  "gpu-error": "WebGPU failed to start here, so it runs on your CPU.",
  "gpu-bad-output": "Your GPU gave wrong results in a quick check, so it runs on your CPU.",
  forced: "Running on your CPU.",
};

type Status = "loading" | "ready" | "working" | "error";
type Tool = "brush" | "eyedropper" | "eraser";

type HistoryItem = {
  id: number;
  prompt: string;
  code: string;
  tokens: number[];
  dataUrl: string;
  ts: number;
};

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

export default function MojiStudio() {
  const clientRef = useRef<MojiClient | null>(null);
  const seedRef = useRef(1);
  const stopRef = useRef(false);

  const [status, setStatus] = useState<Status>("loading");
  const [loadStage, setLoadStage] = useState<LoadStage>("download");
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal] = useState(114900547);
  const [errorText, setErrorText] = useState("");
  const [device, setDevice] = useState("");
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);

  const [prompt, setPrompt] = useState("red crab waving");
  const [shownPrompt, setShownPrompt] = useState("");
  const [seed, setSeed] = useState(1);
  const [variants, setVariants] = useState<
    ({ tokens: Int32Array; masked: Uint8Array | null } | null)[]
  >(Array(VARIANTS).fill(null));
  const [made, setMade] = useState(0);
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState(0);
  const [round, setRound] = useState(1);
  const [ms, setMs] = useState(0);
  const [stopRequested, setStopRequested] = useState(false);

  const [palette, setPalette] = useState<Uint8ClampedArray | null>(null);
  const [tokens, setTokens] = useState<Int32Array | null>(null);
  const tokensRef = useRef<Int32Array | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [colorIdx, setColorIdx] = useState(1);
  const [prevTokens, setPrevTokens] = useState<Int32Array | null>(null);
  const paintingRef = useRef(false);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [copied, setCopied] = useState("");
  const [editorNote, setEditorNote] = useState("");

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
      setFallbackReason(client.fallbackReason);
      setSelfTest(client.selfTest);
      setColorIdx(nearestPaletteIndex(client.palette, 194, 80, 27));
      setStatus("ready");
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw) as HistoryItem[]);
    } catch {
      // A broken history entry is not fatal; start empty.
    }
    startLoading();
  }, [startLoading]);

  const saveHistory = useCallback((item: HistoryItem) => {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, 12);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        // Storage full or blocked; history just stays in memory.
      }
      return next;
    });
  }, []);

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
      setEditorNote("");
      const t0 = performance.now();
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
          setRound(r + 1);
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
        setSeed(seedRef.current);
        if (done.length > 0) {
          const first = new Int32Array(done[0]);
          setTokens(first);
          setSelected(0);
          if (client.palette) {
            saveHistory({
              id: Date.now(),
              prompt: clean,
              code: `:${slug(clean)}:`,
              tokens: Array.from(first),
              dataUrl: tokensToDataURL(first, client.palette, 128),
              ts: Date.now(),
            });
          }
        }
        setMs(Math.round(performance.now() - t0));
        setStatus("ready");
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [status, saveHistory],
  );

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
    setEditorNote("");
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
    setEditorNote("Undone.");
  };

  const clearEditor = () => {
    if (!tokensRef.current) return;
    setPrevTokens(new Int32Array(tokensRef.current));
    setTokens(new Int32Array(N).fill(0));
    setEditorNote("Cleared. Every pixel is transparent now.");
  };

  const openHistory = (item: HistoryItem) => {
    if (!palette) return;
    setTokens(new Int32Array(item.tokens));
    setPrompt(item.prompt);
    setShownPrompt(item.prompt);
    setSelected(0);
    setPrevTokens(null);
    setEditorNote(`Opened ${item.code} from your history.`);
    document.getElementById("editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const removeHistory = (id: number) => {
    setHistory((prev) => {
      const next = prev.filter((h) => h.id !== id);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors.
      }
      return next;
    });
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
  const mb = (b: number) => Math.round(b / 1e6);
  const shortcode = `:${slug(shownPrompt || prompt)}:`;
  const checkPct = selfTest ? Math.round(selfTest.agreement * 100) : null;
  const busy = status === "working";
  const canMake = status === "ready" && !!prompt.trim();
  const currentTokens = tokens ?? (made > 0 ? (variants[selected]?.tokens ?? null) : null);
  const currentMasked = tokens ? null : (variants[selected]?.masked ?? null);

  const loadTitle =
    loadStage === "download"
      ? `Downloading the model, ${Math.round(downloadFrac * 100)}%`
      : loadStage === "load"
        ? "Loading the model into memory"
        : "Testing the model on your device";
  const loadDetail =
    loadStage === "download"
      ? `${mb(loaded)} of ${mb(total)} MB, first visit only`
      : loadStage === "load"
        ? "Almost there"
        : "Making sure it paints correctly";

  return (
    <div className="min-h-screen bg-ground text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="font-display text-lg font-bold tracking-tight">Moji Studio</span>
            <span className="hidden font-mono text-[11px] uppercase tracking-widest text-muted sm:inline">
              pixel emoji atelier
            </span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] sm:text-xs">
            {status === "loading" && (
              <span className="rounded-full border border-line bg-card px-3 py-1">loading model</span>
            )}
            {status === "ready" && device && (
              <span className="rounded-full border border-line bg-card px-3 py-1">
                {device === "webgpu" ? "WebGPU" : "CPU"}
                {checkPct !== null ? `, check passed ${checkPct}%` : ""}
              </span>
            )}
            {status === "working" && (
              <span className="rounded-full border border-accent bg-accent px-3 py-1 text-accent-ink">
                painting, step {step} of {STEPS}
              </span>
            )}
            {status === "error" && (
              <span className="rounded-full border border-accent bg-card px-3 py-1 text-accent">
                model error
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-4 pb-16 sm:px-6">
        {/* Hero: the generator itself */}
        <section className="grid gap-6 pt-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:pt-12">
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-widest text-accent">
              001, the studio
            </p>
            <h1 className="mt-2 font-display text-[clamp(2rem,5vw,3.4rem)] font-bold leading-[1.05] tracking-tight">
              Describe it.
              <br />
              Watch it paint itself.
            </h1>
            <p className="mt-3 max-w-[560px] text-[17px] leading-relaxed text-muted">
              A tiny model paints four 16 by 16 pixel emoji from one line of text. Everything
              happens in your browser, and the canvas below fills in step by step.
            </p>

            <form
              className="mt-6 flex min-w-0 items-center gap-2 rounded-full border border-line bg-card p-2 pl-5 shadow-sm"
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
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe an emoji"
                aria-label="Describe an emoji"
                maxLength={120}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-lg font-medium outline-none placeholder:text-muted/60"
              />
              <button
                type="submit"
                disabled={busy ? device !== "cpu" || stopRequested : !canMake}
                className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-ink px-5 font-display text-sm font-semibold text-white transition-opacity disabled:opacity-40"
              >
                {busy ? (
                  <>
                    <span className="inline-block h-3 w-3 animate-spin-slow rounded-full border-2 border-white/40 border-t-white" />
                    {device === "cpu" ? "Stop" : "Painting"}
                  </>
                ) : (
                  "Generate"
                )}
              </button>
            </form>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
              <label className="flex items-center gap-2 font-mono text-xs text-muted">
                Seed
                <input
                  type="number"
                  value={seed}
                  min={0}
                  max={2147483646}
                  onChange={(e) => {
                    const v = Math.floor(Number(e.target.value));
                    if (Number.isFinite(v) && v >= 0) {
                      setSeed(v);
                      seedRef.current = v;
                    }
                  }}
                  className="w-28 rounded-md border border-line bg-card px-2 py-1 font-mono text-xs text-ink outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  const v = Math.floor(Math.random() * 2147483647);
                  setSeed(v);
                  seedRef.current = v;
                }}
                className="rounded-full border border-line bg-card px-3 py-1 font-mono text-xs hover:border-ink"
              >
                Random seed
              </button>
              <span className="font-mono text-xs text-muted">
                Same prompt, new seed, new emoji.
              </span>
            </div>

            <div className="mt-6 space-y-3">
              {PRESETS.map((g) => (
                <div key={g.group} className="flex flex-wrap items-center gap-2">
                  <span className="w-20 shrink-0 font-mono text-[11px] uppercase tracking-widest text-muted">
                    {g.group}
                  </span>
                  {g.items.map((item) => (
                    <button
                      key={item}
                      type="button"
                      disabled={busy}
                      onClick={() => pickPreset(item)}
                      className={`rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-40 ${
                        prompt === item
                          ? "border-ink bg-ink text-white"
                          : "border-line bg-card hover:border-ink"
                      }`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ))}
            </div>

            {/* Load and run status */}
            <div className="mt-6 rounded-2xl border border-line bg-card p-4">
              {status === "loading" && (
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-display text-sm font-semibold">{loadTitle}</span>
                    <span className="font-mono text-xs text-muted">{loadDetail}</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface">
                    <div
                      className="h-full bg-accent transition-all"
                      style={{ width: `${downloadFrac * 100}%` }}
                    />
                  </div>
                  <p className="mt-2 font-mono text-[11px] text-muted">
                    Tessera-small plus CLIP, about 115 MB. Cached after the first visit.
                  </p>
                </div>
              )}
              {status === "error" && (
                <div>
                  <p className="font-display text-sm font-semibold">The model did not load.</p>
                  <p className="mt-1 break-words text-sm text-muted">{errorText}</p>
                  <button
                    type="button"
                    onClick={() => void startLoading()}
                    className="mt-3 rounded-full bg-ink px-4 py-2 font-display text-sm font-semibold text-white"
                  >
                    Try again
                  </button>
                </div>
              )}
              {status === "working" && (
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-display text-sm font-semibold">
                      {device === "cpu"
                        ? `Specimen ${round} of ${VARIANTS}, painting step ${step} of ${STEPS}`
                        : `Painting, step ${step} of ${STEPS}`}
                    </span>
                    <span className="font-mono text-xs text-muted">
                      {device === "cpu" ? "on your CPU, about 10 s each" : "on your GPU"}
                    </span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface">
                    <div
                      className="h-full bg-accent transition-all"
                      style={{
                        width: `${(((round - 1) * STEPS + step) / ((device === "cpu" ? VARIANTS : 1) * STEPS)) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              {status === "ready" && (
                <p className="text-sm text-muted">
                  {ms > 0
                    ? `${made} specimens in ${(ms / 1000).toFixed(1)} s, on your ${device === "webgpu" ? "GPU" : "CPU"}.`
                    : "Ready. Type anything."}
                  {fallbackReason ? ` ${CPU_NOTES[fallbackReason] ?? ""}` : ""}
                  {selfTest && checkPct !== null
                    ? ` Model check passed at ${checkPct}% match.`
                    : ""}
                </p>
              )}
            </div>
          </div>

          {/* Big preview */}
          <div className="min-w-0">
            <div className="rounded-2xl border border-line bg-card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
                  002, the canvas
                </span>
                <span className="font-mono text-[11px] text-muted">16 by 16</span>
              </div>
              <div className="mt-3 flex items-center justify-center rounded-xl bg-surface p-4">
                {currentTokens && palette ? (
                  <SpriteCanvas
                    tokens={currentTokens}
                    palette={palette}
                    masked={currentMasked}
                    size={256}
                    className="h-auto w-full max-w-[280px]"
                  />
                ) : (
                  <div className="flex aspect-square w-full max-w-[280px] items-center justify-center rounded-lg border border-dashed border-line">
                    <span className="px-6 text-center font-mono text-xs leading-relaxed text-muted">
                      {status === "loading"
                        ? "The model is still loading."
                        : "Your emoji appears here."}
                    </span>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void copyCode()}
                title="Copy the emoji name"
                className="mt-3 w-full truncate rounded-full bg-surface px-4 py-2 font-mono text-sm hover:bg-line"
              >
                {copied === "copy-code" ? "Copied" : shortcode}
              </button>
              <p className="mt-2 text-center font-mono text-[11px] text-muted">
                {shownPrompt ? `“${shownPrompt}”` : "Pick a preset, or write your own line."}
              </p>
            </div>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">
              47.6M params, 16 diffusion steps, 512 colour palette. The model unmasks the
              canvas a few pixels at a time, most confident first.
            </p>
          </div>
        </section>

        {/* Variants */}
        <section className="mt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-2xl font-bold tracking-tight">Specimens</h2>
            <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
              003, four variants, pick one
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {variants.map((v, i) => (
              <button
                key={i}
                type="button"
                disabled={!v || i >= made}
                onClick={() => selectVariant(i)}
                aria-label={`Variation ${i + 1}`}
                className={`flex flex-col items-center gap-2 rounded-2xl border bg-card p-4 transition-colors disabled:opacity-40 ${
                  i === selected && made > 0 ? "border-accent" : "border-line hover:border-ink"
                }`}
              >
                {v && palette ? (
                  <SpriteCanvas tokens={v.tokens} palette={palette} masked={v.masked} size={128} className="h-auto w-full max-w-[120px]" />
                ) : (
                  <span className="flex aspect-square w-full max-w-[120px] items-center justify-center rounded-lg bg-surface font-mono text-xs text-muted">
                    {busy && i < round ? "painting" : `0${i + 1}`}
                  </span>
                )}
                <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
                  {i === selected && made > 0 ? "selected" : `variant 0${i + 1}`}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Editor and export */}
        <section id="editor" className="mt-12 scroll-mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-2xl font-bold tracking-tight">The workbench</h2>
            <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
              004, fix it pixel by pixel
            </span>
          </div>
          <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 rounded-2xl border border-line bg-card p-4">
              {tokens && palette ? (
                <>
                  <canvas
                    ref={editorRef}
                    width={256}
                    height={256}
                    className="pixelated mx-auto block h-auto w-full max-w-[420px] cursor-crosshair touch-none rounded-lg bg-surface"
                    onPointerDown={onEditorDown}
                    onPointerMove={onEditorMove}
                    onPointerUp={onEditorUp}
                    onPointerLeave={onEditorUp}
                  />
                  <div className="mt-4 flex flex-wrap gap-2">
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
                  <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">
                    {tool === "brush" && "Click or drag to paint with the selected colour."}
                    {tool === "eyedropper" && "Click a pixel to pick its colour."}
                    {tool === "eraser" && "Click or drag to erase a pixel to transparent."}
                    {editorNote ? ` ${editorNote}` : ""}
                  </p>
                </>
              ) : (
                <p className="py-10 text-center font-mono text-xs leading-relaxed text-muted">
                  Generate an emoji first, or open one from your history below.
                </p>
              )}
            </div>

            <div className="min-w-0 space-y-4">
              <div className="rounded-2xl border border-line bg-card p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
                    Palette, 512 colours
                  </span>
                  <span className="font-mono text-[11px] text-muted">
                    {colorIdx === 0 ? "transparent" : `#${colorIdx}`}
                  </span>
                </div>
                <div className="scroll-thin mt-3 flex max-h-[180px] flex-wrap gap-1 overflow-y-auto pr-1">
                  {palette ? (
                    Array.from({ length: 512 }, (_, i) => {
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
                          className={`h-[18px] w-[18px] shrink-0 rounded-[4px] border ${
                            colorIdx === i ? "border-accent ring-2 ring-accent" : "border-line"
                          }`}
                        />
                      );
                    })
                  ) : (
                    <span className="font-mono text-xs text-muted">Palette loads with the model.</span>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <span
                    className="h-8 w-8 shrink-0 rounded-md border border-line"
                    style={{
                      background:
                        colorIdx === 0 || !palette
                          ? "repeating-conic-gradient(#d8d2c6 0% 25%, #faf8f4 0% 50%) 0 0 / 8px 8px"
                          : `rgba(${palette[colorIdx * 4]},${palette[colorIdx * 4 + 1]},${palette[colorIdx * 4 + 2]},${palette[colorIdx * 4 + 3] / 255})`,
                    }}
                  />
                  <span className="font-mono text-xs text-muted">
                    {colorIdx === 0
                      ? "Transparent, the eraser colour."
                      : `Colour ${colorIdx} of 512, the learned palette.`}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-line bg-card p-4">
                <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
                  Export
                </span>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => void downloadSelected()}
                    disabled={!tokens}
                    className="rounded-full bg-ink px-4 py-2.5 font-display text-sm font-semibold text-white disabled:opacity-40"
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
                  <button
                    type="button"
                    onClick={() => void copyCode()}
                    className="rounded-full border border-line bg-card px-4 py-2.5 font-display text-sm font-semibold"
                  >
                    {copied === "copy-code" ? "Copied" : "Copy shortcode"}
                  </button>
                </div>
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">
                  PNG is 128 by 128, crisp pixels, ready for Slack. Shortcode is {shortcode}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* History */}
        <section className="mt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-2xl font-bold tracking-tight">Your shelf</h2>
            <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
              005, saved on this device only
            </span>
          </div>
          {history.length === 0 ? (
            <p className="mt-4 rounded-2xl border border-dashed border-line p-6 text-sm text-muted">
              Nothing here yet. Generate an emoji and the selected one joins the shelf.
            </p>
          ) : (
            <div className="scroll-thin mt-4 flex gap-3 overflow-x-auto pb-2">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="w-[132px] shrink-0 rounded-2xl border border-line bg-card p-3"
                >
                  <button
                    type="button"
                    onClick={() => openHistory(item)}
                    className="block w-full text-left"
                    title={`Open ${item.code}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.dataUrl}
                      alt={item.prompt}
                      width={128}
                      height={128}
                      className="pixelated h-auto w-full rounded-lg bg-surface"
                    />
                    <span className="mt-2 block truncate font-mono text-[11px]">{item.code}</span>
                    <span className="block truncate text-xs text-muted">{item.prompt}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeHistory(item.id)}
                    className="mt-1 font-mono text-[11px] text-muted hover:text-accent"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Credits */}
        <footer className="mt-16 border-t border-line pt-6">
          <p className="text-sm leading-relaxed text-muted">
            Tessera-small by Jagrat Patel (TheJagStudio), CC BY-NC 4.0, a non commercial
            demo. CLIP text encoder by OpenAI, MIT.
          </p>
          <p className="mt-2 text-sm leading-relaxed">
            <a
              className="underline underline-offset-2 hover:text-accent"
              href="https://huggingface.co/thejagstudio/tessera-small"
              target="_blank"
              rel="noopener"
            >
              thejagstudio/tessera-small
            </a>
            {" · "}
            <a
              className="underline underline-offset-2 hover:text-accent"
              href="https://huggingface.co/spaces/cfahlgren1/slack-moji"
              target="_blank"
              rel="noopener"
            >
              the original Slack Moji Space by cfahlgren1
            </a>
          </p>
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted">
            All generation runs in your browser. No prompt or image leaves your device.
          </p>
        </footer>
      </main>
    </div>
  );
}
