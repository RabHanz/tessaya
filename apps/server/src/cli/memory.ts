import { MEMORY_UNLEARN_CLIENT } from "@t3tools/tessaya-shared/memory";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

/** The keep file `scripts/baton-unlearn-playback.ts` wrote from a read-only copy of her memory. */
const KeepFile = Schema.fromJsonString(
  Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: Schema.String })),
    talks: Schema.Array(Schema.Struct({ day: Schema.String, line: Schema.String })),
  }),
);
const decodeKeepFile = Schema.decodeEffect(KeepFile);
const Unlearned = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(
    Schema.Struct({ forgotten: Schema.Number, talks: Schema.Number }),
  ),
  content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
});
const decodeUnlearned = Schema.decodeUnknownEffect(Unlearned);

class MemoryUnlearnError extends Schema.TaggedError<MemoryUnlearnError>()("MemoryUnlearnError", {
  message: Schema.String,
}) {}

const memoryUnlearnCommand = Command.make("unlearn", {
  ...projectLocationFlags,
  keep: Argument.String("keep-file").pipe(
    Argument.withDescription(
      "The JSON the list pass wrote: the item ids and talk lines to forget.",
    ),
  ),
  why: Flag.String("why").pipe(
    Flag.withDescription("Why, for the action log."),
    Flag.withDefault("learned from test playback, not his speech"),
  ),
}).pipe(
  Command.withDescription(
    "Forget memory items and talk lines on the running server, through its memory service.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const kept = yield* decodeKeepFile(yield* fs.readFileString(flags.keep));
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      // The owner's short-lived MCP session on the running server, as `t3 thread` signs in; revoked at the end.
      return yield* Effect.gen(function* () {
        const runtime = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
        if (Option.isNone(runtime))
          return yield* new MemoryUnlearnError({ message: "The T3 Code server is not running." });
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* Effect.acquireRelease(
          auth.issueMcpClientSession({
            label: MEMORY_UNLEARN_CLIENT,
            access: "full-access",
            peerLink: false,
            client: { deviceType: "bot" },
          }),
          (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
        );
        const session = yield* mcpToolSession({
          endpoint: new URL("/mcp", runtime.value.origin).href,
          authorization: `Bearer ${issued.token}`,
          clientName: "t3-memory-cli",
        });
        const result = yield* decodeUnlearned(
          yield* session.call("tessaya_memory_unlearn", {
            ids: kept.items.map((i) => i.id),
            talks: kept.talks,
            why: flags.why,
          }),
        );
        if (result.isError === true || result.structuredContent === undefined)
          return yield* new MemoryUnlearnError({
            message: result.content?.find((c) => c.text !== undefined)?.text ?? "It failed.",
          });
        yield* Console.log(
          `Forgot ${result.structuredContent.forgotten} items and ${result.structuredContent.talks} talk lines.`,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
    }),
  ),
);

export const memoryCommand = Command.make("memory").pipe(
  Command.withDescription("Her memory on the running server."),
  Command.withSubcommands([memoryUnlearnCommand]),
);
