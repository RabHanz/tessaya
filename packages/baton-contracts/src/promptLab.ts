/**
 * The prompt lab (B-030): Settings → Brain → Prompt lab, the voice and `tessaya_prompt_lab` all reach one service.
 * Owner and admin only (settings:write); the server authorizes every call.
 */
import * as Schema from "effect/Schema";

export const BATON_PROMPT_LAB_WS_METHODS = { call: "baton.promptLab.call" } as const;

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60));

export const BatonPromptLabInput = Schema.Union([
  Schema.Struct({ op: Schema.Literal("list") }),
  Schema.Struct({
    op: Schema.Literal("save"),
    persona: Name,
    variant: Name,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40_000)),
  }),
  Schema.Struct({ op: Schema.Literal("delete"), persona: Name, variant: Name }),
  Schema.Struct({
    op: Schema.Literal("run"),
    persona: Name,
    /** Variant names, or "live". */
    variants: Schema.Array(Name).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
    models: Schema.Array(Name).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
    /** One typed message instead of the scenario set. */
    message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  }),
  Schema.Struct({ op: Schema.Literal("promote"), persona: Name, variant: Name }),
  Schema.Struct({ op: Schema.Literal("rollback"), persona: Name }),
]);
export type BatonPromptLabInput = typeof BatonPromptLabInput.Type;

const Score = Schema.Struct({
  passed: Schema.Boolean,
  misses: Schema.Array(Schema.String),
  words: Schema.Number,
});

export const BatonPromptLabPersona = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The live prompt as its turns read it: his file over the default. */
  live: Schema.String,
  /** Whether the live text is his own file rather than the shipped default. */
  mine: Schema.Boolean,
  variants: Schema.Array(Schema.Struct({ name: Schema.String, text: Schema.String })),
  /** What a rollback would put back, when there is one. */
  previous: Schema.Boolean,
});

export const BatonPromptLabResult = Schema.Struct({
  line: Schema.String,
  personas: Schema.optionalKey(Schema.Array(BatonPromptLabPersona)),
  /** Prompt sources another layer adds (names only: their text never crosses this door). */
  sources: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  ),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  cells: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        variant: Schema.String,
        model: Schema.String,
        replies: Schema.Array(
          Schema.Struct({ scenario: Schema.String, reply: Schema.String, score: Score }),
        ),
      }),
    ),
  ),
});
export type BatonPromptLabResult = typeof BatonPromptLabResult.Type;
