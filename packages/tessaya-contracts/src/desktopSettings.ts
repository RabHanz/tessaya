/**
 * The desktop's dictation, pill and start-up settings an agent may read and change through this machine's server. Only these fields:
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
  "Alt+Win",
  "Ctrl+Shift+Win",
  "F9",
  "F8",
  "Ctrl+Shift+Space",
  "Pause",
] as const;

export const DesktopVoiceSettings = Schema.Struct({
  dictationCleanup: Schema.Literals(["claude", "local", "off"]),
  pillStyle: Schema.Literals(["pill", "field"]),
  /** Settings → Appearance → Pill design, and its waveform ("match" is the design's own). */
  pillDesign: Schema.Literals(["tessaya", "quiet", "lively"]),
  pillWaveform: Schema.Literals(["match", "mound", "bars", "beads"]),
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
  /** Which windows open when the app starts; the first run opens both whatever these say. */
  openTessayaOnStart: Schema.Boolean,
  openSessionsOnStart: Schema.Boolean,
  /** His own devices (the R1 and others he linked) may look at this screen without asking. Absent from older apps. */
  devicesMayLook: Schema.optionalKey(Schema.Boolean),
});
export type DesktopVoiceSettings = typeof DesktopVoiceSettings.Type;

/** A change: any of the fields, and a hold key only from the safe list. Unknown fields are dropped on decode. */
const fields = DesktopVoiceSettings.fields;
export const DesktopVoiceSettingsPatch = Schema.Struct({
  dictationCleanup: Schema.optionalKey(fields.dictationCleanup),
  pillStyle: Schema.optionalKey(fields.pillStyle),
  pillDesign: Schema.optionalKey(fields.pillDesign),
  pillWaveform: Schema.optionalKey(fields.pillWaveform),
  showWords: Schema.optionalKey(fields.showWords),
  holdKey: Schema.optionalKey(Schema.Literals(DESKTOP_HOLD_KEYS)),
  holdKeyCues: Schema.optionalKey(fields.holdKeyCues),
  frosted: Schema.optionalKey(fields.frosted),
  doubleTap: Schema.optionalKey(fields.doubleTap),
  learnWords: Schema.optionalKey(fields.learnWords),
  duckWhileDictating: Schema.optionalKey(fields.duckWhileDictating),
  recognizeOnServers: Schema.optionalKey(fields.recognizeOnServers),
  gpuRecognition: Schema.optionalKey(fields.gpuRecognition),
  openTessayaOnStart: Schema.optionalKey(fields.openTessayaOnStart),
  openSessionsOnStart: Schema.optionalKey(fields.openSessionsOnStart),
  devicesMayLook: fields.devicesMayLook,
});
export type DesktopVoiceSettingsPatch = typeof DesktopVoiceSettingsPatch.Type;

export const DesktopSettingsSetInput = Schema.Struct({ patch: DesktopVoiceSettingsPatch });

/** How a desktop setting may change by voice: free at once; confirm and owner on his yes; never not at all. */
export const SETTING_CLASSES = ["free", "confirm", "owner", "never"] as const;

/** One of the desktop's own Settings controls (a toggle or a choice), as it publishes them for voice. */
export const DesktopSettingsControl = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(120)),
  label: Schema.String.check(Schema.isMaxLength(200)),
  hint: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
  section: Schema.String.check(Schema.isMaxLength(80)),
  value: Schema.Union([Schema.String.check(Schema.isMaxLength(200)), Schema.Boolean]),
  /** A choice's values; absent for a toggle. */
  options: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(40)),
  ),
  voice: Schema.Literals(SETTING_CLASSES),
});
export type DesktopSettingsControl = typeof DesktopSettingsControl.Type;

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
  /** Its own Settings controls as it last published them; absent until it does. */
  controls: Schema.optionalKey(Schema.Array(DesktopSettingsControl)),
});
export type DesktopSettingsView = typeof DesktopSettingsView.Type;

export const DesktopSettingsSyncInput = Schema.Struct({
  effective: DesktopVoiceSettings,
  /** The last change version this desktop applied; 0 for none. */
  applied: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Its Settings controls, sent when they change; absent from older desktops and when nothing changed. */
  controls: Schema.optionalKey(Schema.Array(DesktopSettingsControl).check(Schema.isMaxLength(400))),
});
export const DesktopSettingsSyncResult = Schema.Struct({
  change: Schema.NullOr(
    Schema.Struct({
      version: Schema.Int,
      patch: DesktopVoiceSettingsPatch,
      /** Settings controls to set, by id, as his click would: from a voice change of one of them. */
      controls: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.String.check(Schema.isMaxLength(120)),
            value: Schema.Union([Schema.String.check(Schema.isMaxLength(200)), Schema.Boolean]),
          }),
        ),
      ),
    }),
  ),
});
