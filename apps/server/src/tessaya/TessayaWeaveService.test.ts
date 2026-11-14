import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaWeaveBoxes } from "./TessayaWeaveBoxes.ts";
import { TessayaWeaveService, layer as weaveLayer } from "./TessayaWeaveService.ts";

/** One pane, whose screen and state the test sets, and a record of what was typed. */
const pane = { state: "idle", screen: "work\n│ > │", typed: [] as string[] };

const fakeBox = (name: string, label: string, paneId: string) => ({
  name,
  adapter: {
    discover: Effect.sync(() => ({
      available: true,
      reason: "",
      candidates: [
        {
          runtime: "herdr",
          label,
          location: { workspace: "w", pane: paneId, host: null },
          agentKind: "claude",
          runtimeState: pane.state,
        },
      ],
    })),
    readOutput: () => Effect.sync(() => ({ available: true, detail: "", output: pane.screen })),
    sendInput: (input: { text: string; session: { location: { pane: string } } }) =>
      Effect.sync(() => {
        pane.typed.push(`${name}/${input.session.location.pane}: ${input.text}`);
        return { delivered: true, detail: "" };
      }),
  },
});
const fakeBoxes = Layer.succeed(TessayaWeaveBoxes, [
  fakeBox("here", "build", "p1"),
  fakeBox("orbit", "research", "p9"),
] as never);

const layer = it.layer(
  weaveLayer.pipe(Layer.provideMerge(fakeBoxes), Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("BatonWeaveService", (it) => {
  it.effect("delivers into an empty input, then reads the reply once it is idle", () =>
    Effect.gen(function* () {
      const weave = yield* TessayaWeaveService;
      pane.typed.length = 0;
      pane.state = "idle";
      pane.screen = "work\n│ > │";
      const sent = yield* weave.send({ to: "build", text: "please rerun the tests", job: "j1" });
      assert.strictEqual(sent.status, "delivered");
      assert.deepStrictEqual(pane.typed, ["here/p1: please rerun the tests"]);
      pane.screen = "│ > please rerun the tests │\n● All 40 pass.\n│ > │";
      const ticked = yield* weave.tick;
      assert.strictEqual(ticked.replied, 1);
      const [row] = yield* weave.list();
      assert.strictEqual(row?.status, "replied");
      assert.strictEqual(row?.reply, "● All 40 pass.");
    }),
  );

  it.effect("keeps a message queued while a draft is in the box, and never types over it", () =>
    Effect.gen(function* () {
      const weave = yield* TessayaWeaveService;
      pane.typed.length = 0;
      pane.screen = "│ > half a sentence │";
      const sent = yield* weave.send({ to: "build", text: "second message here" });
      assert.strictEqual(sent.status, "queued");
      assert.include(sent.reason ?? "", "draft");
      assert.deepStrictEqual(pane.typed, []);
      pane.screen = "│ > │";
      assert.strictEqual((yield* weave.tick).delivered, 1);
      assert.deepStrictEqual(pane.typed, ["here/p1: second message here"]);
    }),
  );

  it.effect("reaches a session on another box by its box name, and reads its reply there", () =>
    Effect.gen(function* () {
      const weave = yield* TessayaWeaveService;
      pane.typed.length = 0;
      pane.screen = "│ > │";
      const sent = yield* weave.send({ to: "orbit:research", text: "what did you find" });
      assert.strictEqual(sent.status, "delivered");
      assert.strictEqual(sent.toLabel, "orbit:research");
      assert.deepStrictEqual(pane.typed, ["orbit/p9: what did you find"]);
      const bare = yield* weave.send({ to: "research", text: "and the second part" });
      assert.strictEqual(bare.toLabel, "orbit:research");
    }),
  );

  it.effect("refuses a secret and an unknown session in plain words", () =>
    Effect.gen(function* () {
      const weave = yield* TessayaWeaveService;
      const secret = yield* Effect.flip(
        weave.send({ to: "build", text: "my password is hunter22x" }),
      );
      assert.include(secret.reason, "password");
      const none = yield* Effect.flip(weave.send({ to: "ghost", text: "hello there friend" }));
      assert.include(none.reason, "no session");
    }),
  );
});
