/**
 * Her personas as the home server's pack resolves them (SPINE-UNIFY §10): one registry every body reads, the room
 * loop, the device menu, Character Studio, the mascot and the desktop's wake words.
 */
import * as Schema from "effect/Schema";

export const BATON_PERSONAS_WS_METHODS = {
  list: "baton.personas.list",
  change: "baton.personas.change",
} as const;

export const TessayaPersona = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  wake: Schema.NullOr(Schema.String),
  /** Whether a model wakes to `wake` yet: until it is trained he reaches her by "switch to <name>". */
  wakeModel: Schema.optionalKey(Schema.Literals(["trained", "training", "none"])),
  voice: Schema.String,
  cloudVoice: Schema.optionalKey(Schema.String),
  /** One of his saved clones (`clone voice:`), spoken where clones can be; `voice` stays its fallback. */
  cloneVoice: Schema.optionalKey(Schema.String),
  role: Schema.String,
  lead: Schema.Boolean,
  private: Schema.optionalKey(Schema.Boolean),
  character: Schema.optionalKey(Schema.String),
  traits: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  eyes: Schema.optionalKey(Schema.String),
  guilt: Schema.optionalKey(Schema.Number),
  brain: Schema.optionalKey(Schema.Struct({ model: Schema.String, effort: Schema.String })),
});
export type TessayaPersona = typeof TessayaPersona.Type;

export const TessayaPersonasListInput = Schema.Struct({});
export const TessayaPersonasListResult = Schema.Struct({ personas: Schema.Array(TessayaPersona) });
export type TessayaPersonasListResult = typeof TessayaPersonasListResult.Type;

const Line = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Dial = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** What he sets on a persona; a field left out stays, null takes it out. */
export const TessayaPersonaDraft = Schema.Struct({
  name: Schema.optionalKey(Line(40)),
  wake: Schema.optionalKey(Schema.NullOr(Line(40))),
  voice: Schema.optionalKey(Schema.NullOr(Line(80))),
  cloudVoice: Schema.optionalKey(Schema.NullOr(Line(80))),
  cloneVoice: Schema.optionalKey(Schema.NullOr(Line(80))),
  role: Schema.optionalKey(Line(200)),
  /** Personality, backstory and relationship to him: the brief its turns read. */
  about: Schema.optionalKey(Line(4_000)),
  character: Schema.optionalKey(Schema.NullOr(Line(40))),
  eyes: Schema.optionalKey(Schema.NullOr(Line(40))),
  traits: Schema.optionalKey(
    Schema.Struct({
      energy: Schema.optionalKey(Dial),
      warmth: Schema.optionalKey(Dial),
      play: Schema.optionalKey(Dial),
      expr: Schema.optionalKey(Dial),
      formal: Schema.optionalKey(Dial),
      sass: Schema.optionalKey(Dial),
    }),
  ),
  guilt: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
  ),
  /** Any provider's model name; the routing table picks the login. */
  model: Schema.optionalKey(Schema.NullOr(Line(60))),
  effort: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["low", "medium", "high", "xhigh", "max"])),
  ),
  private: Schema.optionalKey(Schema.Boolean),
});
export type TessayaPersonaDraft = typeof TessayaPersonaDraft.Type;

/** Hire, edit, copy, retire to the bin and restore; `bin` only reads. */
export const TessayaPersonaChangeInput = Schema.Union([
  Schema.Struct({ op: Schema.Literal("create"), draft: TessayaPersonaDraft }),
  Schema.Struct({ op: Schema.Literal("edit"), id: Line(60), draft: TessayaPersonaDraft }),
  Schema.Struct({ op: Schema.Literal("duplicate"), id: Line(60), name: Line(40) }),
  Schema.Struct({ op: Schema.Literals(["retire", "restore"]), id: Line(60) }),
  Schema.Struct({ op: Schema.Literal("bin") }),
]);
export type TessayaPersonaChangeInput = typeof TessayaPersonaChangeInput.Type;

export const TessayaPersonaChangeResult = Schema.Struct({
  ok: Schema.Boolean,
  /** Why not, in a sentence for him. */
  error: Schema.optionalKey(Schema.String),
  /** The persona made or changed. */
  id: Schema.optionalKey(Schema.String),
  bin: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export type TessayaPersonaChangeResult = typeof TessayaPersonaChangeResult.Type;
