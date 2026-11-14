/**
 * When Baton restarts itself to install (D139). He is told first, with a countdown he can cut short
 * or put off, and the restart never lands in the middle of a turn. Pure, so the order is testable.
 */
export const COUNTDOWN_MS = 30_000;
/** "Later" asks again after this long. */
export const SNOOZE_MS = 4 * 60 * 60_000;

export type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "countdown"; readonly restartAt: number }
  | { readonly kind: "snoozed"; readonly until: number };

export type Step = "none" | "start-countdown" | "install" | "wait-for-quiet";

/**
 * What to do now. An update that is downloaded starts the countdown the first quiet moment; the
 * countdown ends in the restart only if Baton is still quiet, otherwise it waits.
 */
export const nextStep = (input: {
  readonly ready: boolean;
  readonly quiet: boolean;
  readonly now: number;
  readonly phase: Phase;
  /** He pressed Restart now: no countdown, but still not mid-turn. */
  readonly restartNow: boolean;
}): Step => {
  if (!input.ready) return "none";
  if (input.restartNow) return input.quiet ? "install" : "wait-for-quiet";
  const { phase, now, quiet } = input;
  if (phase.kind === "snoozed" && now < phase.until) return "none";
  if (phase.kind === "countdown") {
    if (now < phase.restartAt) return "none";
    return quiet ? "install" : "wait-for-quiet";
  }
  return quiet ? "start-countdown" : "none";
};
