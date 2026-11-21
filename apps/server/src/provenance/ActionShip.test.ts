import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as TessayaDatabaseMemory } from "../tessaya/TessayaDatabase.ts";
import { receiveAtBrain } from "../tessaya/BrainReceive.ts";
import { ActionLog, emitAction, layer as actionLogLayer } from "./ActionLog.ts";
import { shipsToBrain } from "./ActionShip.ts";

it("sends a worker's own events, not a Tessel's (the brain hears those itself) nor his private pointers", () => {
  assert.deepStrictEqual(
    ["tool.call", "rpc.call", "settings.changed", "room.wake.kws", "device.online", "private"].filter(
      shipsToBrain,
    ),
    ["tool.call", "rpc.call", "settings.changed"],
  );
});

it.layer(Layer.provideMerge(actionLogLayer, TessayaDatabaseMemory))("a worker's Record on the brain", (it) => {
  it.effect("keeps each event once, under its own id and origin, however often it is sent", () =>
    Effect.gen(function* () {
      const log = yield* ActionLog;
      yield* emitAction({
        kind: "settings.changed",
        actor: { kind: "owner", id: "settings", certainty: 1 },
        subject: "voice",
        outcome: "done",
      });
      const rows = yield* log.rowsAfter(0, "", 10);
      const fromLaptop = rows.map((r) => ({ ...r, id: `laptop-${r.id}`, origin: "env-laptop" }));
      assert.isTrue((yield* receiveAtBrain("actions", { rows: fromLaptop })).ok);
      assert.isTrue((yield* receiveAtBrain("actions", { rows: fromLaptop })).ok);
      const kept = yield* log.rowsAfter(0, "", 10);
      assert.deepStrictEqual(
        kept.filter((r) => r.origin === "env-laptop").map((r) => r.kind),
        ["settings.changed"],
      );
      // the cursor moves past what it has
      assert.deepStrictEqual(yield* log.rowsAfter(kept.at(-1)!.at, kept.at(-1)!.id, 10), []);
    }),
  );
});
