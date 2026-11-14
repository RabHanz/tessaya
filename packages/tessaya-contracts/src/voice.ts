/**
 * The voice library (Settings → Voice, each persona's picker, the R1 and the phone): every voice this environment
 * can speak in, a preview line in any of them, and each persona's choice. One method whose `kind` sets the scope,
 * like the house's: `read` lists and previews; `act` changes a persona's voice, saves the Google key, or says a line
 * in a cloud voice.
 */
import * as Schema from "effect/Schema";

export const BATON_VOICE_WS_METHODS = { call: "baton.voice.call" } as const;
export const BATON_VOICE_READ_OPS = ["library", "preview", "arbiter"] as const;
/** `claim`, `speaking` and `ended` are the voice arbiter's (one responder per utterance); `answerFrom` sets the primary. */
export const BATON_VOICE_ACT_OPS = [
  "setPersona",
  "setGoogleKey",
  "say",
  "claim",
  "speaking",
  "ended",
  "answerFrom",
] as const;

/** A device heard its wake or her name and asks to answer (R1-P7). */
export const VoiceClaimInput = Schema.Struct({
  deviceId: Schema.String.check(Schema.isMaxLength(60)),
  /** 0 to 1; a name heard in the text counts as 1. */
  wakeScore: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** dBFS of the wake segment after the device's own gain; null when it cannot say. */
  loudnessDb: Schema.NullOr(Schema.Number),
  speakerScore: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Who Voice ID heard, when it checked: a verified member continues his own conversation. */
  speaker: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        personId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
        verified: Schema.Boolean,
      }),
    ),
  ),
  answerHere: Schema.optionalKey(Schema.Boolean),
});
export type VoiceClaimInput = typeof VoiceClaimInput.Type;

export const TessayaVoiceCallInput = Schema.Struct({
  kind: Schema.Literals(["read", "act"]),
  op: Schema.String.check(Schema.isMaxLength(40)),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type TessayaVoiceCallInput = typeof TessayaVoiceCallInput.Type;

/** ok with a value, or not ok with a sentence for a person. */
export const TessayaVoiceCallResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
});
export type TessayaVoiceCallResult = typeof TessayaVoiceCallResult.Type;

export const VoiceEngine = Schema.Literals(["pocket", "gemini"]);
export type VoiceEngine = typeof VoiceEngine.Type;

export const LibraryVoiceView = Schema.Struct({
  engine: VoiceEngine,
  id: Schema.String,
  name: Schema.String,
  gender: Schema.Literals(["female", "male"]),
  pitch: Schema.Literals(["low", "medium", "high"]),
  accent: Schema.NullOr(Schema.String),
  licence: Schema.String,
  licenceLabel: Schema.String,
  /** Non-commercial or unlicensed source: selectable here, absent from a commercial build. */
  personalUse: Schema.Boolean,
});
export type LibraryVoiceView = typeof LibraryVoiceView.Type;

export const PersonaVoiceRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  lead: Schema.Boolean,
  /** As his file says it; empty when it has no voice of its own. */
  voice: Schema.String,
  cloudVoice: Schema.NullOr(Schema.String),
  /** What it speaks in now: the library's voice for `voice`, or the default. */
  speaks: Schema.String,
});
export type PersonaVoiceRow = typeof PersonaVoiceRow.Type;

export const VoiceLibraryView = Schema.Struct({
  pocket: Schema.Array(LibraryVoiceView),
  /** Null until a Google key is saved in Settings → APIs. */
  cloud: Schema.NullOr(Schema.Array(LibraryVoiceView)),
  personas: Schema.Array(PersonaVoiceRow),
  /** Whether this environment can make a preview: Pocket's files are here, a Google key is saved. */
  previews: Schema.Struct({ pocket: Schema.Boolean, cloud: Schema.Boolean }),
  previewLine: Schema.String,
});
export type VoiceLibraryView = typeof VoiceLibraryView.Type;

export const VoiceClip = Schema.Struct({
  mime: Schema.Literal("audio/wav"),
  base64: Schema.String,
});
export type VoiceClip = typeof VoiceClip.Type;
