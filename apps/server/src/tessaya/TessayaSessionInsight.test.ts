// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it, vi } from "@effect/vitest";
import type { TessayaSessionSummary } from "@t3tools/tessaya-contracts";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import * as TessayaEngine from "./TessayaEngine.ts";
import { TessayaHousehold } from "./TessayaHousehold.ts";
import { TessayaJobService } from "./TessayaJobService.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { TessayaRecordService, layer as recordLayer } from "./TessayaRecordService.ts";
import { TessayaSessionInsight, layer } from "./TessayaSessionInsight.ts";
import { TessayaSessionsAcross } from "./TessayaSessionsAcross.ts";
import { TessayaWeaveService } from "./TessayaWeaveService.ts";

const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-insight-"));
NodeFS.mkdirSync(NodePath.join(userdata, "operating-system", "roles"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(userdata, "operating-system", "roles", "diary.md"),
  "---\nname: Diary\nprivate: yes\n---\nKeeps his diary.",
);

const row = (
  key: string,
  session: string,
  thread: string | null,
  pane: string | null = null,
): TessayaSessionSummary => ({
  key,
  session,
  project: "t3code",
  account: null,
  state: "working",
  urgent: false,
  box: "studio",
  updatedAt: "2026-11-20T02:00:00Z",
  thread: thread === null ? null : { environmentId: "env-here", threadId: thread },
  pane: pane === null ? null : { environmentId: "env-here", pane },
  access: null,
});

const setup = (
  messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }> = [
    { role: "user", text: "rerun the speed tests" },
    {
      role: "assistant",
      text: `Ran them; opened https://github.com/acme/tessaya/pull/1596. Key ${"sk-" + "ant-api03-" + "a".repeat(40)}`,
    },
  ],
) => {
  const sent: Array<{ to: string; text: string }> = [];
  const threadSends: Array<{ readonly threadId: ThreadId; readonly text: string }> = [];
  const prompts: Array<string> = [];
  const peerCalls: Array<[string, unknown]> = [];
  const services = Layer.mergeAll(
    Layer.succeed(TessayaSessionsAcross, {
      list: () =>
        Effect.succeed({
          here: { environmentId: "env-here", label: "studio" },
          sessions: [
            row("work:env-here:t-build", "Build lane", "t-build"),
            row("work:env-here:j-diary", "Diary notes", "t-diary"),
            row("claude:c0ffee12-0001", "Parity sync", null, "p-7"),
            row("work:env-here:j-shop", "Checkout fix", "t-shop"),
            {
              ...row("thread:env-laptop:t-print", "V-Minion printer", "t-print"),
              box: "Laptop",
              thread: { environmentId: "env-laptop", threadId: "t-print" },
              access: "approval-required",
            },
          ],
          unreachable: [],
        }),
    }),
    TessayaEngine.layerStatic({
      sent: threadSends,
      messages,
    }),
    Layer.mock(PeerLinks.PeerLinks)({
      list: Effect.succeed([{ environmentId: "env-laptop", label: "Laptop" }] as never),
    }),
    Layer.mock(PeerMcpClient.PeerMcpClient)({
      call: (input: { readonly tool: string; readonly arguments: unknown }) =>
        Effect.sync(() => {
          peerCalls.push([input.tool, input.arguments]);
          return { status: "queued", text: "", session: "V-Minion printer", line: "" } as never;
        }),
    } as never),
    Layer.mock(TessayaWeaveService)({
      send: (input) =>
        Effect.sync(() => {
          sent.push(input);
          return {
            id: "w1",
            from: input.from ?? "",
            toLabel: input.to,
            toPane: "p1",
            text: input.text,
            status: "delivered" as const,
            reason: null,
            job: null,
            tries: 1,
            createdAt: 0,
            deliveredAt: 0,
            repliedAt: null,
            reply: null,
          };
        }),
      tick: Effect.succeed({ delivered: 1, replied: 0 }),
    }),
    Layer.succeed(ServerConfig.ServerConfig, {
      dbPath: NodePath.join(userdata, "statev2.sqlite"),
    } as unknown as ServerConfig.ServerConfig["Service"]),
    Layer.mock(TessayaJobService)({
      personas: () => Effect.succeed(new Map([["j-diary", "diary"]])),
      terms: (id) => Effect.succeed(id === "j-shop" ? ({ phase: "approved" } as never) : null),
    }),
    Layer.mock(TessayaHousehold)({
      grantsOf: () => Effect.succeed({ role: "owner" as const, machine: false, name: "Sam" }),
    }),
    Layer.mock(TessayaOneShot)({
      run: (input) =>
        Effect.sync(() => {
          prompts.push(input.prompt);
          return {
            goal: "Make the speed tests pass",
            lastStep: "Ran the speed tests",
            now: "Waiting on CI",
            waitingOn: "CI",
            files: [],
            errors: [],
          } as never;
        }),
    }),
  );
  return {
    sent,
    threadSends,
    prompts,
    peerCalls,
    layer: layer.pipe(
      Layer.provideMerge(services),
      Layer.provideMerge(recordLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  };
};

it.effect(
  "summarises a session from a redacted excerpt, and a private one only by its state",
  () => {
    const { prompts, layer } = setup();
    return Effect.gen(function* () {
      const insight = yield* TessayaSessionInsight;
      const build = yield* insight.insight({ session: "what's the build session doing" });
      assert.strictEqual(build.key, "work:env-here:t-build");
      assert.strictEqual(build.lastStep, "Ran the speed tests");
      assert.strictEqual(build.prs[0]?.url, "https://github.com/acme/tessaya/pull/1596");
      assert.notInclude(prompts.join(""), "sk-ant");

      const diary = yield* insight.insight({ session: "diary" });
      assert.isTrue(diary.private);
      assert.isNull(diary.goal);
      assert.strictEqual(prompts.length, 1);

      assert.strictEqual(
        (yield* insight.insight({ session: "checkout" })).job,
        "a job at work on its agreed plan",
      );
      assert.isNull(build.job);
      const missing = yield* insight.insight({ session: "mascot" });
      assert.isFalse(missing.found);

      // A terminal session reads its live mirror thread, not the daily history index.
      const parity = yield* insight.insight({ session: "parity" });
      assert.strictEqual(parity.lastStep, "Ran the speed tests");
      assert.notInclude(prompts.join(""), "sk-ant");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "says why a terminal session with no live copy and no history index can't be read",
  () => {
    vi.stubEnv("TESSAYA_HISTORY_SEARCH", "");
    const { layer } = setup([]);
    return Effect.gen(function* () {
      const parity = yield* (yield* TessayaSessionInsight).insight({ session: "parity" });
      assert.strictEqual(
        parity.line,
        "Parity sync is working, but I can't read it: studio has no live copy of it and no history index.",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  },
);

it.effect("reads his words back first, then sends them marked as his, and records the send", () => {
  const { sent, threadSends, layer } = setup();
  return Effect.gen(function* () {
    const insight = yield* TessayaSessionInsight;
    const back = yield* insight.steer({ session: "build", text: "rerun the tests" });
    assert.strictEqual(back.status, "read_back");
    assert.strictEqual(back.text, "From Sam, via Tessaya: rerun the tests");
    assert.lengthOf(sent, 0);

    // A T3 thread takes it as its next message; a terminal pane through weave; a job through job_refine instead.
    const go = yield* insight.steer({ session: "build", text: "rerun the tests", confirmed: true });
    assert.strictEqual(go.status, "sent");
    assert.deepStrictEqual(
      threadSends.map((s) => [s.threadId, s.text]),
      [["t-build", "From Sam, via Tessaya: rerun the tests"]],
    );
    yield* insight.steer({ session: "parity", text: "rebase it", confirmed: true });
    assert.deepStrictEqual(
      sent.map((s) => [s.to, s.text]),
      [["Parity sync", "From Sam, via Tessaya: rebase it"]],
    );
    const job = yield* insight.steer({
      session: "checkout",
      text: "skip the docs",
      confirmed: true,
    });
    assert.strictEqual(job.status, "is_job");
    assert.include(job.line, "job_refine");
    assert.lengthOf(threadSends, 1);
    const rows = yield* (yield* TessayaRecordService).query({ kind: "steer", limit: 5 });
    assert.sameMembers(
      rows.map((r) => r.detail),
      ["From Sam, via Tessaya: rerun the tests", "From Sam, via Tessaya: rebase it"],
    );
  }).pipe(Effect.provide(layer));
});

// A plain T3 thread on his laptop (21 Nov: the printer thread could not be reached): the laptop sends his words.
it.effect(
  "sends to a plain thread on a linked server through that server, his words read back here",
  () => {
    const { peerCalls, threadSends, layer } = setup();
    return Effect.gen(function* () {
      const insight = yield* TessayaSessionInsight;
      const back = yield* insight.steer({ session: "printer", text: "camera URL?" });
      assert.strictEqual(back.status, "read_back");
      assert.lengthOf(peerCalls, 0);
      const go = yield* insight.steer({ session: "printer", text: "camera URL?", confirmed: true });
      assert.strictEqual(go.status, "queued");
      assert.deepStrictEqual(peerCalls, [
        [
          "tessaya_session_steer",
          { session: "thread:env-laptop:t-print", text: "camera URL?", confirmed: true },
        ],
      ]);
      assert.lengthOf(threadSends, 0);
    }).pipe(Effect.provide(layer));
  },
);
