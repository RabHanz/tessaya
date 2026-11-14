/**
 * The assistant's "now" (D149). Samples the foreground window only while its switch is on, keeps a
 * short rolling window in memory (nothing on disk), and says it as data for the context line.
 */
import {
  anyAwareness,
  describeNow,
  pushSample,
  redactWindow,
  type AwarenessSample,
  type AwarenessSwitches,
} from "@t3tools/tessaya-shared/awareness";

export interface AwarenessSources {
  readonly switches: () => AwarenessSwitches;
  /** "notepad.exe: notes.txt", the same label the screen companion uses. */
  readonly foreground: () => Promise<string | null>;
  readonly idleSeconds: () => number | null;
  readonly focusSession: () => string | null;
  readonly runningJobs: () => ReadonlyArray<string>;
  readonly doing: () => ReadonlyArray<string>;
  readonly now: () => number;
}

export const createAwareness = (src: AwarenessSources) => {
  let samples: ReadonlyArray<AwarenessSample> = [];
  const sample = async (): Promise<void> => {
    const switches = src.switches();
    if (!switches.window) {
      samples = [];
      return;
    }
    const label = await src.foreground().catch(() => null);
    if (label === null) return;
    const at = label.indexOf(": ");
    const { app, title } = redactWindow(
      at < 0 ? label : label.slice(0, at),
      at < 0 ? "" : label.slice(at + 2),
    );
    samples = pushSample(samples, { at: src.now(), app, title });
  };
  return {
    sample,
    active: (): boolean => anyAwareness(src.switches()),
    describe: async (): Promise<string> => {
      const switches = src.switches();
      if (!anyAwareness(switches)) return "";
      await sample();
      return describeNow({
        switches,
        samples,
        now: src.now(),
        idleSeconds: switches.idle ? src.idleSeconds() : null,
        focusSession: switches.focus ? src.focusSession() : null,
        runningJobs: switches.jobs ? src.runningJobs() : [],
        doing: src.doing(),
      });
    },
  };
};
