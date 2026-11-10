/**
 * Dictation settings changed from outside (`tessaya_desktop_settings` on this machine's server). Each sync, held on the
 * server until a change comes, reports what this app runs with and takes any waiting change, which goes through the
 * same Settings controls he uses; it then reports again so the agent sees the values it caused.
 */
import {
  DesktopSettingsSyncResult,
  type DesktopVoiceSettings,
  type DesktopVoiceSettingsPatch,
} from "@t3tools/baton-contracts";
import * as Schema from "effect/Schema";

const decodeSync = Schema.decodeUnknownOption(DesktopSettingsSyncResult);

export const remoteSettingsOf = (settings: DesktopVoiceSettings): DesktopVoiceSettings => ({
  dictationCleanup: settings.dictationCleanup,
  pillStyle: settings.pillStyle,
  showWords: settings.showWords,
  holdKey: settings.holdKey,
  holdKeyCues: settings.holdKeyCues,
  frosted: settings.frosted,
  doubleTap: settings.doubleTap,
  learnWords: settings.learnWords,
  duckWhileDictating: settings.duckWhileDictating,
});

/** Each field's Settings control, so a remote change runs exactly what his click would. */
const CONTROL: Record<keyof DesktopVoiceSettingsPatch, string> = {
  dictationCleanup: "v.cleanup",
  pillStyle: "v.pillStyle",
  showWords: "v.showWords",
  holdKey: "setup.hold",
  holdKeyCues: "v.holdKeyCues",
  frosted: "v.frosted",
  doubleTap: "v.doubleTap",
  learnWords: "v.learnWords",
  duckWhileDictating: "v.duck",
};

export const controlsFor = (
  patch: DesktopVoiceSettingsPatch,
): ReadonlyArray<readonly [string, string | boolean]> =>
  (Object.keys(CONTROL) as Array<keyof DesktopVoiceSettingsPatch>).flatMap((field) => {
    const value = patch[field];
    return value === undefined ? [] : [[CONTROL[field], value] as const];
  });

export const createRemoteSettings = (input: {
  readonly sync: (body: {
    readonly effective: DesktopVoiceSettings;
    readonly applied: number;
  }) => Promise<unknown>;
  readonly current: () => DesktopVoiceSettings;
  readonly apply: (id: string, value: string | boolean) => void;
}) => {
  let applied = 0;
  const report = () => input.sync({ effective: remoteSettingsOf(input.current()), applied });
  /** One sync; true when it applied a change. */
  const tick = async (): Promise<boolean> => {
    const answer = decodeSync(await report());
    const change = answer._tag === "Some" ? answer.value.change : null;
    if (change === null || change.version <= applied) return false;
    for (const [id, value] of controlsFor(change.patch)) input.apply(id, value);
    applied = change.version;
    await report();
    return true;
  };
  return { tick };
};
