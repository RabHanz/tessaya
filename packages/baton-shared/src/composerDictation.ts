/**
 * Dictation inside the chat box (tessaya-ops drafts/pill-styles composer.html), one copy for web and mobile. Pure.
 *
 * The draft is never touched while he speaks: the live words are drawn over it at the caret, so ✕ or Esc gives back
 * exactly what was there. The cleaned words go in once, in one commit, while the settle plays over them.
 */

export type DictationMode = "held" | "free";

export interface DictationDraft {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
}

/** `tentative`: the recogniser may still change it, drawn muted. `struck`: a spoken correction took it back. */
export type LiveTone = "firm" | "tentative" | "struck";
export interface LiveWord {
  readonly text: string;
  readonly tone: LiveTone;
}

/** The settle: `keep` stays (its case and punctuation fixed), `gone` blurs out, `new` the clean-up added. */
export type SettleKind = "keep" | "gone" | "new";
export interface SettleWord {
  readonly text: string;
  readonly kind: SettleKind;
}

interface Heard {
  readonly mode: DictationMode;
  readonly base: DictationDraft;
  /** Everything heard so far; `tentative` is its unsettled tail when the recogniser says which it is. */
  readonly heard: string;
  readonly tentative: string | null;
  readonly paused: boolean;
}

export type ComposerDictation =
  | { readonly phase: "idle" }
  /** The microphone is open. */
  | ({ readonly phase: "listening" } & Heard)
  /** Released or ✓: the words are being written out and cleaned. */
  | ({ readonly phase: "working" } & Heard)
  /** The cleaned words are in the draft (`committed`); the old ones blur out over them. */
  | {
      readonly phase: "settling";
      readonly base: DictationDraft;
      readonly committed: DictationDraft;
      readonly words: ReadonlyArray<SettleWord>;
    }
  /** ✕ or Esc: the live words fade and the draft was never changed. */
  | {
      readonly phase: "cancelling";
      readonly base: DictationDraft;
      readonly words: ReadonlyArray<LiveWord>;
    };

export type ComposerDictationEvent =
  | { readonly type: "start"; readonly mode: DictationMode; readonly base: DictationDraft }
  /** A double tap latched a held key: it is hands-free now. */
  | { readonly type: "mode"; readonly mode: DictationMode }
  | { readonly type: "heard"; readonly text: string; readonly tentative?: string | null }
  | { readonly type: "pause" }
  | { readonly type: "finish" }
  /** The cleaned words; `committed` when the caller already placed them in the draft. */
  | { readonly type: "final"; readonly text: string; readonly committed?: DictationDraft }
  | { readonly type: "cancel" }
  /** The settle or the fade has played. */
  | { readonly type: "done" };

export const IDLE_DICTATION: ComposerDictation = { phase: "idle" };

/** How long the settle and the cancel fade play before the composer is plain again. */
export const SETTLE_MS = 380;
export const CANCEL_MS = 200;
/** No new words for this long is a pause: a spoken correction is struck through then. */
export const PAUSE_MS = 600;

export const stepDictation = (
  state: ComposerDictation,
  event: ComposerDictationEvent,
): ComposerDictation => {
  switch (event.type) {
    case "start":
      return {
        phase: "listening",
        mode: event.mode,
        base: event.base,
        heard: "",
        tentative: null,
        paused: false,
      };
    case "mode":
      return state.phase === "listening" ? { ...state, mode: event.mode } : state;
    case "heard":
      return state.phase === "listening" || state.phase === "working"
        ? { ...state, heard: event.text, tentative: event.tentative ?? null, paused: false }
        : state;
    case "pause":
      return state.phase === "listening" || state.phase === "working"
        ? { ...state, paused: true }
        : state;
    case "finish":
      return state.phase === "listening" ? { ...state, phase: "working", paused: true } : state;
    case "final": {
      if (state.phase !== "listening" && state.phase !== "working") return state;
      if (event.text.trim() === "") return { phase: "cancelling", base: state.base, words: [] };
      return {
        phase: "settling",
        base: state.base,
        committed: event.committed ?? insertWords(state.base, event.text.trim()),
        words: settleWords(state.heard, event.text.trim()),
      };
    }
    case "cancel":
      return state.phase === "listening" || state.phase === "working"
        ? { phase: "cancelling", base: state.base, words: liveWords(state) }
        : state;
    case "done":
      return state.phase === "settling" || state.phase === "cancelling" ? IDLE_DICTATION : state;
  }
};

/** The control shows ✕ and ✓ unless the key is held: letting go is the commit then. */
export const showsActions = (state: ComposerDictation): boolean =>
  (state.phase === "listening" || state.phase === "working") && state.mode === "free";

/** What the composer draws over the editor: the draft before the caret, the words, and the draft after it. */
export const draftAround = (base: DictationDraft) => {
  const start = Math.max(0, Math.min(base.selection.start, base.text.length));
  const end = Math.max(start, Math.min(base.selection.end, base.text.length));
  return { before: base.text.slice(0, start), after: base.text.slice(end) };
};

/** The space words at this caret need either side, so they never touch the draft's own. */
export const spacingAt = (base: DictationDraft) => {
  const { before, after } = draftAround(base);
  return {
    lead: before !== "" && !/\s$/.test(before) ? " " : "",
    tail: after !== "" && !/^[\s.,;:!?)]/.test(after) ? " " : "",
  };
};

/** The words at `base`'s caret (in place of its selection), one space either side where words would touch. */
export const insertWords = (base: DictationDraft, words: string): DictationDraft => {
  const { before, after } = draftAround(base);
  const { lead, tail } = spacingAt(base);
  const inserted = `${lead}${words}${tail}`;
  const caret = before.length + lead.length + words.length;
  return { text: before + inserted + after, selection: { start: caret, end: caret } };
};

const split = (text: string) => text.split(/\s+/).filter((w) => w !== "");
const bare = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Spoken take-backs (as dictationCleanup.ts CORRECTION_MARK reads them), as bare words. */
const MARKERS = [
  ["scratch", "that"],
  ["strike", "that"],
  ["no", "wait"],
  ["no", "actually"],
  ["actually", "no"],
  ["or", "rather"],
  ["make", "that"],
  ["i", "mean"],
  ["sorry"],
] as const;
/** At most this many words before a marker are struck: the cleanup's own reach is wider, the line stays honest. */
const STRUCK_BACK = 4;

/**
 * Which words a spoken correction took back: the marker and as many words before it as he said after it (one at
 * least, four at most). Only at a pause, when what he settled on has been heard.
 */
export const struckWords = (words: ReadonlyArray<string>): ReadonlySet<number> => {
  const out = new Set<number>();
  const b = words.map(bare);
  let floor = 0;
  for (let i = 0; i < b.length; i++) {
    const marker = MARKERS.find((m) => m.every((w, k) => b[i + k] === w));
    if (marker === undefined || i === 0) continue;
    const end = i + marker.length;
    const after = b.length - end;
    if (after === 0) break;
    const back = Math.max(1, Math.min(STRUCK_BACK, after, i - floor));
    for (let k = i - back; k < end; k++) out.add(k);
    floor = end;
    i = end - 1;
  }
  return out;
};

/** The words drawn while he speaks: the unsettled tail muted (the last two when the recogniser does not say). */
export const liveWords = (state: Heard): ReadonlyArray<LiveWord> => {
  const tentative = state.tentative === null ? [] : split(state.tentative);
  const all = [...split(state.heard), ...tentative];
  const firstTentative = state.tentative === null ? all.length - 2 : all.length - tentative.length;
  const struck = state.paused ? struckWords(all) : new Set<number>();
  return all.map((text, i) => ({
    text,
    tone: struck.has(i) ? "struck" : i >= firstTentative ? "tentative" : "firm",
  }));
};

/**
 * The heard words against the cleaned ones, in order: a word in both keeps the cleaned spelling (its case and
 * punctuation), a heard word the clean-up dropped is `gone`, and a word only the clean-up has is `new`.
 */
export const settleWords = (heard: string, final: string): ReadonlyArray<SettleWord> => {
  const a = split(heard);
  const b = split(final);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        bare(a[i]!) !== "" && bare(a[i]!) === bare(b[j]!)
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: SettleWord[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && bare(a[i]!) !== "" && bare(a[i]!) === bare(b[j]!)) {
      out.push({ text: b[j]!, kind: "keep" });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push({ text: b[j]!, kind: "new" });
      j++;
    } else {
      out.push({ text: a[i]!, kind: "gone" });
      i++;
    }
  }
  return out;
};

export const PILL_DESIGNS = ["tessaya", "quiet", "lively"] as const;
export type PillDesign = (typeof PILL_DESIGNS)[number];
export const PILL_WAVES = ["match", "mound", "bars", "beads"] as const;
export type PillWave = (typeof PILL_WAVES)[number];
export type WaveName = Exclude<PillWave, "match">;

export const parsePillDesign = (v: unknown): PillDesign =>
  PILL_DESIGNS.find((d) => d === v) ?? "tessaya";
export const parsePillWave = (v: unknown): PillWave => PILL_WAVES.find((w) => w === v) ?? "match";
/** "Match the design": each design's own waveform. */
export const waveFor = (design: PillDesign, wave: PillWave): WaveName =>
  wave !== "match" ? wave : design === "quiet" ? "bars" : design === "lively" ? "beads" : "mound";

export interface PillRoles {
  readonly canvas: string;
  readonly surfaceOverlay: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly warning: string;
}

export interface PillTokens {
  readonly surface: string;
  /** The hairline round a one-island design; null for Lively's pebbles. */
  readonly hairline: string | null;
  readonly fg: string;
  readonly fg2: string;
  readonly ok: string;
  readonly onOk: string;
  readonly wave: string;
  readonly wave2: string;
}

export type Rgba = readonly [number, number, number, number];

/** #rgb, #rrggbb(aa), rgb()/rgba() and color(srgb …); anything else reads as transparent. */
export const parseColour = (input: string): Rgba => {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)?.[1];
  if (hex !== undefined) {
    const full =
      hex.length <= 4
        ? [...hex].map((c) => c + c).join("")
        : hex.length === 6 || hex.length === 8
          ? hex
          : "";
    if (full === "") return [0, 0, 0, 0];
    const at = (k: number) => Number.parseInt(full.slice(k, k + 2), 16);
    return [at(0), at(2), at(4), full.length === 8 ? at(6) / 255 : 1];
  }
  const fn = /^(rgba?|color)\(([^)]*)\)$/.exec(s);
  if (fn === null) return [0, 0, 0, 0];
  const parts = fn[2]!
    .replace(/^srgb\s+/, "")
    .split(/[\s,/]+/)
    .filter(Boolean);
  const num = (p: string | undefined, scale: number) =>
    p === undefined
      ? 1
      : p.endsWith("%")
        ? (Number.parseFloat(p) / 100) * scale
        : Number.parseFloat(p) * (fn[1] === "color" ? scale : 1);
  const [r, g, b, a] = [
    num(parts[0], 255),
    num(parts[1], 255),
    num(parts[2], 255),
    num(parts[3], 1),
  ];
  return [r, g, b, fn[1] === "color" && parts[3] !== undefined ? a : Math.min(1, a)];
};

const css = ([r, g, b, a]: Rgba) =>
  `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Number(a.toFixed(3))})`;

/** CSS `color-mix(in srgb, a pct%, b)`, premultiplied as the spec mixes it. */
export const mixColour = (a: string, pct: number, b: string): string => {
  const x = parseColour(a);
  const y = parseColour(b === "transparent" ? "#0000" : b);
  const p = pct / 100;
  const alpha = x[3] * p + y[3] * (1 - p);
  if (alpha === 0) return "rgba(0,0,0,0)";
  const ch = (k: 0 | 1 | 2) => (x[k] * x[3] * p + y[k] * y[3] * (1 - p)) / alpha;
  return css([ch(0), ch(1), ch(2), alpha]);
};

/** The chat-box control's colours in each design (composer.html's tokens), from the theme's roles. */
export const pillTokens = (design: PillDesign, r: PillRoles): PillTokens => {
  if (design === "quiet")
    return {
      surface: mixColour(r.text, 6, "transparent"),
      hairline: mixColour(r.text, 12, "transparent"),
      fg: r.text,
      fg2: r.textMuted,
      ok: r.text,
      onOk: r.canvas,
      wave: r.text,
      wave2: r.text,
    };
  if (design === "lively")
    return {
      surface: mixColour(r.accent, 16, r.surfaceOverlay),
      hairline: null,
      fg: r.text,
      fg2: r.text,
      ok: r.accent,
      onOk: r.accentForeground,
      wave: r.accent,
      wave2: r.warning,
    };
  return {
    surface: mixColour(r.accent, 9, r.surfaceOverlay),
    hairline: mixColour(r.text, 14, "transparent"),
    fg: r.text,
    fg2: r.textMuted,
    ok: r.accent,
    onOk: r.accentForeground,
    wave: r.accent,
    wave2: mixColour(r.accent, 50, r.text),
  };
};
