import { it } from "@effect/vitest";
import { LEDGERED_DIR } from "@t3tools/tessaya-shared/brainRoutes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import { BrainUsage, type UsageRow } from "./BrainUsage.ts";
import * as TessayaOneShot from "./TessayaOneShot.ts";

const encoder = new TextEncoder();

/** A `claude -p` that prints `stdout` and exits `code`; it keeps the folder each call ran from. */
const cli = (stdout: string, code: number, cwds: Array<string | undefined>) =>
  ChildProcessSpawner.make((command) => {
    cwds.push(ChildProcess.isStandardCommand(command) ? command.options.cwd : undefined);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_003),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

const oneShot = (stdout: string, code: number) => {
  const rows: Array<UsageRow> = [];
  const cwds: Array<string | undefined> = [];
  const layer = Layer.effect(TessayaOneShot.TessayaOneShot, TessayaOneShot.make).pipe(
    Layer.provide(
      Layer.mock(BrainUsage)({ record: (row) => Effect.sync(() => void rows.push(row)) }),
    ),
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, cli(stdout, code, cwds))),
  );
  const run = Effect.flatMap(TessayaOneShot.TessayaOneShot, (s) =>
    s.run({
      prompt: "hi",
      outputSchema: Schema.Struct({ ok: Schema.Boolean }),
      role: "synopsis",
      feature: "synopsis",
    }),
  ).pipe(Effect.provide(layer));
  return { rows, cwds, run };
};

it.effect(
  "records every one-shot, failed ones too, and runs it where T3's scan won't count it",
  () =>
    Effect.gen(function* () {
      const result = {
        type: "result",
        structured_output: { ok: true },
        modelUsage: { "claude-sonnet-5-5": { inputTokens: 3, outputTokens: 7 } },
      };
      const worked = oneShot(JSON.stringify(result), 0);
      expect(yield* worked.run).toEqual({ ok: true });
      expect(worked.rows).toEqual([
        expect.objectContaining({
          model: "claude-sonnet-5-5",
          input: 3,
          output: 7,
          attribution: { feature: "synopsis", origin: "system", surface: "server" },
        }),
      ]);
      expect(worked.cwds[0]?.endsWith(LEDGERED_DIR)).toBe(true);

      const failed = oneShot("", 1);
      yield* Effect.flip(failed.run);
      expect(failed.rows).toEqual([
        // Why it failed is on its row (18 Nov 23:07: "lines: sonnet failed" with no reason anywhere).
        expect.objectContaining({
          outcome: "failed",
          input: 0,
          output: 0,
          why: "claude exited 1: ",
        }),
      ]);
    }),
);
