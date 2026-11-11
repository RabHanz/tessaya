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
} from "@t3tools/baton-shared/composerDictation";
import { waveEngine, type Rgb } from "@t3tools/baton-shared/waveform";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the caret in view inside the clipped overlay as words arrive
  useLayoutEffect(() => {
    caretRef.current?.scrollIntoView({ block: "nearest" });
  });
  if (state.phase === "idle") return null;
  const { before, after } = draftAround(state.base);
  const { lead, tail } = spacingAt(state.base);
  const live = state.phase === "listening" || state.phase === "working";
  // Words only grow at the end while he speaks, so a word's place is its identity and its entrance plays once.
  const words =
    state.phase === "settling"
      ? state.words.map((w, at) => ({ at, text: w.text, look: w.kind as string }))
      : (state.phase === "cancelling" ? state.words : liveWords(state)).map((w, at) => ({
          at,
          text: w.text,
          look: state.phase === "cancelling" ? "gone" : (w.tone as string),
        }));
  return (
    <div
      aria-live="polite"
      aria-label="Dictation"
      data-tdc-words=""
      className="font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) leading-relaxed max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
    >
      {before}
      {words.length > 0 ? lead : null}
      {words.map((w) => (
        <span key={w.at} data-tdc-w={w.look} data-live={live ? "" : undefined}>
          {w.at === words.length - 1 ? w.text : `${w.text} `}
        </span>
      ))}
      {state.phase === "settling" ? null : <span ref={caretRef} data-tdc-caret="" />}
      {words.length > 0 ? tail : null}
      {after}
    </div>
  );
}

/** Any CSS colour as sRGB: the browser converts it (oklch, color-mix) by painting one pixel. */
const probe =
  typeof document === "undefined"
    ? null
    : document.createElement("canvas").getContext("2d", { willReadFrequently: true });
const rgbOf = (css: string): Rgb => {
  if (probe === null) return [0, 0, 0];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
};

/** Draws the design's waveform into `canvas`; while `live`, every frame from the level, else once, still. */
const drawWave = (
  canvas: HTMLCanvasElement,
  wave: WaveName,
  level: RefObject<number>,
  live: boolean,
): (() => void) => {
  const g = canvas.getContext("2d");
  if (g === null) return () => undefined;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = W * ratio;
  canvas.height = H * ratio;
  const L = ENGINE.createLevel();
  const moving = live && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clock = { frame: 0, last: performance.now(), raf: 0 };
  let colours = { c1: [0, 0, 0] as Rgb, c2: [0, 0, 0] as Rgb, c3: [0, 0, 0] as Rgb, dark: false };
  const draw = (t: number) => {
    // The theme can change under it; its colours are read again twice a second, not every frame.
    if (clock.frame++ % 30 === 0) {
      const style = getComputedStyle(canvas);
      const c2 = rgbOf(style.borderTopColor);
      const dark = document.documentElement.classList.contains("dark");
      colours = { c1: rgbOf(style.color), c2, c3: c2, dark };
    }
    L.tick(ENGINE.dbOf(live ? level.current : 0), (t - clock.last) / 1000);
    clock.last = t;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);
    ENGINE[wave](g, W, H, moving ? L.at : () => 0, "dict", colours, t);
  };
  draw(clock.last);
  if (!moving) return () => undefined;
  const loop = (t: number) => {
    draw(t);
    clock.raf = requestAnimationFrame(loop);
  };
  clock.raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(clock.raf);
};

function Waveform(props: {
  readonly wave: WaveName;
  readonly level: RefObject<number>;
  readonly live: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { wave, level, live } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the canvas from requestAnimationFrame while the microphone is open
  useEffect(() => {
    if (ref.current !== null) return drawWave(ref.current, wave, level, live);
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
      data-tdc={actions ? "free" : "held"}
      data-design={props.design}
      data-leaving={leaving ? "" : undefined}
    >
      {actions ? (
        <button
          type="button"
          data-part="no"
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
          data-part="ok"
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
