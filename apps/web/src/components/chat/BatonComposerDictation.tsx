/**
 * Dictation inside the chat box: the words at the caret over the (unchanged) draft, and a small control centred in
 * the footer in the chosen pill design (tessaya-ops drafts/pill-styles composer.html).
 */
import {
  draftAround,
  liveWords,
  spacingAt,
  showsActions,
  type ComposerDictation,
  type PillDesign,
  type WaveName,
  parseColour,
} from "@t3tools/baton-shared/composerDictation";
import { waveEngine, type Rgb } from "@t3tools/baton-shared/waveform";
import { useEffect, useRef, type RefObject } from "react";

import "./BatonComposerDictation.css";

const W = 64;
const H = 18;
const ENGINE = waveEngine();

const dictating = (state: ComposerDictation) => state.phase !== "idle";

/** Spread on the editor's wrapper and the footer: they hide what the dictation covers. */
export const dictatingAttribute = (state: ComposerDictation) =>
  dictating(state) ? { "data-tessaya-dictating": "true" } : {};

/** Over the editor, the same type: the draft before the caret, the words, the caret, the draft after it. */
export function BatonDictationWords(props: { readonly state: ComposerDictation }) {
  const { state } = props;
  const caretRef = useRef<HTMLSpanElement>(null);
  const count = state.phase === "listening" || state.phase === "working" ? state.heard.length : 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the caret in view inside the clipped overlay as words arrive
  useEffect(() => {
    caretRef.current?.scrollIntoView({ block: "nearest" });
  }, [count]);
  if (state.phase === "idle") return null;
  const { before, after } = draftAround(state.base);
  const { lead, tail } = spacingAt(state.base);
  const words =
    state.phase === "settling"
      ? state.words.map((w) => ({
          text: w.text,
          className: w.kind === "gone" ? "gone" : w.kind === "new" ? "added" : "",
        }))
      : (state.phase === "cancelling" ? state.words : liveWords(state)).map((w) => ({
          text: w.text,
          className: state.phase === "cancelling" ? "gone" : `new ${w.tone}`,
        }));
  return (
    <div
      aria-live="polite"
      aria-label="Dictation"
      className="tdc-root tdc-words font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) leading-relaxed max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
    >
      {before}
      {words.length > 0 ? lead : null}
      {words.map((w, i) => (
        // Words only grow at the end while he speaks, so the index keeps each one's entrance once.
        <span key={i} className={`tdc-w ${w.className}`}>
          {i === words.length - 1 ? w.text : `${w.text} `}
        </span>
      ))}
      {state.phase === "settling" ? null : <span ref={caretRef} className="tdc-caret" />}
      {words.length > 0 ? tail : null}
      {after}
    </div>
  );
}

const rgbOf = (css: string): Rgb => {
  const [r, g, b] = parseColour(css);
  return [r, g, b];
};

/** The design's waveform, drawn from the microphone's level; only while he can be heard is it drawn each frame. */
function Waveform(props: {
  readonly wave: WaveName;
  readonly level: RefObject<number>;
  readonly live: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { wave, level, live } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the canvas from requestAnimationFrame while the microphone is open
  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = W * ratio;
    canvas.height = H * ratio;
    const L = ENGINE.createLevel();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let colours = { c1: [0, 0, 0] as Rgb, c2: [0, 0, 0] as Rgb, c3: [0, 0, 0] as Rgb, dark: false };
    const readColours = () => {
      const style = getComputedStyle(canvas);
      const c1 = rgbOf(style.color);
      const c2 = rgbOf(style.borderTopColor);
      colours = { c1, c2, c3: c2, dark: document.documentElement.classList.contains("dark") };
    };
    let frame = 0;
    let last = performance.now();
    let raf = 0;
    const draw = (t: number) => {
      // The theme can change under it; its colours are read again twice a second, not every frame.
      if (frame++ % 30 === 0) readColours();
      L.tick(ENGINE.dbOf(live ? level.current : 0), (t - last) / 1000);
      last = t;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, W, H);
      ENGINE[wave](g, W, H, live && !reduced ? L.at : () => 0, "dict", colours, t);
    };
    if (!live || reduced) {
      draw(last);
      return;
    }
    const loop = (t: number) => {
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [wave, level, live]);
  return <canvas ref={ref} aria-hidden="true" width={W} height={H} />;
}

const X_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const CHECK_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3.2 8.6l3.1 3.1 6.5-7"
      stroke="currentColor"
      strokeWidth="2"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Centred in the footer. Key held: the waveform only; hands-free or a tap: ✕ / waveform / ✓. */
export function BatonDictationControl(props: {
  readonly state: ComposerDictation;
  readonly design: PillDesign;
  readonly wave: WaveName;
  readonly level: RefObject<number>;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const { state } = props;
  if (state.phase === "idle") return null;
  const actions = showsActions(state);
  const leaving = state.phase === "settling" || state.phase === "cancelling";
  return (
    <div
      role="group"
      aria-label="Dictation"
      data-design={props.design}
      className={`tdc-root tdc ${actions ? "free" : "held"}${leaving ? " sink" : ""}`}
    >
      {actions ? (
        <button
          type="button"
          className="no"
          aria-label="Discard (Esc)"
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onCancel}
        >
          {X_ICON}
        </button>
      ) : null}
      <Waveform wave={props.wave} level={props.level} live={state.phase === "listening"} />
      {actions ? (
        <button
          type="button"
          className="ok"
          aria-label={state.phase === "working" ? "Insert without tidying" : "Insert"}
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onConfirm}
        >
          {CHECK_ICON}
        </button>
      ) : null}
    </div>
  );
}
