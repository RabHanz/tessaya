import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { R1Hub } from "../home/R1Hub.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

const hub = {
  busLogin: Effect.succeed({ user: "tessaya-bus", key: "hub-key" }),
} as unknown as R1Hub["Service"];

it.layer(SqlitePersistenceMemory)("her hub's bus login at the brain door", (it) => {
  it.effect("goes only to a link with full access, and never through the outbox", () =>
    Effect.gen(function* () {
      const ask = (access?: string) =>
        receiveAtBrain("hubLogin", null, access).pipe(Effect.provideService(R1Hub, hub));
      assert.deepStrictEqual(yield* ask("full-access"), {
        ok: true,
        value: { user: "tessaya-bus", key: "hub-key" },
      });
      for (const access of [undefined, "approval-required", "read-only", "body-only"])
        assert.isFalse((yield* ask(access)).ok);
      const queued = receiveAtBrain(
        "outbox",
        { id: "q1", op: "hubLogin", payload: null },
        "full-access",
      ).pipe(Effect.provideService(R1Hub, hub));
      assert.isFalse((yield* queued).ok);
    }),
  );
});
