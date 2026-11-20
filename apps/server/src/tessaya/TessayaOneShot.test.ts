import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { LEDGERED_DIR } from "@t3tools/tessaya-shared/brainRoutes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import { ClaudeExecutableFileCheck } from "../provider/Drivers/ClaudeExecutable.ts";
import type { TessayaAccountPool } from "@t3tools/tessaya-contracts";
import { AccountPoolService } from "./AccountPoolService.ts";
import { AccountRotationPolicy } from "./AccountRotationPolicy.ts";
import { BrainUsage, type UsageRow } from "./BrainUsage.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";
import * as TessayaOneShot from "./TessayaOneShot.ts";

const encoder = new TextEncoder();

/** A `claude -p` that prints `stdout` and exits `code`; it keeps the folder and program each call ran. */
const cli = (
  stdout: string,
  code: number,
  cwds: Array<string | undefined>,
  programs: Array<string | undefined>,
) =>
  ChildProcessSpawner.make((command) => {
    cwds.push(ChildProcess.isStandardCommand(command) ? command.options.cwd : undefined);
    programs.push(ChildProcess.isStandardCommand(command) ? command.command : undefined);
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
  const programs: Array<string | undefined> = [];
  const layer = Layer.effect(TessayaOneShot.TessayaOneShot, TessayaOneShot.make).pipe(
    Layer.provide(
      Layer.mock(BrainUsage)({ record: (row) => Effect.sync(() => void rows.push(row)) }),
    ),
    Layer.provide(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, cli(stdout, code, cwds, programs)),
    ),
  );
  const run = Effect.flatMap(TessayaOneShot.TessayaOneShot, (s) =>
    s.run({
      prompt: "hi",
      outputSchema: Schema.Struct({ ok: Schema.Boolean }),
      role: "synopsis",
      feature: "synopsis",
    }),
  ).pipe(Effect.provide(layer));
  return { rows, cwds, programs, run };
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

const NPM = "C:\\Users\\him\\AppData\\Roaming\\npm";
const EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

it.effect(
  "runs the packaged claude.exe on Windows, where a bare claude is an npm shim it cannot spawn",
  () =>
    Effect.gen(function* () {
      // 19 Nov: his laptop's server failed every one-shot (ENOENT) since claude there is only claude.cmd.
      const call = oneShot(JSON.stringify({ type: "result", structured_output: { ok: true } }), 0);
      yield* call.run.pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, () => `${NPM}\\claude.cmd`),
        Effect.provideService(ClaudeExecutableFileCheck, (file) => file === EXE),
      );
      expect(call.programs).toEqual([EXE]);
    }),
);

it.effect(
  "moves the machine login to an account with room on a limit, records it, and tries once more",
  () =>
    Effect.gen(function* () {
      // 20 Nov: her private turn said the weekly limit was out, with another account free.
      const limited = JSON.stringify({
        type: "result",
        is_error: true,
        result: "You've hit your weekly limit · resets Mon 9am",
      });
      const ok = JSON.stringify({ type: "result", structured_output: { ok: true } });
      let calls = 0;
      const spawner = ChildProcessSpawner.make(() => {
        calls += 1;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(900_000_004),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(calls === 1 ? 1 : 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.succeed(encoder.encode(calls === 1 ? limited : ok)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const account = (key: string, active: boolean, used: number) => ({
        key,
        label: key,
        email: null,
        organizationName: null,
        active,
        usable: true,
        unusableReason: null,
        headroomPercent: 100 - used,
        windows: [{ id: "weekly", label: "week", usedPercent: used, resetsAt: null }],
        usageCheckedAt: "2026-11-20T02:00:00.000Z",
      });
      const pool = {
        driver: "claudeAgent",
        source: "cswap",
        configDir: "/home/dev/.claude",
        // His reading still shows room: the limit the call hit outranks it.
        accounts: [account("a", true, 60), account("b", false, 10)],
        checkedAt: "2026-11-20T02:00:00.000Z",
      } as unknown as TessayaAccountPool;
      const activated: Array<string> = [];
      const recorded: Array<string> = [];
      const service = yield* Effect.provide(
        TessayaOneShot.TessayaOneShot,
        Layer.effect(TessayaOneShot.TessayaOneShot, TessayaOneShot.make).pipe(
          Layer.provide(Layer.mock(BrainUsage)({ record: () => Effect.void })),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      );
      const result = yield* service
        .run({
          prompt: "hi",
          outputSchema: Schema.Struct({ ok: Schema.Boolean }),
          role: "voice",
          feature: "private-turn",
        })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(AccountPoolService)({
                read: () => Effect.succeed(pool),
                activate: (input) =>
                  Effect.sync(() => {
                    activated.push(input.key);
                    return { rotation: {}, pool } as never;
                  }),
              }),
              Layer.mock(AccountRotationPolicy)({ read: Effect.succeed("auto") }),
              Layer.mock(TessayaRecordService)({
                append: (row) =>
                  Effect.sync(() => void recorded.push(`${row.kind}: ${row.subject}`)),
              }),
            ),
          ),
        );
      expect(result).toEqual({ ok: true });
      expect(calls).toBe(2);
      expect(activated).toEqual(["b"]);
      expect(recorded).toEqual(["account_switch: Account a → b"]);
    }),
);
