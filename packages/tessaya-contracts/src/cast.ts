/**
 * The Cast (Settings → Cast, `tessaya_cast`): which persona wears which body now, its home and follow rule, others
 * beside it, and the temporary calls. The rules are tessaya-shared cast.ts; the server's TessayaCast owns the state.
 */
import * as Schema from "effect/Schema";

export const BATON_CAST_WS_METHODS = { get: "baton.cast.get", call: "baton.cast.call" } as const;

const Id = Schema.String.check(Schema.isMaxLength(128));
const PersonaKey = Schema.String.check(Schema.isMaxLength(60));
const op = <const O extends string, F extends Schema.Struct.Fields>(name: O, fields: F) =>
  Schema.Struct({ op: Schema.Literal(name), ...fields });

export const CastCallInput = Schema.Union([
  op("view", {}),
  /** Pin a persona as the body's home, or null for the lead. */
  op("home", { body: Id, persona: Schema.NullOr(PersonaKey) }),
  op("follows", { body: Id, on: Schema.Boolean }),
  /** Others shown beside it, where the body can show several. */
  op("crew", { body: Id, personas: Schema.Array(PersonaKey).check(Schema.isMaxLength(12)) }),
  /** Bring a persona to a body until the conversation ends, or for good with `stay`. */
  op("call", { body: Id, persona: PersonaKey, stay: Schema.Boolean }),
  /** Every visitor goes home, or only the one on `body`. */
  op("sendHome", { body: Schema.optionalKey(Id) }),
]);
export type CastCallInput = typeof CastCallInput.Type;

export const CastBody = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  online: Schema.NullOr(Schema.Boolean),
  /** How many it can show at once (the desktop's sandbox), else 1. */
  holds: Schema.Number,
  home: Schema.NullOr(Schema.String),
  follows: Schema.Boolean,
  crew: Schema.Array(Schema.String),
  /** The persona it wears now and why: a visit, a stay, whom its person follows, its home, or the lead. */
  wearing: Schema.NullOr(Schema.String),
  why: Schema.Literals(["visit", "stay", "follows", "home", "lead"]),
  /** Everyone on it now, the worn one first. */
  on: Schema.Array(Schema.String),
  /** Whose mood it shows: the device's owner (a body asks TessayaMood with this and `wearing`). */
  facing: Schema.NullOr(Schema.String),
});
export type CastBody = typeof CastBody.Type;

export const CastView = Schema.Struct({
  personas: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  bodies: Schema.Array(CastBody),
  /** Which of his conversations has her desk body now, or that she is free (body focus); his own view only. */
  focus: Schema.optionalKey(Schema.String),
});
export type CastView = typeof CastView.Type;

export class CastError extends Schema.TaggedError<CastError>()("CastError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
