/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * A structured one-shot to Claude Code (`claude -p --json-schema`), for the two places Baton
 * asks a model: reading a sentence the grammar refused (D50) and writing the synopsis (D51).
 *
 * Upstream's text generation only exposes its own operations (commit message, PR, branch,
 * title, review guide), so Baton runs the CLI itself, with the same isolation upstream's runner
 * uses: no tools, no slash commands, no MCP, no hooks, `dontAsk`. It runs as the box's primary
 * Claude home, which is the account cswap has active (D79).
 */
import type { BrainRole } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";

import { deferredRole, onSubscription, routeFor } from "./BrainRoutes.ts";
import { BrainUsage, cliTokens, layer as brainUsageLayer } from "./BrainUsage.ts";

const TIMEOUT = "90 seconds";

export class BatonOneShotError extends Schema.TaggedError<BatonOneShotError>()(
  "BatonOneShotError",
  { detail: Schema.String },
) {}

export class BatonOneShot extends Context.Service<
  BatonOneShot,
  {
    readonly run: <S extends Schema.Top>(input: {
      readonly prompt: string;
      readonly outputSchema: S;
      /** Which kind of work this is: the brain's routing table picks the model (BrainRoutes). */
      readonly role: BrainRole;
      /** A model he chose for this call (the prompt lab), still on his subscription. */
      readonly model?: string;
      /** Replaces Claude Code's own system prompt. */
      readonly system?: string;
    }) => Effect.Effect<S["Type"], BatonOneShotError, S["DecodingServices"]>;
  }
>()("t3/baton/BatonOneShot") {}

/** Claude Code's `--output-format json` result: one envelope, or the message list ending in one. */
export function resultOf(stdout: string): { structured_output?: unknown } | undefined {
  const parsed: unknown = JSON.parse(stdout);
  return Array.isArray(parsed)
    ? parsed.findLast((message: { type?: unknown }) => message?.type === "result")
    : (parsed as { structured_output?: unknown } | undefined);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const usage = yield* BrainUsage;

  const run: BatonOneShot["Service"]["run"] = ({ prompt, outputSchema, role, system, ...chosen }) =>
    Effect.gen(function* () {
      const route = yield* routeFor(role).pipe(
        Effect.mapError(
          () => new BatonOneShotError({ detail: "the brain's settings could not be read" }),
        ),
      );
      const waits = yield* deferredRole(role);
      if (waits !== null) {
        yield* Effect.logInfo("brain: a one-shot waits for the reset", { role, why: waits });
        return yield* new BatonOneShotError({ detail: waits });
      }
      const path = onSubscription(route);
      if ("refused" in path) {
        yield* Effect.logWarning("brain: a one-shot was refused", { role, why: path.refused });
        return yield* new BatonOneShotError({ detail: path.refused });
      }
      const model = chosen.model ?? path.model;
      // @effect-diagnostics-next-line globalJsonInEffect:off - a JSON Schema object, always serialisable.
      const jsonSchema = JSON.stringify(toJsonSchemaObject(outputSchema));
      const command = ChildProcess.make(
        "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchema,
          "--model",
          model,
          "--settings",
          // Thinking off: a structured one-shot needs no scratchpad, and his own settings may turn it on
          // (measured on one sentence and model: 10.0 s with thinking, 6.0 s without).
          // @effect-diagnostics-next-line globalJsonInEffect:off - a fixed literal.
          JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false }),
          "--tools",
          "",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--permission-mode",
          "dontAsk",
          ...(system === undefined ? [] : ["--system-prompt", system]),
        ],
        { stdin: { stream: Stream.encodeText(Stream.make(prompt)) }, forceKillAfter: "1 second" },
      );
      const stdout = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(command);
          const [out, err, code] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(child.stdout)),
              Stream.mkString(Stream.decodeText(child.stderr)),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (code !== 0) {
            return yield* new BatonOneShotError({
              detail: `claude exited ${code}: ${(err.trim() || out.trim()).slice(0, 400)}`,
            });
          }
          return out;
        }),
      ).pipe(
        Effect.timeout(TIMEOUT),
        Effect.mapError((cause) =>
          cause instanceof BatonOneShotError
            ? cause
            : new BatonOneShotError({ detail: String(cause) }),
        ),
      );
      const result = yield* Effect.try({
        try: () => resultOf(stdout),
        catch: () => new BatonOneShotError({ detail: "claude returned output that is not JSON" }),
      });
      for (const tokens of cliTokens(result, model))
        yield* usage.record({ ...tokens, role, credential: "subscription" });
      return yield* Schema.decodeUnknownEffect(outputSchema)(result?.structured_output).pipe(
        Effect.mapError(
          () => new BatonOneShotError({ detail: "claude returned invalid structured output" }),
        ),
      );
    });

  return { run } satisfies BatonOneShot["Service"];
});

export const layer = Layer.effect(BatonOneShot, make).pipe(Layer.provide(brainUsageLayer));
