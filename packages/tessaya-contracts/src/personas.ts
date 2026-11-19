/**
 * Her personas as the home server's pack resolves them (SPINE-UNIFY §10): one registry every body reads, the room
 * loop, the device menu, Character Studio, the mascot and the desktop's wake words.
 */
import * as Schema from "effect/Schema";

export const BATON_PERSONAS_WS_METHODS = {
  list: "baton.personas.list",
  change: "baton.personas.change",
} as const;

const PrivateRooms = Schema.Literals(["never", "one-on-one", "open"]);

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
  /** How far a private persona comes into his private rooms (M-080). */
  privateRooms: Schema.optionalKey(PrivateRooms),
  character: Schema.optionalKey(Schema.String),
  traits: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  eyes: Schema.optionalKey(Schema.String),
  guilt: Schema.optionalKey(Schema.Number),
  brain: Schema.optionalKey(Schema.Struct({ model: Schema.String, effort: Schema.String })),
  /** What it may say when he first wakes it each day, one picked at random (Character Card `first_mes` and alternates). */
  greetings: Schema.optionalKey(Schema.Array(Schema.String)),
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
  /** How far it comes into his private rooms: never, only one-on-one with him, or open rooms too; null takes it out. */
  privateRooms: Schema.optionalKey(Schema.NullOr(PrivateRooms)),
  /** Its greetings, one line each; an empty list or null takes them out. */
  greetings: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Line(400)).check(Schema.isMaxLength(8))),
  ),
});
export type TessayaPersonaDraft = typeof TessayaPersonaDraft.Type;

const GroupMode = Schema.Literals(["answer", "watch"]);

/** His group (M-021): who is in it, who only listens, and whether they answer only him or talk among themselves. */
export const TessayaPersonaGroup = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({ id: Schema.String, silent: Schema.optional(Schema.Boolean) }),
  ),
  mode: GroupMode,
});
export type TessayaPersonaGroup = typeof TessayaPersonaGroup.Type;

/** The same changes `tessaya_group` makes by voice. */
export const TessayaPersonaGroupChange = Schema.Union([
  Schema.Struct({
    op: Schema.Literals(["start", "add"]),
    personas: Schema.Array(Line(60)).check(Schema.isMaxLength(6)),
    mode: Schema.optional(GroupMode),
  }),
  Schema.Struct({ op: Schema.Literals(["leave", "silent", "speak"]), persona: Line(60) }),
  Schema.Struct({ op: Schema.Literal("mode"), mode: GroupMode }),
  Schema.Struct({ op: Schema.Literals(["end", "status"]) }),
]);

/**
 * Hire, edit, copy, retire to the bin and restore; `bin` only reads; `group` changes or reads his group. `import` hires
 * from a Character Card (V1, V2 or V3: JSON text, a PNG as base64, or `source`, a file on this server or an https
 * link); `export` gives a persona as a card; `hire` drafts a persona from his one sentence without saving it.
 */
export const TessayaPersonaChangeInput = Schema.Union([
  Schema.Struct({ op: Schema.Literal("group"), change: TessayaPersonaGroupChange }),
  Schema.Struct({ op: Schema.Literal("create"), draft: TessayaPersonaDraft }),
  Schema.Struct({ op: Schema.Literal("edit"), id: Line(60), draft: TessayaPersonaDraft }),
  Schema.Struct({ op: Schema.Literal("duplicate"), id: Line(60), name: Line(40) }),
  Schema.Struct({ op: Schema.Literals(["retire", "restore"]), id: Line(60) }),
  Schema.Struct({ op: Schema.Literal("bin") }),
  Schema.Struct({
    op: Schema.Literal("import"),
    card: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(12_000_000))),
    source: Schema.optionalKey(Line(1_000)),
  }),
  Schema.Struct({ op: Schema.Literal("export"), id: Line(60) }),
  Schema.Struct({ op: Schema.Literal("hire"), sentence: Line(600) }),
]);
export type TessayaPersonaChangeInput = typeof TessayaPersonaChangeInput.Type;

export const TessayaPersonaChangeResult = Schema.Struct({
  ok: Schema.Boolean,
  /** Why not, in a sentence for him. */
  error: Schema.optionalKey(Schema.String),
  /** The persona made or changed. */
  id: Schema.optionalKey(Schema.String),
  bin: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  /** A group change: what she would say back, and his group as it now is (null: none). */
  line: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.NullOr(TessayaPersonaGroup)),
  /** `hire`: the persona drafted from his sentence, for him to confirm with `create`. */
  draft: Schema.optionalKey(TessayaPersonaDraft),
  /** `export`: the card as Character Card V2 JSON, the same card inside a PNG (base64), and where both were saved. */
  card: Schema.optionalKey(
    Schema.Struct({ json: Schema.String, png: Schema.String, files: Schema.Array(Schema.String) }),
  ),
});
export type TessayaPersonaChangeResult = typeof TessayaPersonaChangeResult.Type;
