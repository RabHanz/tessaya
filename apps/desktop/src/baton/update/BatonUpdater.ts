// @effect-diagnostics globalTimers:off globalDate:off
/**
 * Glue between upstream's updater state and Baton's window (D137, D139). A downloaded update starts
 * a visible countdown; the window and a notification say Baton is about to restart itself, he can
 * cut it short or put it off, and the restart waits for a quiet moment. The reopened window says it
 * is back. The rules are in `updatePlan.ts` and `updateLogic.ts`.
 */
import type { DesktopUpdateState } from "@t3tools/contracts";

import type { HomeControl } from "../home/batonHome.ts";
import {
  isReady,
  shouldDownload,
  updateControls,
  canInstallNow,
  type UpdateBusy,
} from "./updateLogic.ts";
import { COUNTDOWN_MS, nextStep, SNOOZE_MS, type Phase } from "./updatePlan.ts";

export interface BatonUpdates {
  readonly controls: () => ReadonlyArray<HomeControl>;
  readonly apply: (id: string) => void;
  /** An update is downloaded and waiting, for the dot on the tray. */
  readonly ready: () => boolean;
  /** The tray's entry: restart now, at the first quiet moment. Nothing when no update is downloaded. */
  readonly install: () => void;
  /** Lifts a Later, so a downloaded update gets its countdown at the next quiet moment. */
  readonly soon: () => void;
}

const TICK_MS = 1_000;

export const createBatonUpdater = (input: {
  readonly initial: DesktopUpdateState;
  readonly check: () => Promise<unknown>;
  readonly download: () => Promise<unknown>;
  /** Writes why Baton is going down, then installs and relaunches. */
  readonly install: (version: string) => Promise<unknown>;
  readonly busy: () => UpdateBusy;
  /** The heads-up: open the window and raise a notification. */
  readonly headsUp: (version: string, restartAt: number) => void;
  /** Said once, after a restart that was an update. */
  readonly backAfter: string | null;
  readonly onChange: () => void;
  /** A version that failed to start twice: never downloaded or installed again by itself. */
  readonly skip?: (version: string) => boolean;
}): BatonUpdates & { readonly onState: (state: DesktopUpdateState) => void } => {
  let state = input.initial;
  let phase: Phase = { kind: "idle" };
  let restartNow = false;
  let installing = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const quiet = () => canInstallNow(input.busy());
  const usable = (s: DesktopUpdateState): boolean => {
    const v = s.downloadedVersion ?? s.availableVersion;
    return v === null || !(input.skip?.(v) ?? false);
  };

  const tick = () => {
    if (installing) return;
    const step = nextStep({
      ready: isReady(state) && usable(state),
      quiet: quiet(),
      now: Date.now(),
      phase,
      restartNow,
    });
    if (step === "start-countdown") {
      phase = { kind: "countdown", restartAt: Date.now() + COUNTDOWN_MS };
      input.headsUp(state.downloadedVersion ?? "", phase.restartAt);
      input.onChange();
    } else if (step === "install") {
      installing = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      void input.install(state.downloadedVersion ?? "").finally(() => {
        // Still running means it failed: wait as for Later, or the countdown loops every 31 s.
        installing = false;
        phase = { kind: "snoozed", until: Date.now() + SNOOZE_MS };
        restartNow = false;
        ensureTimer();
        input.onChange();
      });
    }
  };

  const ensureTimer = () => {
    if (timer !== null || !isReady(state) || !usable(state)) return;
    timer = setInterval(tick, TICK_MS);
    timer.unref();
  };

  return {
    onState: (next) => {
      state = next;
      if (shouldDownload(next) && usable(next)) void input.download();
      if (isReady(next) && usable(next)) {
        ensureTimer();
        tick();
      }
      input.onChange();
    },
    controls: () =>
      updateControls(
        state,
        false,
        phase.kind === "countdown" || restartNow
          ? {
              restartAt: phase.kind === "countdown" ? phase.restartAt : Date.now(),
              waiting: !quiet(),
              inFlight: input.busy().inFlight,
            }
          : null,
        input.backAfter,
      ),
    ready: () => isReady(state),
    install: () => {
      // Remembered with nothing ready, a later download would install with no countdown.
      if (!isReady(state)) return;
      restartNow = true;
      tick();
      input.onChange();
    },
    soon: () => {
      if (phase.kind === "snoozed") phase = { kind: "idle" };
      tick();
      input.onChange();
    },
    apply: (id) => {
      if (id === "u.act:later") {
        restartNow = false;
        phase = { kind: "snoozed", until: Date.now() + SNOOZE_MS };
        input.onChange();
      } else if (id !== "u.act") return;
      else if (isReady(state)) {
        restartNow = true;
        tick();
        input.onChange();
      } else if (state.status === "available" || (state.status === "error" && state.canRetry)) {
        void input.download();
      } else void input.check();
    },
  };
};
