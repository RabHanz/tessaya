import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

/** Single-executable builds lack Node to run `-e`, so the memory embedding child (MEM-13) runs as this subcommand. */
export const memoryEmbedCommand = Command.make("__memory-embed", {}).pipe(
  Command.unlisted,
  Command.withHandler(() =>
    // The child lives on its IPC channel and exits when the server disconnects; the command must not return first.
    Effect.promise(() => import("../tessaya/TessayaMemoryEmbedder.ts")).pipe(
      Effect.flatMap(({ runMemoryEmbedChild }) => Effect.sync(runMemoryEmbedChild)),
      Effect.andThen(Effect.never),
    ),
  ),
);
