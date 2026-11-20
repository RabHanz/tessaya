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
import * as HostProcess from "@t3tools/shared/HostProcess";

import { deferredRole, onSubscription, routeFor } from "./BrainRoutes.ts";
import type { UsageAttribution } from "@t3tools/tessaya-contracts";

import { BrainUsage, cliTokens, ledgeredCwd, layer as brainUsageLayer } from "./BrainUsage.ts";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";
import { ProviderDriverKind } from "@t3tools/tessaya-contracts";
import { LIMIT_TEXT } from "@t3tools/tessaya-shared/liveTranscript";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AccountPoolService } from "./AccountPoolService.ts";
import { AccountRotationPolicy } from "./AccountRotationPolicy.ts";
import { rotationTick } from "./AccountRotationReactor.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";

/** The claude CLI to spawn: on Windows a bare `claude` is an npm .cmd shim that cannot be spawned without a shell. */
export const claudeProgram = Effect.flatMap(HostProcess.Environment, (env) =>
  resolveClaudeSdkExecutablePath("claude", env),
);

const TIMEOUT = "90 seconds";

export class TessayaOneShotError extends Schema.TaggedError<TessayaOneShotError>()(
  "BatonOneShotError",
  { detail: Schema.String },
) {}

export class TessayaOneShot extends Context.Service<
  TessayaOneShot,
  {
    readonly run: <S extends Schema.Top>(input: {
      readonly prompt: string;
      readonly outputSchema: S;
      /** Which kind of work this is: the brain's routing table picks the model (BrainRoutes). */
      readonly role: BrainRole;
      /** The product feature this call serves, for its usage row: `synopsis`, `intent`, `lines`… */
      readonly feature: string;
      /** More of what it was for and what started it; her own upkeep on the server when absent. */
      readonly attribution?: Partial<UsageAttribution>;
      /** A model he chose for this call (the prompt lab), still on his subscription. */
      readonly model?: string;
      /** Replaces Claude Code's own system prompt. */
      readonly system?: string;
    }) => Effect.Effect<S["Type"], TessayaOneShotError, S["DecodingServices"]>;
  }
>()("t3/tessaya/TessayaOneShot") {}

/** Claude Code's `--output-format json` result: one envelope, or the message list ending in one. */
export function resultOf(stdout: string): { structured_output?: unknown } | undefined {
  const parsed: unknown = JSON.parse(stdout);
  return Array.isArray(parsed)
    ? parsed.findLast((message: { type?: unknown }) => message?.type === "result")
    : (parsed as { structured_output?: unknown } | undefined);
}

const CLAUDE = ProviderDriverKind.make("claudeAgent");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const usage = yield* BrainUsage;

  /**
   * The machine login a one-shot runs on hit its limit: the same rotation the reactor makes (cswap's pool, his
   * policy), now rather than at its next tick, and on the Record. True when another account is active.
   */
  const rotateOnLimit = Effect.fn("TessayaOneShot.rotateOnLimit")(function* (why: string) {
    const pool = yield* Effect.serviceOption(AccountPoolService);
    const policy = yield* Effect.serviceOption(AccountRotationPolicy);
    if (Option.isNone(pool) || Option.isNone(policy) || (yield* policy.value.read) !== "auto")
      return false;
    const current = yield* pool.value.read(CLAUDE).pipe(Effect.option);
    if (Option.isNone(current)) return false;
    const decision = rotationTick({
      pool: current.value,
      policy: "auto",
      lastAutoRotationAt: null,
      now: DateTime.formatIso(yield* DateTime.now),
      stoppedOnLimit: true,
    });
    if (decision.outcome !== "rotate") return false;
    const moved = yield* pool.value
      .activate({
        driver: CLAUDE,
        key: decision.target.key,
        reason: decision.reason,
        workSessionId: null,
      })
      .pipe(Effect.option);
    if (Option.isNone(moved)) return false;
    const record = yield* Effect.serviceOption(TessayaRecordService);
    if (Option.isSome(record))
      yield* record.value.append({
        kind: "account_switch",
        actor: "tessaya",
        subject: `Account ${decision.from?.label ?? "?"} → ${decision.target.label}`,
        outcome: "moved on a limit (brain call)",
        detail: why.slice(0, 200),
      });
    return true;
  });

  const once: TessayaOneShot["Service"]["run"] = ({
    prompt,
    outputSchema,
    role,
    feature,
    attribution,
    system,
    ...chosen
  }) =>
    Effect.gen(function* () {
      const route = yield* routeFor(role).pipe(
        Effect.mapError(
          () => new TessayaOneShotError({ detail: "the brain's settings could not be read" }),
        ),
      );
      const waits = yield* deferredRole(role);
      if (waits !== null) {
        yield* Effect.logInfo("brain: a one-shot waits for the reset", { role, why: waits });
        return yield* new TessayaOneShotError({ detail: waits });
      }
      const path = onSubscription(route);
      if ("refused" in path) {
        yield* Effect.logWarning("brain: a one-shot was refused", { role, why: path.refused });
        return yield* new TessayaOneShotError({ detail: path.refused });
      }
      const model = chosen.model ?? path.model;
      const row = {
        role,
        credential: "subscription",
        attribution: { origin: "system", surface: "server", ...attribution, feature },
      } as const;
      // @effect-diagnostics-next-line globalJsonInEffect:off - a JSON Schema object, always serialisable.
      const jsonSchema = JSON.stringify(toJsonSchemaObject(outputSchema));
      const command = ChildProcess.make(
        yield* claudeProgram,
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
        {
          cwd: ledgeredCwd(),
          stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
          forceKillAfter: "1 second",
        },
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
            return yield* new TessayaOneShotError({
              detail: `claude exited ${code}: ${(err.trim() || out.trim()).slice(0, 400)}`,
            });
          }
          return out;
        }),
      ).pipe(
        Effect.timeout(TIMEOUT),
        Effect.mapError((cause) =>
          cause instanceof TessayaOneShotError
            ? cause
            : new TessayaOneShotError({ detail: String(cause) }),
        ),
        // A call that ran and failed still spent: its row says so, with no tokens it could count.
        Effect.tapError((e) =>
          usage.record({
            ...row,
            model,
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            outcome: "failed",
            why: e.detail,
          }),
        ),
      );
      const result = yield* Effect.try({
        try: () => resultOf(stdout),
        catch: () => new TessayaOneShotError({ detail: "claude returned output that is not JSON" }),
      });
      // An exit 0 that is an error envelope (a limit says so here too) fails with its words.
      const envelope = result as { is_error?: unknown; result?: unknown } | undefined;
      if (envelope?.is_error === true)
        return yield* new TessayaOneShotError({
          detail: `claude: ${String(envelope.result ?? "").slice(0, 400)}`,
        });
      for (const tokens of cliTokens(result, model)) yield* usage.record({ ...row, ...tokens });
      return yield* Schema.decodeUnknownEffect(outputSchema)(result?.structured_output).pipe(
        Effect.mapError(
          () => new TessayaOneShotError({ detail: "claude returned invalid structured output" }),
        ),
      );
    });

  // A limit moves the machine login to an account still active and tries the call once more.
  const run: TessayaOneShot["Service"]["run"] = (input) =>
    once(input).pipe(
      Effect.catchIf(
        (e) => LIMIT_TEXT.test(e.detail),
        (e) =>
          Effect.flatMap(rotateOnLimit(e.detail), (moved) =>
            moved ? once(input) : Effect.fail(e),
          ),
      ),
    );

  return { run } satisfies TessayaOneShot["Service"];
});

export const layer = Layer.effect(TessayaOneShot, make).pipe(Layer.provide(brainUsageLayer));
