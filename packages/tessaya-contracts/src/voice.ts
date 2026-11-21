/**
 * The voice library (Settings → Voice, each persona's picker, the R1 and the phone): every voice this environment
 * can speak in, a preview line in any of them, and each persona's choice. One method whose `kind` sets the scope,
 * like the house's: `read` lists and previews; `act` changes a persona's voice, saves the Google key, or says a line;
 * `owner` (the approval scope) clones a voice from his clip, keeps or deletes a clone, and speaks in one.
 */
import * as Schema from "effect/Schema";

export const BATON_VOICE_WS_METHODS = { call: "baton.voice.call" } as const;
/** `mood` is a persona's working mood (CS6) for a vessel to wear at rest; `vocabulary` is his one dictionary. */
export const BATON_VOICE_READ_OPS = [
  "library",
  "preview",
  "arbiter",
  "mood",
  "vocabulary",
  // The caller's one conversation with her from the room transcript, a page at a time (M-124).
  "conversation",
  // Voice ID's who-else-she-hears switches (her brain's voiceIdGate) and each Tessel's far-voice learning (M-127).
  "voiceId",
] as const;
/** `claim`, `speaking` and `ended` are the voice arbiter's (one responder per utterance); `answerFrom` sets the primary. */
/** `express` is a vessel's moment (her desktop body poked, thrown, moved) as the brain words it, in her persona. */
/** Cloning needs his "my voice, or I have their permission" yes, recorded in the one consent store. */
export const BATON_VOICE_OWNER_OPS = [
  "clone",
  "saveClone",
  "deleteClone",
  // An affect variant beside a saved clone (VOXTA G1): a clip in that tone, made into its own embedding.
  "recordAffect",
  "say",
  "setHfToken",
  // Her mood with why (the reasons she logged); a read gets only the label and strength.
  "mood",
  // Her opinion of one person, their story and her feeling toward them, back to nothing (MA-021).
  "moodReset",
  // Voice ID's switches, or (forgetLearning) every Tessel forgetting what it learnt of his far voice.
  "setVoiceId",
] as const;
export const BATON_VOICE_ACT_OPS = [
  "express",
  // A hand on a vessel's body (the desk's cartoon): felt by her one nervous system, answered from her mood.
  "touch",
  "setPersona",
  "setGoogleKey",
  "say",
  "claim",
  "speaking",
  "ended",
  "answerFrom",
  "vocabularyChange",
  // His past dictations and what he kept, from the desktop to her brain, so every vessel reads them (ML-015).
  "stylePairs",
] as const;

/** Up to 2,000 style pairs ({ raw, kept, mode, id }) at a time; the store checks each one. */
export const StylePairsSync = Schema.Struct({
  pairs: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(2_000)),
});

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

const VocabularyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60));

/**
 * One change to his dictionary, with the desktop editor's verbs. `learn` merges entries another copy already holds
 * (a learned word, a desktop's whole list), so sending it twice changes nothing.
 */
export const VocabularyChange = Schema.Union([
  Schema.Struct({
    verb: Schema.Literal("add"),
    phrase: VocabularyText,
    replacement: Schema.NullOr(VocabularyText),
  }),
  Schema.Struct({
    verb: Schema.Literal("edit"),
    from: VocabularyText,
    phrase: VocabularyText,
    replacement: Schema.NullOr(VocabularyText),
  }),
  Schema.Struct({ verb: Schema.Literal("remove"), phrase: VocabularyText }),
  /** One way the word is heard, taken off it. */
  Schema.Struct({ verb: Schema.Literal("unhear"), phrase: VocabularyText, form: VocabularyText }),
  Schema.Struct({
    verb: Schema.Literal("learn"),
    entries: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(5_000)),
  }),
]);
export type VocabularyChange = typeof VocabularyChange.Type;

export const TessayaVoiceCallInput = Schema.Struct({
  kind: Schema.Literals(["read", "act", "owner"]),
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
  /** One of his saved clones (its id), spoken first where clones can be; null when it has none. */
  cloneVoice: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** What it speaks in now: the library's voice for `voice`, or the default. */
  speaks: Schema.String,
});
export type PersonaVoiceRow = typeof PersonaVoiceRow.Type;

/** The tones a saved clone can be recorded in (Playground), as a persona layer names a line's affect. */
export const AFFECT_VARIANTS = ["tender", "excited", "soft", "whisper", "playful"] as const;
export type AffectVariant = (typeof AFFECT_VARIANTS)[number];
export const isAffectVariant = (name: string): name is AffectVariant =>
  (AFFECT_VARIANTS as ReadonlyArray<string>).includes(name);

export const SavedCloneView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  /** Its affect variants recorded in Playground ("tender", "whisper" …): what a line in this voice can be said in. */
  affects: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Where this machine's own Pocket fetches its embedding (`voice_url`): a path on this server, served to loopback only
   * under a key this server keeps. The affect variants sit beside it as `<id>.affect-<name>.safetensors`.
   */
  embedding: Schema.optionalKey(Schema.String),
});
export type SavedCloneView = typeof SavedCloneView.Type;

export const VoiceLibraryView = Schema.Struct({
  pocket: Schema.Array(LibraryVoiceView),
  /** Null until a Google key is saved in Settings → APIs. */
  cloud: Schema.NullOr(Schema.Array(LibraryVoiceView)),
  personas: Schema.Array(PersonaVoiceRow),
  /** Whether this environment can make a preview: Pocket's files are here, a Google key is saved. */
  previews: Schema.Struct({ pocket: Schema.Boolean, cloud: Schema.Boolean }),
  previewLine: Schema.String,
  /** His saved clones whose consent stands, in this environment's own data and never synced; speaking is owner-only. */
  clones: Schema.optionalKey(Schema.Array(SavedCloneView)),
  /** Cloning here: Pocket is installed, and the gated cloning weights are already on this machine. */
  cloning: Schema.optionalKey(Schema.Struct({ pocket: Schema.Boolean, weights: Schema.Boolean })),
});
export type VoiceLibraryView = typeof VoiceLibraryView.Type;

export const VoiceClip = Schema.Struct({
  mime: Schema.Literal("audio/wav"),
  base64: Schema.String,
  /** A cloned voice's line: synthetic speech, also stamped in the WAV's own INFO chunk. */
  synthetic: Schema.optionalKey(Schema.Boolean),
});
export type VoiceClip = typeof VoiceClip.Type;

/** A test voice made from his clip: try it, then save it under a name, or the next clone replaces it. */
export const CloneResult = Schema.Struct({
  id: Schema.String,
  seconds: Schema.Number,
  /** Null when this machine has no Voice ID model to check that the clip is one voice. */
  oneSpeaker: Schema.NullOr(Schema.Boolean),
  clip: VoiceClip,
});
export type CloneResult = typeof CloneResult.Type;
