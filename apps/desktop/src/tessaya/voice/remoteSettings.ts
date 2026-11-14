/**
 * Dictation settings changed from outside (`tessaya_desktop_settings` on this machine's server). Each sync, held on the
 * server until a change comes, reports what this app runs with and takes any waiting change, which goes through the
 * same Settings controls he uses; it then reports again so the agent sees the values it caused.
 */
import {
  type DesktopSettingsControl,
  DesktopSettingsSyncResult,
  type DesktopVoiceSettings,
  type DesktopVoiceSettingsPatch,
} from "@t3tools/tessaya-contracts";
import * as Schema from "effect/Schema";

import type { HomeControl } from "../home/tessayaHome.ts";
import { SETTINGS, tabOf } from "../home/tabs.ts";

const decodeSync = Schema.decodeUnknownOption(DesktopSettingsSyncResult);

export const remoteSettingsOf = (settings: DesktopVoiceSettings): DesktopVoiceSettings => ({
  dictationCleanup: settings.dictationCleanup,
  pillStyle: settings.pillStyle,
  pillDesign: settings.pillDesign,
  pillWaveform: settings.pillWaveform,
  showWords: settings.showWords,
  holdKey: settings.holdKey,
  holdKeyCues: settings.holdKeyCues,
  frosted: settings.frosted,
  doubleTap: settings.doubleTap,
  learnWords: settings.learnWords,
  duckWhileDictating: settings.duckWhileDictating,
  recognizeOnServers: settings.recognizeOnServers,
  gpuRecognition: settings.gpuRecognition,
  openTessayaOnStart: settings.openTessayaOnStart,
  openSessionsOnStart: settings.openSessionsOnStart,
  devicesMayLook: settings.devicesMayLook === true,
});

/** Each field's Settings control, so a remote change runs exactly what his click would. */
const CONTROL: Record<keyof DesktopVoiceSettingsPatch, string> = {
  dictationCleanup: "v.cleanup",
  pillStyle: "v.pillStyle",
  pillDesign: "v.pillDesign",
  pillWaveform: "v.pillWaveform",
  showWords: "v.showWords",
  holdKey: "setup.hold",
  holdKeyCues: "v.holdKeyCues",
  frosted: "v.frosted",
  doubleTap: "v.doubleTap",
  learnWords: "v.learnWords",
  duckWhileDictating: "v.duck",
  recognizeOnServers: "v.recognizeOnServers",
  gpuRecognition: "v.gpu",
  openTessayaOnStart: "v.startHome",
  openSessionsOnStart: "v.startSessions",
  devicesMayLook: "v.devicesMayLook",
};

/**
 * How each Settings category's controls may change by voice; a control may say otherwise (`voice`). Typed over the
 * categories, so a new one without a voice class does not compile.
 */
const TAB_VOICE: Record<(typeof SETTINGS)[number]["id"], DesktopSettingsControl["voice"]> = {
  accounts: "owner",
  apis: "owner",
  brain: "owner",
  general: "free",
  voice: "free",
  personas: "free",
  assistant: "owner",
  privacy: "owner",
  appearance: "free",
  keys: "free",
  advanced: "confirm",
  about: "free",
};

/**
 * Every toggle and choice in Settings, published to this machine's server so each is reachable by voice (settings_*
 * as `desktop:<id>`). The typed fields above are left out: they are settings already.
 */
export const voiceControls = (
  controls: ReadonlyArray<HomeControl>,
): ReadonlyArray<DesktopSettingsControl> => {
  const typed = new Set(Object.values(CONTROL));
  return controls.flatMap((c): ReadonlyArray<DesktopSettingsControl> => {
    const tab = c.tab ?? tabOf(c.id);
    if (!(tab in TAB_VOICE) || typed.has(c.id) || c.disabled === true) return [];
    const base = {
      id: c.id.slice(0, 120),
      label: c.label.slice(0, 200),
      section: c.section.slice(0, 80),
      ...(c.hint === undefined ? {} : { hint: c.hint.slice(0, 400) }),
      voice: c.voice ?? TAB_VOICE[tab as keyof typeof TAB_VOICE],
    };
    if (c.kind === "toggle") return [{ ...base, value: c.on }];
    if (c.kind === "choice")
      return [
        {
          ...base,
          value: c.value.slice(0, 200),
          options: c.options.slice(0, 40).map((o) => o.value.slice(0, 200)),
        },
      ];
    return [];
  });
};

const REPUBLISH_MS = 10 * 60_000;

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
    readonly controls?: ReadonlyArray<DesktopSettingsControl>;
  }) => Promise<unknown>;
  readonly current: () => DesktopVoiceSettings;
  readonly apply: (id: string, value: string | boolean) => void;
  /** Its Settings controls, published for voice when they change. */
  readonly controls?: () => ReadonlyArray<HomeControl>;
  readonly now?: () => number;
}) => {
  let applied = 0;
  let published = { json: "", at: 0 };
  const report = async () => {
    const controls = input.controls === undefined ? null : voiceControls(input.controls());
    const json = controls === null ? "" : JSON.stringify(controls);
    // Sent when they changed, and now and then for a server that restarted: a sync is held open often.
    const now = (input.now ?? Date.now)();
    const send = json !== published.json || now - published.at > REPUBLISH_MS;
    const answer = await input.sync({
      effective: remoteSettingsOf(input.current()),
      applied,
      ...(send && controls !== null ? { controls } : {}),
    });
    if (send) published = { json, at: now };
    return answer;
  };
  /** One sync; true when it applied a change. */
  const tick = async (): Promise<boolean> => {
    const answer = decodeSync(await report());
    const change = answer._tag === "Some" ? answer.value.change : null;
    if (change === null || change.version <= applied) return false;
    for (const [id, value] of controlsFor(change.patch)) input.apply(id, value);
    // A voice change of one of its own controls: as his click.
    for (const { id, value } of change.controls ?? []) input.apply(id, value);
    applied = change.version;
    await report();
    return true;
  };
  return { tick };
};
