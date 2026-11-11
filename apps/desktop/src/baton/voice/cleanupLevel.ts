// @effect-diagnostics globalTimers:off -- one timer bounds a helper question on the release path
import { strictestCleanup } from "@t3tools/baton-shared/dictationCleanup";

type App = { readonly exe: string; readonly title: string };

/**
 * The clean-up level for a dictation now. Only "claude" can be stepped down by the window in front (a password manager
 * or a bank), so only then is the helper asked which window that is; it can take up to `waitMs`, which "local" and
 * "off" never wait for.
 */
export const cleanupLevelNow = async <Level extends string>(
  setting: Level | "local",
  spokenIn: App,
  foreground: () => Promise<App | null>,
  waitMs: number,
): Promise<Level | "local"> => {
  if (setting !== "claude") return strictestCleanup(setting, [spokenIn]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = await Promise.race([
    foreground().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    }),
  ]);
  clearTimeout(timer);
  return strictestCleanup(setting, [spokenIn, now ?? { exe: "", title: "" }]);
};
