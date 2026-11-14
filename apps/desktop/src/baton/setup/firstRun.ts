/**
 * The tour: the few steps to a first success, each reusing a window control. Everything else comes later as one tip
 * at a time (`LEARN_ITEMS`). No step is required; it reopens where it was left. A fresh install opens it; an
 * existing one is offered it once on Home.
 */
import { DESKTOP_HOLD_KEYS } from "@t3tools/tessaya-contracts";
import type { HomeControl } from "../home/batonHome.ts";
import { text } from "../home/strings.ts";

export interface SetupStep {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** Controls of the window drawn in the step; `v.wake:` matches every wake word. */
  readonly controls: ReadonlyArray<string>;
  /** Draw the live microphone level. */
  readonly meter?: boolean;
  /** Draw a box to try dictation in. */
  readonly tryBox?: boolean;
  /** Plain facts drawn as rows under the text: what always asks, the tray menu, how to stop. */
  readonly facts?: ReadonlyArray<{ readonly label: string; readonly hint: string }>;
}

const STEPS: ReadonlyArray<
  Omit<SetupStep, "title" | "text" | "facts"> & { readonly facts?: number }
> = [
  { id: "welcome", controls: [] },
  { id: "mic", controls: ["v.enabled", "v.mic"], meter: true },
  { id: "key", controls: ["setup.hold"] },
  { id: "try", controls: [], tryBox: true },
  { id: "assistant", controls: ["s.brain", "s.brainCheck"] },
];

export const SETUP_STEPS: ReadonlyArray<SetupStep> = STEPS.map(({ facts, ...s }) => ({
  ...s,
  title: text(`setup.${s.id}.title`),
  text: text(`setup.${s.id}.text`),
  ...(facts === undefined
    ? {}
    : {
        facts: Array.from({ length: facts }, (_, n) => ({
          label: text(`setup.${s.id}.fact${n + 1}`),
          hint: text(`setup.${s.id}.fact${n + 1}.hint`),
        })),
      }),
}));

export const HOLD_KEY_CHOICES: ReadonlyArray<string> = DESKTOP_HOLD_KEYS;

export const setupHoldControl = (current: string): HomeControl => ({
  id: "setup.hold",
  section: text("setup.section"),
  label: text("setup.hold.label"),
  kind: "choice",
  value: HOLD_KEY_CHOICES.includes(current) ? current : "",
  options: [
    ...(HOLD_KEY_CHOICES.includes(current)
      ? []
      : [{ value: "", label: text("setup.hold.own", { key: current }) }]),
    ...HOLD_KEY_CHOICES.map((k) => ({ value: k, label: k })),
  ],
});

export interface SetupMemory {
  /** Installed this run and the tour never finished or skipped. */
  readonly freshInstall: boolean;
  readonly done?: boolean;
  /** An existing install was shown the offer on Home and answered it. */
  readonly offered?: boolean;
  /** The step it was left on. */
  readonly step?: number;
}

/**
 * "open": a fresh install starts in the tour. "offer": an install from before the tour existed gets one card on Home,
 * once. Finishing, skipping or answering the card ends both; nothing ever opens it again by itself.
 */
export const setupMode = (m: SetupMemory): "open" | "offer" | "none" =>
  m.done === true ? "none" : m.freshInstall ? "open" : m.offered === true ? "none" : "offer";

/** Where the tour reopens: the step it was left on, kept inside the tour. */
export const resumeStep = (m: SetupMemory, steps: number): number =>
  m.done === true || m.step === undefined || !Number.isInteger(m.step)
    ? 0
    : Math.max(0, Math.min(steps - 1, m.step));

/** A level from 0 to 1 for the meter; quiet speech still moves it. */
export const meterWidth = (level: number): number =>
  Math.round(Math.min(1, Math.max(0, Math.sqrt(level) * 1.6)) * 100);
