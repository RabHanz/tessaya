import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

const sealed = (text: string) => Buffer.from(text).toString("base64");

it.layer(SqlitePersistenceMemory)("the private tier on the brain", (it) => {
  it.effect("keeps only newer ciphertext, and only the brain keeps it", () =>
    Effect.gen(function* () {
      const put = (rev: number, blob: string) =>
        receiveAtBrain("privateTier", { put: { name: "companion.store", rev, blob } });
      assert.deepStrictEqual(yield* put(2, sealed("v2")), {
        ok: true,
        value: { kept: true, rev: 2 },
      });
      // A vessel with a stale copy never overwrites a newer one.
      assert.deepStrictEqual(yield* put(1, sealed("v1")), {
        ok: true,
        value: { kept: false, rev: 2 },
      });
      assert.deepStrictEqual(yield* receiveAtBrain("privateTier", { get: "companion.store" }), {
        ok: true,
        value: { rev: 2, blob: sealed("v2") },
      });
      // Only sealed bytes, under a plain file name.
      assert.isFalse((yield* put(3, "not base64 {")).ok);
      assert.isFalse(
        (yield* receiveAtBrain("privateTier", { put: { name: "../x", rev: 3, blob: "" } })).ok,
      );
      // A worker is never her brain: it refuses, and keeps nothing.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'home-box')`;
      assert.isFalse((yield* receiveAtBrain("privateTier", { get: "companion.store" })).ok);
      yield* sql`DELETE FROM fabric_settings WHERE key = ${HOME_KEY}`;
    }),
  );
});
