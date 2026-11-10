/**
 * The desktop's dictation settings an agent may read and change through this machine's server. Only these fields:
 * nothing here holds a key, a path, an account or anything that opens the microphone or keeps audio.
 */
import * as Schema from "effect/Schema";

export const BATON_DESKTOP_SETTINGS_WS_METHODS = {
  get: "baton.desktopSettings.get",
  set: "baton.desktopSettings.set",
  sync: "baton.desktopSettings.sync",
} as const;

/** Safe to hold alone; the first is the default chord (Settings → Dictation and the first-run guide). */
export const DESKTOP_HOLD_KEYS = [
  "Ctrl+Shift+Win",
  "F9",
  "F8",
  "Ctrl+Shift+Space",
  "Pause",
] as const;

export const DesktopVoiceSettings = Schema.Struct({
  dictationCleanup: Schema.Literals(["claude", "local", "off"]),
  pillStyle: Schema.Literals(["pill", "field"]),
  showWords: Schema.Boolean,
  holdKey: Schema.String.check(Schema.isMaxLength(80)),
  holdKeyCues: Schema.Boolean,
  frosted: Schema.Boolean,
  doubleTap: Schema.Boolean,
  learnWords: Schema.Boolean,
  duckWhileDictating: Schema.Literals(["off", "lower", "mute"]),
  /** Recognise on his own servers (off by default); the servers and their tokens are set only on the desktop. */
  recognizeOnServers: Schema.Boolean,
  gpuRecognition: Schema.Literals(["auto", "on", "off"]),
});
export type DesktopVoiceSettings = typeof DesktopVoiceSettings.Type;

/** A change: any of the fields, and a hold key only from the safe list. Unknown fields are dropped on decode. */
const fields = DesktopVoiceSettings.fields;
export const DesktopVoiceSettingsPatch = Schema.Struct({
  dictationCleanup: Schema.optionalKey(fields.dictationCleanup),
  pillStyle: Schema.optionalKey(fields.pillStyle),
  showWords: Schema.optionalKey(fields.showWords),
  holdKey: Schema.optionalKey(Schema.Literals(DESKTOP_HOLD_KEYS)),
  holdKeyCues: Schema.optionalKey(fields.holdKeyCues),
  frosted: Schema.optionalKey(fields.frosted),
  doubleTap: Schema.optionalKey(fields.doubleTap),
  learnWords: Schema.optionalKey(fields.learnWords),
  duckWhileDictating: Schema.optionalKey(fields.duckWhileDictating),
  recognizeOnServers: Schema.optionalKey(fields.recognizeOnServers),
  gpuRecognition: Schema.optionalKey(fields.gpuRecognition),
});
export type DesktopVoiceSettingsPatch = typeof DesktopVoiceSettingsPatch.Type;

export const DesktopSettingsSetInput = Schema.Struct({ patch: DesktopVoiceSettingsPatch });

export const DesktopSettingsView = Schema.Struct({
  /** The desktop has reported in the last minute. */
  connected: Schema.Boolean,
  /** When it last reported, ISO time; null when it never has. */
  at: Schema.NullOr(Schema.String),
  /** What the desktop says it runs with; null until it reports. */
  effective: Schema.NullOr(DesktopVoiceSettings),
  /** A change not yet applied by the desktop. */
  pending: Schema.NullOr(DesktopVoiceSettingsPatch),
  /** On a set: the desktop applied it and `effective` is after it. */
  applied: Schema.optionalKey(Schema.Boolean),
});
export type DesktopSettingsView = typeof DesktopSettingsView.Type;

export const DesktopSettingsSyncInput = Schema.Struct({
  effective: DesktopVoiceSettings,
  /** The last change version this desktop applied; 0 for none. */
  applied: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const DesktopSettingsSyncResult = Schema.Struct({
  change: Schema.NullOr(Schema.Struct({ version: Schema.Int, patch: DesktopVoiceSettingsPatch })),
});
