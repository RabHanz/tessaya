// @effect-diagnostics globalTimers:off -- one timer bounds a helper question on the release path
import { strictestCleanup } from "@t3tools/tessaya-shared/dictationCleanup";

type App = { readonly exe: string; readonly title: string };

/**
 * The clean-up level for a dictation now, and why it is below the setting when it is. Only "claude" can be stepped down
 * by the window in front (a password manager or a bank), so only then is the helper asked which window that is; it can
 * take up to `waitMs`, which "local" and "off" never wait for. A helper too slow to answer leaves the window the words
 * were spoken in to decide, so a slow check never quietly drops the model.
 */
export const cleanupLevelNow = async <Level extends string>(
  setting: Level | "local",
  spokenIn: App,
  foreground: () => Promise<App | null>,
  waitMs: number,
): Promise<{ readonly level: Level | "local"; readonly why: string | null }> => {
  if (setting !== "claude") return stepped(setting, [spokenIn]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = await Promise.race([
    foreground().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    }),
  ]);
  clearTimeout(timer);
  return stepped(setting, now === null ? [spokenIn] : [spokenIn, now]);
};

const stepped = <Level extends string>(setting: Level | "local", apps: ReadonlyArray<App>) => {
  const level = strictestCleanup(setting, apps);
  if (level === setting) return { level, why: null };
  const app = apps.find((a) => strictestCleanup(setting, [a]) !== setting);
  return { level, why: app?.exe ? `private window: ${app.exe}` : "window unknown" };
};
