import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { MEMORY_UNLEARN_CLIENT } from "../mcp/McpInvocationContext.ts";
import { projectLocationFlags } from "./config.ts";
import { withThreadTools } from "./thread.ts";

/** The keep file `scripts/baton-unlearn-playback.ts` wrote from a read-only copy of her memory. */
const KeepFile = Schema.fromJsonString(
  Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: Schema.String })),
    talks: Schema.Array(Schema.Struct({ day: Schema.String, line: Schema.String })),
  }),
);
const decodeKeepFile = Schema.decodeEffect(KeepFile);
const Unlearned = Schema.Struct({ forgotten: Schema.Number, talks: Schema.Number });

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
      return yield* withThreadTools(
        flags,
        Effect.fn("cli.memory.unlearn")(function* (tools) {
          const done = yield* tools.call(
            "tessaya_memory_unlearn",
            { ids: kept.items.map((i) => i.id), talks: kept.talks, why: flags.why },
            Unlearned,
          );
          yield* Console.log(`Forgot ${done.forgotten} items and ${done.talks} talk lines.`);
        }),
        MEMORY_UNLEARN_CLIENT,
      );
    }),
  ),
);

export const memoryCommand = Command.make("memory").pipe(
  Command.withDescription("Her memory on the running server."),
  Command.withSubcommands([memoryUnlearnCommand]),
);
