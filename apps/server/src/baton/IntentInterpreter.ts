/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * The model read of a sentence the grammar could not place (D50).
 *
 * The Director's ruling was blunt: *"don't dumb it down by generic grammar!
 * what the hell even is the point of this if it isn't smart or sentient!"* This
 * is the answer to that, and it is deliberately the *second* answer:
 *
 *   grammar → model
 *
 * The grammar stays first because it is instant, free and identical every time,
 * and it stays as the verifier because everything a model returns is checked
 * against the same ids and the same §24.1 list the grammar uses
 * (`@t3tools/shared/batonIntentModel`).
 *
 * Three rules this service follows, and they are the whole design:
 *
 *   1. **It runs as one of the user's own accounts.** The call goes through the
 *      same `TextGeneration` path as thread titles and commit messages, which
 *      spawns their `claude` CLI under their config directory. Subscription,
 *      not API — the Director's rule 2 — and no key of ours anywhere.
 *   2. **It uses the cheapest tier that can classify.** Haiku reads a sentence
 *      against a list of names; the model tier that writes code is not needed
 *      to decide whether "poke the scheduler" is a message or a status
 *      question.
 *   3. **It never reaches a provider that is not there.** No available account
 *      is a refusal by name, not a hang.
 */
import type { BatonIntentResolution } from "@t3tools/tessaya-contracts";
import {
  buildIntentModelPrompt,
  interpretIntentModelReply,
  type IntentModelReply,
} from "@t3tools/tessaya-shared/intentModel";
import type { IntentVocabulary } from "@t3tools/tessaya-shared/intentParser";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Schema from "effect/Schema";

import { BatonOneShot } from "./BatonOneShot.ts";
import { onSubscription, routeFor } from "./BrainRoutes.ts";

/**
 * The drivers that can read a sentence into a command.
 *
 * `interpretBatonIntent` is optional on the TextGeneration service — a driver
 * that cannot do it is a refusal by name rather than a build that will not
 * compile (D50) — so the caller has to know which ones can, or it spends a
 * round trip learning that Codex does not. Found by deploying: on the
 * Director's local box the first signed-in account is Codex, and every sentence
 * came back as the grammar's refusal because of it.
 *
 * Codex's own structured one-shot is the obvious next entry here.
 */
export const INTENT_CAPABLE_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

export interface IntentInterpretation {
  readonly resolution: BatonIntentResolution;
  /** The model that read it, for the record. */
  readonly model: string;
}

export class BatonIntentInterpreter extends Context.Service<
  BatonIntentInterpreter,
  {
    /**
     * Read a sentence the grammar refused. `null` when no account here can do
     * it — the caller keeps the grammar's own refusal, which is more useful
     * than "the model was unavailable".
     */
    readonly interpret: (input: {
      readonly sentence: string;
      readonly vocabulary: IntentVocabulary;
    }) => Effect.Effect<IntentInterpretation | null>;
  }
>()("t3/baton/IntentInterpreter/BatonIntentInterpreter") {}

/**
 * Which account reads the sentence.
 *
 * The first **signed-in** one, in the order the environment lists them — a
 * stable, boring rule the user can predict. Deliberately not "the busiest" or
 * "the one with most quota": a sentence should not be read by a different
 * account depending on the hour, because the account is what the reading is
 * billed to and what its rate limit belongs to.
 *
 * "Signed in" rather than merely "available", and that distinction cost a live
 * deploy to find. On the Director's local box the first configured instance is
 * a claude-swap account whose refresh token has expired: enabled, installed,
 * and still reporting `authenticated`, because the CLI knows whose account it
 * is. It simply cannot answer. The interpreter picked it, the call failed
 * instantly, and the sentence came back as the grammar's refusal — silent, and
 * identical to having no model at all.
 *
 * Falls back to any available account when none reports an address: a provider
 * that does not publish one is not thereby broken, and refusing to try would be
 * the same silence in a different costume.
 */
export const chooseInterpreterInstance = (
  vocabulary: IntentVocabulary,
  /** The brain's routing table's `intent` model: the cheapest capable one by default. */
  model: string,
): { readonly instanceId: string; readonly model: string } | null => {
  const capable = vocabulary.providers.filter(
    (provider) => provider.available && INTENT_CAPABLE_DRIVERS.has(provider.driver),
  );
  const chosen = capable.find((provider) => provider.signedIn) ?? capable[0];
  if (chosen === undefined) return null;
  return { instanceId: chosen.instanceId, model };
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const oneShot = yield* BatonOneShot;
  const intentModel = routeFor("intent").pipe(
    Effect.map(onSubscription),
    Effect.flatMap((path) =>
      "refused" in path
        ? Effect.logWarning("brain: reading a sentence was refused", { why: path.refused }).pipe(
            Effect.as(null),
          )
        : Effect.succeed(path.model),
    ),
    Effect.orElseSucceed(() => null),
  );

  const interpret: BatonIntentInterpreter["Service"]["interpret"] = ({ sentence, vocabulary }) =>
    Effect.gen(function* () {
      const model = yield* intentModel;
      if (model === null) return null;
      const chosen = chooseInterpreterInstance(vocabulary, model);
      if (chosen === null) return null;

      const prompt = buildIntentModelPrompt({ sentence, vocabulary });
      const reply = yield* oneShot
        .run({
          prompt,
          role: "intent",
          // Every field required, so a partial answer is a decode failure rather than a silent
          // default; every id is checked against the environment afterwards.
          outputSchema: Schema.Struct({
            kind: Schema.String,
            statusQuestion: Schema.NullOr(Schema.String),
            workSessionId: Schema.NullOr(Schema.String),
            projectId: Schema.NullOr(Schema.String),
            providerInstanceId: Schema.NullOr(Schema.String),
            title: Schema.NullOr(Schema.String),
            message: Schema.NullOr(Schema.String),
            firingId: Schema.NullOr(Schema.String),
            confirmed: Schema.NullOr(Schema.Boolean),
            description: Schema.String,
            confidence: Schema.String,
            question: Schema.NullOr(Schema.String),
          }),
        })
        .pipe(
          // A model that fails, times out or returns nonsense leaves the
          // grammar's refusal standing. It is a worse answer than a good reading
          // and a much better one than a guess.
          Effect.catchCause((cause) =>
            Effect.logWarning("Tessaya could not read a sentence with a model", {
              sentence,
              instanceId: chosen.instanceId,
              model: chosen.model,
              // Flattened: the structured logger renders a Cause as
              // `[Object]`, which is exactly no help at the one moment somebody
              // is reading this line.
              errors: Cause.prettyErrors(cause).map((error) => error.message),
            }).pipe(Effect.as(null)),
          ),
        );
      if (reply === null) return null;

      const resolution = interpretIntentModelReply({
        sentence,
        // The driver's result is structurally this shape; the fields it names
        // are checked against the environment inside `interpretIntentModelReply`,
        // which is where every id becomes real or the sentence is refused.
        reply: reply as IntentModelReply,
        vocabulary,
      });

      return { resolution, model: chosen.model } satisfies IntentInterpretation;
    });

  return { interpret } satisfies BatonIntentInterpreter["Service"];
});

export const layer = Layer.effect(BatonIntentInterpreter, make);
