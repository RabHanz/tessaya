import { assert, describe, it } from "@effect/vitest";
import { PRIVATE_KIND } from "@t3tools/tessaya-shared/provenance";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { layerMemory } from "../tessaya/TessayaDatabase.ts";
import {
  PrivateCaller,
  PrivateKdf,
  TessayaPrivateMemoryService,
  layer as privateLayer,
} from "../tessaya/TessayaPrivateMemoryService.ts";
import { ActionLog, emitAction, layer as actionLogLayer, traced, withCause } from "./ActionLog.ts";

const MARKER = "zebracrossing";
const PIN = "27182818";

const stack = actionLogLayer.pipe(
  Layer.provideMerge(privateLayer),
  Layer.provide(
    Layer.mock(ServerSecretStore)({
      getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes).fill(9)),
    }),
  ),
  Layer.provideMerge(Layer.succeed(PrivateKdf, { N: 2 ** 10, r: 8, p: 1 })),
  Layer.provideMerge(layerMemory),
);
const test = <A, E>(name: string, body: () => Effect.Effect<A, E, Layer.Success<typeof stack>>) =>
  it.effect(name, () => Effect.provide(body(), stack));

const desk = { session: "desk", desktop: true } as const;
const phone = { session: "phone", desktop: false } as const;
const as =
  (who: { readonly session: string; readonly desktop: boolean }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, PrivateCaller, who);

const publicLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return JSON.stringify(yield* sql`SELECT * FROM tessaya_action_events`);
});

describe("the action log", () => {
  test("links what an action caused, and walks the chain back", () =>
    Effect.gen(function* () {
      const log = yield* ActionLog;
      const wake = yield* emitAction({
        kind: "room.wake",
        actor: { kind: "device", id: "tumble", certainty: 1 },
      });
      yield* withCause(wake)(
        traced({ kind: "tool.call", actor: { kind: "agent", certainty: 1 }, subject: "home_do" })(
          emitAction({ kind: "device.cmd", actor: { kind: "persona", id: "Freya", certainty: 1 } }),
        ),
      );
      yield* log.flush;
      const [cmd] = yield* log.list({ since: 0, kindPrefix: "device", limit: 5 });
      const chain = yield* log.trace(cmd!.id);
      assert.deepStrictEqual(
        chain.map((e) => e.kind),
        ["device.cmd", "tool.call", "room.wake"],
      );
      const effects = yield* log.effectsOf(wake);
      assert.deepStrictEqual(
        effects.map((e) => e.kind),
        ["tool.call"],
      );
      // The wrapped action is one row with its outcome, not a start and an end.
      assert.strictEqual(
        (yield* log.list({ since: 0, kindPrefix: "tool", limit: 5 }))[0]?.outcome,
        "ok",
      );
    }));

  test("keeps no private content in the public log; his open store reads it back, locally (Director 18:50)", () =>
    Effect.gen(function* () {
      const log = yield* ActionLog;
      const p = yield* TessayaPrivateMemoryService;
      const offer = yield* as(desk)(p.setup({ name: "Owner", pin: PIN }));
      const store = yield* as(desk)(p.confirmSetup(offer));
      const secret = yield* emitAction({
        kind: "private.recall",
        actor: { kind: "owner", certainty: 0.9 },
        persona: "Freya",
        subject: MARKER,
        data: { words: MARKER },
        private: true,
      });
      // A public action caused by the private one: the chain crosses the boundary.
      const reply = yield* withCause(secret)(
        emitAction({ kind: "device.cmd", actor: { kind: "persona", id: "Freya", certainty: 1 } }),
      );
      yield* log.flush;

      assert.notInclude(yield* publicLog, MARKER);
      const sealed =
        yield* (yield* SqlClient.SqlClient)`SELECT sealed_json FROM tessaya_private_events WHERE id = ${secret}`;
      assert.strictEqual(sealed.length, 1);
      assert.notInclude(JSON.stringify(sealed), MARKER);

      // Anyone tracing sees the link, but only a pointer.
      const chain = yield* log.trace(reply);
      assert.deepStrictEqual(
        chain.map((e) => e.kind),
        ["device.cmd", PRIVATE_KIND],
      );
      assert.notInclude(JSON.stringify(chain), MARKER);

      // Locked, or another session: nothing opens.
      assert.deepStrictEqual(yield* as(phone)(log.privateEvents(0, 10)), []);
      // His own open store: the whole envelope, for the learning loop and his trace, on this server only.
      yield* as(desk)(p.unlock({ storeId: store.id, pin: PIN }));
      assert.deepStrictEqual(yield* as(phone)(log.privateEvents(0, 10)), []);
      const opened = yield* as(desk)(log.privateEvents(0, 10));
      const mine = opened.find((e) => e.id === secret);
      assert.strictEqual(mine?.subject, MARKER);
      assert.strictEqual(mine?.persona, "Freya");
    }));

  test("records each act on a private store as a private action", () =>
    Effect.gen(function* () {
      const log = yield* ActionLog;
      const p = yield* TessayaPrivateMemoryService;
      const offer = yield* as(desk)(p.setup({ name: "Owner", pin: PIN }));
      const store = yield* as(desk)(p.confirmSetup(offer));
      yield* as(desk)(p.unlock({ storeId: store.id, pin: PIN }));
      yield* log.flush;
      const pointers = yield* log.list({ since: 0, kindPrefix: PRIVATE_KIND, limit: 10 });
      assert.isAtLeast(pointers.length, 1);
      const opened = yield* as(desk)(log.privateEvents(0, 10));
      assert.include(
        opened.map((e) => e.kind),
        "private.unlock",
      );
    }));
});
