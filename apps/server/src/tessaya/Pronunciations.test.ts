import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

it.layer(Layer.mergeAll(SqlitePersistenceMemory, ServerSettingsService.layerTest()))(
  "his pronunciations on the brain",
  (it) => {
    it.effect("a worker's teach and read land in the brain's one list; a worker keeps none", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* receiveAtBrain("pronounce", { word: "Kazi", sayAs: "Kah-zee" }),
          { ok: true, value: { Kazi: "Kah-zee" } },
        );
        assert.deepStrictEqual((yield* (yield* ServerSettingsService).getSettings).voicePronounce, {
          Kazi: "Kah-zee",
        });
        assert.deepStrictEqual(yield* receiveAtBrain("pronounce", {}), {
          ok: true,
          value: { Kazi: "Kah-zee" },
        });
        // A word alone goes back to the voice's own way.
        assert.deepStrictEqual(yield* receiveAtBrain("pronounce", { word: "Kazi" }), {
          ok: true,
          value: {},
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'home-box')`;
        assert.isFalse((yield* receiveAtBrain("pronounce", { word: "Kazi", sayAs: "x" })).ok);
        yield* sql`DELETE FROM fabric_settings WHERE key = ${HOME_KEY}`;
      }),
    );
  },
);
