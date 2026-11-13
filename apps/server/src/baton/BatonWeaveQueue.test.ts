// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory } from "./BatonDatabase.ts";
import { holdServerLock, SERVER_LOCK_STALE_MS } from "./BatonLiveQueue.ts";
import {
  agentsOf,
  BatonWeaveBoxes,
  type SessionPane,
  withClaudeWaiting,
} from "./BatonWeaveBoxes.ts";
import { make as makeWeave, queueDirFor, WeaveStores } from "./BatonWeaveService.ts";
// @ts-expect-error -- plain JS shared with the live agent, which runs without a build
import * as bridge from "../../../../scripts/tessaya/live/baton-live-acp.mjs";

/** This machine's Herdr: where each session is now, what a send answers, and what was typed. */
const herdrOf = () => {
  const state = {
    where: new Map<string, SessionPane>(),
    answer: (_text: string) => ({ delivered: true, detail: "" }),
    typed: [] as Array<string>,
    asked: [] as Array<string>,
    listings: 0,
  };
  const box = {
    name: "here",
    adapter: {
      discover: Effect.succeed({ available: true, reason: "", candidates: [] }),
      sendInput: (input: { text: string; session: { location: { pane: string } } }) =>
        Effect.sync(() => {
          state.asked.push(input.text);
          const answer = state.answer(input.text);
          if (answer.delivered) state.typed.push(`${input.session.location.pane}: ${input.text}`);
          return answer;
        }),
    },
    agents: Effect.sync(() => {
      state.listings += 1;
      return new Map(state.where);
    }),
  };
  return { state, box };
};

const BLOCKED = {
  delivered: false,
  detail:
    "dev is waiting on a question or an approval in its terminal, so nothing was sent. Answer it there first, then send again.",
};

const setup = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "weave-queue-"));
  const herdr = herdrOf();
  const layer = Layer.mergeAll(
    layerMemory,
    Layer.succeed(BatonWeaveBoxes, [herdr.box] as never),
    Layer.succeed(WeaveStores, {
      liveQueueDir: () => dir,
      catalogFile: NodePath.join(dir, "baton-catalog-kept.json"),
    }),
  );
  const file = (name: string) => NodePath.join(dir, name);
  const write = (name: string, body: unknown) =>
    NodeFS.writeFileSync(file(name), typeof body === "string" ? body : JSON.stringify(body));
  const read = (name: string): unknown => JSON.parse(NodeFS.readFileSync(file(name), "utf8"));
  const inbound = (line: Record<string, unknown>, end = "\n") =>
    NodeFS.appendFileSync(file("inbound.ndjson"), `${JSON.stringify(line)}${end}`);
  const rows = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ to_pane: string; text: string; source: string | null; status: string }>`
      SELECT to_pane, text, source, status FROM fabric_weaves ORDER BY created_at, rowid
    `,
  ).pipe(Effect.orDie);
  return { dir, herdr: herdr.state, layer, file, write, read, inbound, rows };
};

const line = (id: string, sessionId: string, text: string, at = 1) => ({
  id,
  at,
  sessionId,
  text,
});

it.effect("takes in the three old stores once, in order, and moves each aside", () =>
  Effect.suspend(() => {
    const t = setup();
    t.write("sid-a.json", [
      { tries: 0, at: "t1", text: "live one" },
      { kind: "note", text: "Sent to build: hi", shown: "Sent to build: hi" },
      { tries: 1, at: "t2", text: "live two" },
    ]);
    t.write(
      "unbound-messages.ndjson",
      `${JSON.stringify({ id: "u1", at: "t", text: "kept one", threadId: "baton-live4:x" })}\n${JSON.stringify({ id: "u0", at: "t", text: "already sent", threadId: "baton-live4:x" })}\n`,
    );
    t.write("unbound-ledger.ndjson", `${JSON.stringify({ id: "u0", state: "claimed" })}\n`);
    t.write("baton-catalog-kept.json", { "sid-a": ["from the list"] });
    return Effect.gen(function* () {
      // Each start is its own scope, as a server restart is: the folder lock goes with it.
      const kept = yield* Effect.scoped(Effect.flatMap(makeWeave, (w) => w.catalogKept));
      assert.deepStrictEqual(
        (yield* t.rows).map((r) => [r.to_pane, r.text, r.source]),
        [
          ["session|sid-a", "live one", "thread"],
          ["session|sid-a", "live two", "thread"],
          ["thread|baton-live4:x", "kept one", "unbound"],
          ["session|sid-a", "from the list", "catalog"],
        ],
      );
      // The notes stay for the bridge to show; the text is moved aside, never deleted.
      assert.deepStrictEqual(t.read("sid-a.json"), [
        { kind: "note", text: "Sent to build: hi", shown: "Sent to build: hi" },
      ]);
      const names = NodeFS.readdirSync(t.dir);
      for (const store of [
        "sid-a.json",
        "unbound-messages.ndjson",
        "unbound-ledger.ndjson",
        "baton-catalog-kept.json",
      ])
        assert.isTrue(
          names.some((n) => n.startsWith(`${store}.migrated-`)),
          store,
        );
      assert.isFalse(names.includes("baton-catalog-kept.json"));
      assert.deepStrictEqual(t.read("sid-a.server"), { waiting: 2 });
      assert.deepStrictEqual(kept, { "sid-a": ["from the list"] });

      // A second start takes in nothing; nor does one after a crash between commit and move.
      yield* Effect.scoped(makeWeave);
      const aside = names.find((n) => n.startsWith("sid-a.json.migrated-"))!;
      NodeFS.copyFileSync(t.file(aside), t.file("sid-a.json"));
      yield* Effect.scoped(makeWeave);
      assert.strictEqual((yield* t.rows).length, 4);
      // A kept file that could not be moved aside is not sent again once its rows were sent and dropped.
      yield* Effect.scoped(Effect.flatMap(makeWeave, (w) => w.setCatalogKept({})));
      t.write("baton-catalog-kept.json", { "sid-a": ["from the list"] });
      const again = yield* Effect.scoped(Effect.flatMap(makeWeave, (w) => w.catalogKept));
      assert.deepStrictEqual(again, {});
    }).pipe(Effect.provide(t.layer));
  }),
);

it.effect("imports each inbound line once, across a restart mid-line and a replaced file", () =>
  Effect.suspend(() => {
    const t = setup();
    t.inbound(line("a", "s1", "first"));
    t.inbound(line("b", "s1", "second"));
    t.inbound(line("c", "s1", "third"), "");
    return Effect.gen(function* () {
      yield* Effect.scoped(Effect.flatMap(makeWeave, (before) => before.deliver));
      assert.deepStrictEqual(
        (yield* t.rows).map((r) => r.text),
        ["first", "second"],
      );
      // The half-written line is finished after the restart, and another follows.
      NodeFS.appendFileSync(t.file("inbound.ndjson"), "\n");
      t.inbound(line("d", "s1", "fourth"));
      const after = yield* makeWeave;
      yield* after.deliver;
      yield* after.deliver;
      NodeFS.writeFileSync(
        t.file("inbound.ndjson"),
        `${JSON.stringify(line("a", "s1", "first"))}\n`,
      );
      yield* after.deliver;
      assert.deepStrictEqual(
        (yield* t.rows).map((r) => [r.to_pane, r.text, r.status]),
        [
          ["session|s1", "first", "queued"],
          ["session|s1", "second", "queued"],
          ["session|s1", "third", "queued"],
          ["session|s1", "fourth", "queued"],
        ],
      );
      assert.deepStrictEqual(t.read("s1.server"), { waiting: 4 });
    }).pipe(Effect.provide(t.layer));
  }),
);

it.effect(
  "types oldest first per session, nothing while a question is up, finds a renumbered pane, and never retypes an unsure one",
  () =>
    Effect.suspend(() => {
      const t = setup();
      t.inbound(line("a", "s1", "first"));
      t.inbound(line("b", "s1", "second"));
      t.inbound(line("c", "s2", "other"));
      t.inbound(line("d", "s3", "maybe"));
      return Effect.gen(function* () {
        const weave = yield* makeWeave;
        // A question is up in s1: nothing is typed there. s2 is not in a pane yet.
        t.herdr.where.set("s1", { pane: "w1:p1", status: "blocked" });
        assert.strictEqual(yield* weave.deliver, 0);
        assert.deepStrictEqual(t.herdr.asked, []);
        // Herdr says blocked though the list did not: kept, and the second waits behind it.
        t.herdr.where.set("s1", { pane: "w1:p1", status: "idle" });
        t.herdr.answer = () => BLOCKED;
        yield* weave.deliver;
        assert.deepStrictEqual(t.herdr.asked, ["first"]);
        assert.deepStrictEqual(t.herdr.typed, []);
        // Herdr restarted and renumbered the panes: the session is found by its id.
        t.herdr.where.set("s1", { pane: "w2:p7", status: "working" });
        t.herdr.where.set("s2", { pane: "w2:p8", status: "idle" });
        t.herdr.answer = () => ({ delivered: true, detail: "" });
        // s2 was not there before, so it is looked at less often; a minute later it is looked at again.
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(yield* weave.deliver, 3);
        assert.deepStrictEqual(t.herdr.typed, ["w2:p7: first", "w2:p7: second", "w2:p8: other"]);
        assert.match(
          ((t.read("s1.json") as Array<{ text: string }>)[0]?.text ?? "") as string,
          /^Delivered: first/,
        );
        // Herdr did not answer in time: it may be in the pane, so it is dropped and said, never sent again.
        t.herdr.where.set("s3", { pane: "w2:p9", status: "idle" });
        yield* TestClock.adjust("1 minute");
        t.herdr.answer = () => ({ delivered: false, detail: "herdr timed out" });
        yield* weave.deliver;
        yield* weave.deliver;
        assert.deepStrictEqual(
          t.herdr.asked.filter((x) => x === "maybe"),
          ["maybe"],
        );
        assert.match(
          (t.read("s3.json") as Array<{ text: string }>)[0]?.text ?? "",
          /^Maybe delivered/,
        );
        assert.deepStrictEqual(
          (yield* t.rows).map((r) => r.status),
          ["delivered", "delivered", "delivered", "lost"],
        );
        assert.isFalse(NodeFS.existsSync(t.file("s1.server")));
      }).pipe(Effect.provide(t.layer));
    }),
);

it.effect(
  "the bridge's drainer skips a session the server owns, so each message is typed once",
  () =>
    Effect.suspend(() => {
      const t = setup();
      // An older bridge left one in the session's file; this bridge then handed one to the server.
      bridge.enqueue(t.dir, "s9", { text: "left behind", shown: "left behind" });
      bridge.queueForServer(t.dir, "s9", { text: "handed over" });
      const bridgeTyped: Array<string> = [];
      const deps = {
        findLive: () => ({ pane: "w1:p3", status: "idle" }),
        typeInto: async (_pane: string, text: string) => (bridgeTyped.push(text), null),
        say: () => undefined,
      };
      return Effect.gen(function* () {
        yield* Effect.promise(() => bridge.drainSession(t.dir, "s9", deps));
        assert.deepStrictEqual(bridgeTyped, []);
        // While the bridge holds its drain lock the server leaves the file alone; the inbound line is the server's.
        const release = bridge.takeDrainLock(t.dir);
        const weave = yield* makeWeave;
        assert.deepStrictEqual(
          (yield* t.rows).map((r) => r.text),
          ["handed over"],
        );
        assert.strictEqual(bridge.readQueue(t.dir, "s9")[0]?.text, "left behind");
        release();
        t.herdr.where.set("s9", { pane: "w1:p3", status: "idle" });
        yield* weave.deliver;
        yield* weave.deliver;
        yield* Effect.promise(() => bridge.drainSession(t.dir, "s9", deps));
        assert.deepStrictEqual(bridgeTyped, []);
        assert.sameMembers(t.herdr.typed, ["w1:p3: left behind", "w1:p3: handed over"]);
        assert.strictEqual(t.herdr.typed.length, 2);
      }).pipe(Effect.provide(t.layer));
    }),
);

it.effect("the sessions list's kept messages live in the table, and only the list sends them", () =>
  Effect.suspend(() => {
    const t = setup();
    return Effect.gen(function* () {
      const weave = yield* makeWeave;
      yield* weave.setCatalogKept({ s5: ["x", "y"] });
      assert.deepStrictEqual(yield* weave.catalogKept, { s5: ["x", "y"] });
      // "x" was sent from the front and "z" joined the end.
      yield* weave.setCatalogKept({ s5: ["y", "z"] });
      assert.deepStrictEqual(yield* weave.catalogKept, { s5: ["y", "z"] });
      t.herdr.where.set("s5", { pane: "w1:p5", status: "idle" });
      yield* weave.deliver;
      assert.deepStrictEqual(t.herdr.asked, []);
      assert.isFalse(NodeFS.existsSync(t.file("s5.server")));
      yield* weave.setCatalogKept({});
      assert.deepStrictEqual(yield* weave.catalogKept, {});
    }).pipe(Effect.provide(t.layer));
  }),
);

it("finds a session's pane and state in `herdr agent list` by its id", () => {
  const listed = JSON.stringify({
    id: "cli:agent:list",
    result: {
      type: "agent_list",
      agents: [
        { agent_session: { value: "other" }, agent_status: "idle", pane_id: "w1:p1" },
        { agent_session: { value: "sid-1" }, agent_status: "blocked", pane_id: "w2:p4" },
      ],
    },
  });
  assert.deepStrictEqual(
    [...agentsOf(listed)],
    [
      ["other", { pane: "w1:p1", status: "idle" }],
      ["sid-1", { pane: "w2:p4", status: "blocked" }],
    ],
  );
  assert.strictEqual(agentsOf("not json").size, 0);
  // A dialog Herdr does not know (a held cross-session message) still holds typing when Claude Code says it waits.
  assert.deepStrictEqual(
    [
      ...withClaudeWaiting(agentsOf(listed), [
        { sessionId: "other", status: "waiting" },
        { sessionId: "sid-1", status: "idle" },
      ]),
    ],
    [
      ["other", { pane: "w1:p1", status: "blocked" }],
      ["sid-1", { pane: "w2:p4", status: "blocked" }],
    ],
  );
});

it.effect("two servers on one folder: only the one holding it imports and types", () =>
  Effect.suspend(() => {
    const t = setup();
    t.inbound(line("a", "s1", "only once"));
    t.herdr.where.set("s1", { pane: "w1:p1", status: "idle" });
    // The second server has its own database, as a desktop server and a second install would.
    const second = Effect.flatMap(makeWeave, (w) => w.deliver).pipe(
      Effect.scoped,
      Effect.provide(layerMemory),
    );
    return Effect.gen(function* () {
      const first = yield* makeWeave;
      assert.strictEqual(yield* second, 0);
      assert.strictEqual(yield* first.deliver, 1);
      assert.strictEqual(yield* second, 0);
      assert.deepStrictEqual(t.herdr.typed, ["w1:p1: only once"]);
    }).pipe(Effect.provide(t.layer));
  }),
);

it("a server on another base dir keeps its own folder; the real install uses the usual one", () => {
  assert.strictEqual(queueDirFor("/home/me/.t3", "/home/me"), null);
  assert.strictEqual(
    queueDirFor("/w/tree/.t3", "/home/me"),
    NodePath.join("/w/tree/.t3", "tessaya", "live-queue"),
  );
});

it.effect(
  "one Herdr listing serves every target, and a target not there is looked at less often",
  () =>
    Effect.suspend(() => {
      const t = setup();
      t.inbound(line("a", "gone-1", "one"));
      t.inbound(line("b", "gone-2", "two"));
      return Effect.gen(function* () {
        const weave = yield* makeWeave;
        yield* weave.deliver;
        assert.strictEqual(t.herdr.listings, 1);
        yield* weave.deliver;
        assert.strictEqual(t.herdr.listings, 1);
        yield* TestClock.adjust("3 seconds");
        yield* weave.deliver;
        assert.strictEqual(t.herdr.listings, 2);
        // Twice as long now.
        yield* TestClock.adjust("3 seconds");
        yield* weave.deliver;
        assert.strictEqual(t.herdr.listings, 2);
      }).pipe(Effect.provide(t.layer));
    }),
);

it.effect("taken-in rows keep the time they were first queued", () =>
  Effect.suspend(() => {
    const t = setup();
    t.write("sid-b.json", [{ tries: 0, at: "2026-11-07T09:00:00.000Z", text: "from before" }]);
    return Effect.gen(function* () {
      yield* makeWeave;
      const [row] = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ created_at: number }>`SELECT created_at FROM fabric_weaves`,
      ).pipe(Effect.orDie);
      assert.strictEqual(row?.created_at, Date.parse("2026-11-07T09:00:00.000Z"));
    }).pipe(Effect.provide(t.layer));
  }),
);

it.effect("a weave Herdr may have typed is reported lost and never typed again", () =>
  Effect.suspend(() => {
    const t = setup();
    const typed: Array<string> = [];
    const pane = {
      name: "here",
      adapter: {
        discover: Effect.succeed({
          available: true,
          reason: "",
          candidates: [
            {
              runtime: "herdr",
              label: "build",
              location: { workspace: "w", pane: "p1", host: null },
              agentKind: "claude",
              runtimeState: "idle",
            },
          ],
        }),
        readOutput: () => Effect.succeed({ available: true, detail: "", output: "│ > │" }),
        sendInput: (input: { text: string }) =>
          Effect.sync(() => {
            typed.push(input.text);
            return { delivered: false, detail: "the text reached build, but return did not" };
          }),
      },
    };
    return Effect.gen(function* () {
      const weave = yield* makeWeave;
      const sent = yield* weave.send({ to: "build", text: "run the tests please" });
      assert.strictEqual(sent.status, "lost");
      assert.match(sent.reason ?? "", /may already be in the pane/);
      yield* weave.deliver;
      yield* weave.tick;
      assert.deepStrictEqual(typed, ["run the tests please"]);
    }).pipe(
      Effect.provide(Layer.mergeAll(layerMemory, Layer.succeed(BatonWeaveBoxes, [pane] as never))),
      Effect.provideService(WeaveStores, {
        liveQueueDir: () => t.dir,
        catalogFile: t.file("none.json"),
      }),
    );
  }),
);

it("the folder lock: kept by its heartbeat, taken when stale or its process is gone, held only with its token", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "weave-lock-"));
  const lock = NodePath.join(dir, ".server.lock");
  const at = Date.parse("2026-11-07T08:00:00.000Z");
  assert.deepStrictEqual(holdServerLock(dir, "a", at), { owned: true, holder: process.pid });
  // A live owner that keeps touching the lock keeps it.
  assert.deepStrictEqual(holdServerLock(dir, "b", at + 1_000), {
    owned: false,
    holder: process.pid,
  });
  assert.isTrue(holdServerLock(dir, "a", at + 20_000).owned);
  assert.isFalse(holdServerLock(dir, "b", at + 20_000 + SERVER_LOCK_STALE_MS).owned);
  // Untouched for over 30 s: stale even though its pid (a reused one, say) is alive.
  NodeFS.utimesSync(lock, at / 1000, at / 1000);
  assert.isTrue(holdServerLock(dir, "b", at + SERVER_LOCK_STALE_MS + 1).owned);
  assert.isFalse(holdServerLock(dir, "a", at + SERVER_LOCK_STALE_MS + 2).owned);
  // Fresh, but its process is gone.
  const later = at + 2 * SERVER_LOCK_STALE_MS;
  NodeFS.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 1, token: "dead" }));
  NodeFS.utimesSync(lock, later / 1000, later / 1000);
  assert.isTrue(holdServerLock(dir, "c", later + 1_000).owned);
  assert.deepStrictEqual(
    NodeFS.readdirSync(dir).filter((n) => n.startsWith(".server.lock")),
    [".server.lock"],
  );
});

it.effect("a server that does not own the folder types nothing, not even its own send", () =>
  Effect.suspend(() => {
    const t = setup();
    const typed: Array<string> = [];
    const pane = {
      name: "here",
      adapter: {
        discover: Effect.succeed({
          available: true,
          reason: "",
          candidates: [
            {
              runtime: "herdr",
              label: "build",
              location: { workspace: "w", pane: "p1", host: null },
              agentKind: "claude",
              runtimeState: "idle",
            },
          ],
        }),
        readOutput: () => Effect.succeed({ available: true, detail: "", output: "│ > │" }),
        sendInput: (input: { text: string }) =>
          Effect.sync(() => (typed.push(input.text), { delivered: true, detail: "" })),
      },
    };
    const other = Effect.flatMap(makeWeave, (w) =>
      w.send({ to: "build", text: "hold on please" }),
    ).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layerMemory, Layer.succeed(BatonWeaveBoxes, [pane] as never))),
      Effect.provideService(WeaveStores, {
        liveQueueDir: () => t.dir,
        catalogFile: t.file("none.json"),
      }),
    );
    return Effect.gen(function* () {
      yield* makeWeave;
      const sent = yield* other;
      assert.strictEqual(sent.status, "queued");
      assert.deepStrictEqual(typed, []);
    }).pipe(Effect.provide(t.layer));
  }),
);

it.effect(
  "an unbound file an older bridge writes again is taken in, without taking anything twice",
  () =>
    Effect.suspend(() => {
      const t = setup();
      const kept = (id: string, text: string) =>
        `${JSON.stringify({ id, at: "2026-11-07T08:00:00.000Z", text, threadId: "baton-live4:x" })}\n`;
      t.write("unbound-messages.ndjson", kept("u1", "first"));
      return Effect.gen(function* () {
        const weave = yield* makeWeave;
        t.write("unbound-messages.ndjson", kept("u1", "first") + kept("u2", "second"));
        yield* weave.deliver;
        assert.deepStrictEqual(
          (yield* weave.unbound).map((r) => r.text),
          ["first", "second"],
        );
      }).pipe(Effect.provide(t.layer));
    }),
);

it.effect(
  "a session waiting on a resume is looked at at least every 10 s, and at once when a new message comes",
  () =>
    Effect.suspend(() => {
      const t = setup();
      t.inbound(line("a", "s7", "carry on"));
      return Effect.gen(function* () {
        const weave = yield* makeWeave;
        // 3 s, 6 s, then 10 s rather than 12 s.
        for (const step of ["0 seconds", "3 seconds", "6 seconds"] as const) {
          yield* TestClock.adjust(step);
          yield* weave.deliver;
        }
        assert.strictEqual(t.herdr.listings, 3);
        yield* TestClock.adjust("10 seconds");
        yield* weave.deliver;
        assert.strictEqual(t.herdr.listings, 4);
        // A new message for it: looked at in this pass, not after the wait.
        t.inbound(line("b", "s7", "and this"));
        t.herdr.where.set("s7", { pane: "w1:p2", status: "idle" });
        assert.strictEqual(yield* weave.deliver, 2);
        assert.deepStrictEqual(t.herdr.typed, ["w1:p2: carry on", "w1:p2: and this"]);
      }).pipe(Effect.provide(t.layer));
    }),
);
