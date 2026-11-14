// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ClaudeLiveSession } from "@t3tools/tessaya-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonWeaveBoxes, makeLiveBox } from "./BatonWeaveBoxes.ts";
import { BatonWeaveService, layer as weaveLayer } from "./BatonWeaveService.ts";

const session = (sessionId: string, name: string, herdrPane: string | null) =>
  ({
    pid: 1,
    sessionId,
    cwd: "/w/x",
    name,
    status: "idle",
    herdrPane,
  }) as unknown as ClaudeLiveSession;

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "weave-live-"));
const live = makeLiveBox(
  Effect.succeed([
    session("sid-1", "plain", null),
    session("sid-2", "paned", "p1"),
    session("sid-3", "sender", null),
  ]),
  () => dir,
);

/** This machine's Herdr: no panes to discover, and the session's pane once it is moved into Herdr. */
const herdr = { pane: null as string | null, typed: [] as string[] };
const here = {
  name: "here",
  adapter: {
    discover: Effect.succeed({ available: true, reason: "", candidates: [] }),
    sendInput: (input: { text: string; session: { location: { pane: string } } }) =>
      Effect.sync(() => {
        herdr.typed.push(`${input.session.location.pane}: ${input.text}`);
        return { delivered: true, detail: "" };
      }),
  },
  agents: Effect.sync(
    () => new Map(herdr.pane === null ? [] : [["sid-1", { pane: herdr.pane, status: "idle" }]]),
  ),
};

const layer = it.layer(
  weaveLayer.pipe(
    Layer.provideMerge(Layer.succeed(BatonWeaveBoxes, [here, live] as never)),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const queued = (id: string): Array<{ text: string; kind?: string }> =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(dir, `${id}.json`), "utf8"));

layer("weaving to live threads outside Herdr", (it) => {
  it.effect(
    "waits for the session, notes the sender's thread, and is typed once it has a pane",
    () =>
      Effect.gen(function* () {
        const weave = yield* BatonWeaveService;
        const sent = yield* weave.send({
          to: "plain",
          text: "please look at the build",
          from: "sender",
        });
        assert.strictEqual(sent.status, "queued");
        assert.strictEqual(sent.toPane, "session|sid-1");
        const [note] = queued("sid-3");
        assert.strictEqual(note?.kind, "note");
        assert.match(note?.text ?? "", /^Queued for live:plain/);
        assert.strictEqual(yield* weave.deliver, 0);
        herdr.pane = "w1:p4";
        // It was not there, so it is looked at again after a while.
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(yield* weave.deliver, 1);
        assert.strictEqual(yield* weave.deliver, 0);
        assert.deepStrictEqual(herdr.typed, ["w1:p4: please look at the build"]);
      }),
  );

  it.effect("a session already in a pane is not offered here", () =>
    Effect.gen(function* () {
      const weave = yield* BatonWeaveService;
      const result = yield* weave.send({ to: "paned", text: "hello there" }).pipe(Effect.flip);
      assert.match(result.reason, /no session is called/);
    }),
  );
});
