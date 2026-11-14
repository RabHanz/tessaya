import { assert, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { gateThreadSend } from "./AgentMessageGate.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaRecordService, layer as recordLayer } from "./TessayaRecordService.ts";

const TARGET = ThreadId.make("thread:target");

/** A call from another environment's link, by its session, to a thread here. */
const fromLink = (sessionId: string, label = "Ann's laptop") =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        thread: undefined,
        client: { sessionId, label, access: "full-access", linked: true },
      } as never),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        getThreadShell: () =>
          Effect.succeed({
            id: TARGET,
            title: "Fix the checkout",
            projectId: "project:shop",
            deletedAt: null,
          } as never),
      } as never),
    ),
  );

const failed = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

const layer = it.layer(recordLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("the agent-message gate", (it) => {
  it.effect("records each send and each refusal from further in, keyed by the link's session", () =>
    Effect.gen(function* () {
      const record = yield* TessayaRecordService;
      yield* gateThreadSend({ threadId: TARGET }, Effect.void).pipe(fromLink("link-a"));
      // Same name, another link: its own sender.
      yield* gateThreadSend({ threadId: TARGET }, Effect.void).pipe(fromLink("link-b"));
      yield* gateThreadSend({ threadId: TARGET }, Effect.fail(failed("fenced"))).pipe(
        fromLink("link-a"),
        Effect.flip,
      );
      const rows = yield* record.query({ kind: "agent_message" });
      assert.deepStrictEqual(
        rows.map((r) => [r.actor, r.outcome, r.detail]),
        [
          ["link:link-a", "refused", "fenced"],
          ["link:link-b", "sent", ""],
          ["link:link-a", "sent", ""],
        ],
      );
    }),
  );

  it.effect("lets 30 of 31 sends started at once through, and refuses the last by the limit", () =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        Array.from({ length: 31 }, () =>
          gateThreadSend({ threadId: TARGET }, Effect.void).pipe(
            fromLink("link-race"),
            Effect.result,
          ),
        ),
        { concurrency: "unbounded" },
      );
      const refused = results.filter((r) => r._tag === "Failure");
      assert.strictEqual(refused.length, 1);
      assert.include(String(refused[0]), "30 messages in the last minute");
      // A flood is refused every time and recorded once a minute.
      for (let i = 0; i < 3; i += 1)
        yield* gateThreadSend({ threadId: TARGET }, Effect.void).pipe(
          fromLink("link-race"),
          Effect.flip,
        );
      const record = yield* TessayaRecordService;
      const rows = yield* record.query({ kind: "agent_message", actor: "link:link-race" });
      assert.strictEqual(rows.filter((r) => r.outcome === "refused").length, 1);
      assert.strictEqual(rows.filter((r) => r.outcome === "sent").length, 30);
    }),
  );

  it.effect("a send within one delegation tree is not gated or recorded", () =>
    Effect.gen(function* () {
      const record = yield* TessayaRecordService;
      const shell = (id: string) =>
        ({
          id,
          title: id,
          projectId: "project:shop",
          deletedAt: null,
          runtimeMode: "full-access",
          interactionMode: "default",
          lineage: { rootThreadId: "thread:root-tree" },
        }) as never;
      let sent = 0;
      yield* gateThreadSend(
        { threadId: ThreadId.make("thread:child") },
        Effect.sync(() => (sent += 1)),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              thread: { threadId: "thread:parent" },
              client: undefined,
            } as never),
            Layer.succeed(ThreadManagement.ThreadManagementService, {
              getThreadShell: (id: string) => Effect.succeed(shell(id)),
            } as never),
          ),
        ),
      );
      assert.strictEqual(sent, 1);
      const rows = yield* record.query({ kind: "agent_message", actor: "thread:thread:root-tree" });
      assert.strictEqual(rows.length, 0);
    }),
  );
});

it.effect(
  "a Record that cannot be read or written never blocks a send or turns it into a failure",
  () =>
    Effect.gen(function* () {
      let sent = 0;
      const broken = TessayaRecordService.of({
        append: () => Effect.die("disk full"),
        appendFromClient: () => Effect.die("disk full"),
        query: () => Effect.die("locked"),
      });
      const result = yield* gateThreadSend(
        { threadId: TARGET },
        Effect.sync(() => (sent += 1)),
      ).pipe(fromLink("link-broken"), Effect.provideService(TessayaRecordService, broken));
      assert.strictEqual(result, 1);
      assert.strictEqual(sent, 1);
    }),
);
