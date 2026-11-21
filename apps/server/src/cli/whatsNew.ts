import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const Titles = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeTitles = Schema.decodeEffect(Titles);
const Recorded = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Struct({ items: Schema.Array(Schema.String) })),
  content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
});
const decodeRecorded = Schema.decodeUnknownEffect(Recorded);

class WhatsNewRecordError extends Schema.TaggedError<WhatsNewRecordError>()("WhatsNewRecordError", {
  message: Schema.String,
}) {}

const whatsNewRecordCommand = Command.make("record", {
  ...projectLocationFlags,
  surface: Flag.Literals("surface", ["server", "loop", "desktop", "firmware", "phone"]).pipe(
    Flag.withDescription("Which part of her the release shipped."),
  ),
  version: Flag.String("version").pipe(Flag.withDescription("The release's version.")),
  titles: Flag.String("titles-file").pipe(
    Flag.withDescription("A JSON array of the release's merged PR titles."),
  ),
}).pipe(
  Command.withDescription(
    "Record a release that just went live, so she can say what's new (tessaya_whats_new_record).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The tool takes at most 40 titles of up to 200 characters.
      const titles = (yield* decodeTitles(yield* fs.readFileString(flags.titles)))
        .map((t) => t.trim().slice(0, 200))
        .filter((t) => t.length > 0)
        .slice(0, 40);
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      // The owner's short-lived MCP session on the running server, as `t3 memory unlearn` signs in; revoked at the end.
      return yield* Effect.gen(function* () {
        const runtime = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
        if (Option.isNone(runtime))
          return yield* new WhatsNewRecordError({ message: "The T3 Code server is not running." });
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* Effect.acquireRelease(
          auth.issueMcpClientSession({
            label: "t3 whats-new cli",
            access: "full-access",
            peerLink: false,
            client: { deviceType: "bot" },
          }),
          (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
        );
        const session = yield* mcpToolSession({
          endpoint: new URL("/mcp", runtime.value.origin).href,
          authorization: `Bearer ${issued.token}`,
          clientName: "t3-whats-new-cli",
        });
        const result = yield* decodeRecorded(
          yield* session.call("tessaya_whats_new_record", {
            surface: flags.surface,
            version: flags.version,
            titles,
          }),
        );
        if (result.isError === true || result.structuredContent === undefined)
          return yield* new WhatsNewRecordError({
            message: result.content?.find((c) => c.text !== undefined)?.text ?? "It failed.",
          });
        yield* Console.log(
          `Recorded ${flags.surface} ${flags.version}: ${result.structuredContent.items.join(" | ")}`,
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

export const whatsNewCommand = Command.make("whats-new").pipe(
  Command.withDescription("What's new in her, on the running server."),
  Command.withSubcommands([whatsNewRecordCommand]),
);
