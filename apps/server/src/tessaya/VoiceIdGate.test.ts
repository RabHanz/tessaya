import { assert, it } from "@effect/vitest";
import { VOICE_ID_GATE_DEFAULTS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

it.layer(Layer.mergeAll(SqlitePersistenceMemory, ServerSettingsService.layerTest()))(
  "Voice ID's switches on the brain",
  (it) => {
    it.effect("a worker's change lands in the brain's one record; a worker keeps none", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* receiveAtBrain("voiceIdGate", {}), {
          ok: true,
          value: VOICE_ID_GATE_DEFAULTS,
        });
        const set = { ...VOICE_ID_GATE_DEFAULTS, respondToOthers: true };
        assert.deepStrictEqual(yield* receiveAtBrain("voiceIdGate", { set }), {
          ok: true,
          value: set,
        });
        assert.deepStrictEqual(
          (yield* (yield* ServerSettingsService).getSettings).voiceIdGate,
          set,
        );
        assert.isFalse((yield* receiveAtBrain("voiceIdGate", { set: { on: true } })).ok);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'home-box')`;
        assert.isFalse((yield* receiveAtBrain("voiceIdGate", {})).ok);
        yield* sql`DELETE FROM fabric_settings WHERE key = ${HOME_KEY}`;
      }),
    );
  },
);
