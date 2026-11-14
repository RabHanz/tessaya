/**
 * Her personas as the home server's pack resolves them (SPINE-UNIFY §10): one registry every body reads, the room
 * loop, the device menu, Character Studio, the mascot and the desktop's wake words.
 */
import * as Schema from "effect/Schema";

export const BATON_PERSONAS_WS_METHODS = { list: "baton.personas.list" } as const;

export const TessayaPersona = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  wake: Schema.NullOr(Schema.String),
  /** Whether a model wakes to `wake` yet: until it is trained he reaches her by "switch to <name>". */
  wakeModel: Schema.optionalKey(Schema.Literals(["trained", "training", "none"])),
  voice: Schema.String,
  cloudVoice: Schema.optionalKey(Schema.String),
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
