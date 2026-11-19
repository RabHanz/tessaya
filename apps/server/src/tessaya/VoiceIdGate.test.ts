import { assert, it } from "@effect/vitest";
import { VOICE_ID_GATE_DEFAULTS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { onAction } from "../provenance/ActionLog.ts";
import type { ActionEnvelope } from "@t3tools/tessaya-shared/provenance";
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

it.layer(Layer.mergeAll(SqlitePersistenceMemory, ServerSettingsService.layerTest()))(
  "room-loop claims on the brain",
  (it) => {
    it.effect(
      "a worker's takeover is recorded once, under its id, naming the worker; a worker records none",
      () =>
        Effect.gen(function* () {
          const seen: Array<ActionEnvelope> = [];
          const stop = onAction((e) => seen.push(e));
          const act = {
            id: "01M7S5PFZT37HFQF8W42C34567",
            at: 1_795_067_428_858,
            kind: "room.loop.takeover",
            from: "env-home",
            outcome: "answering here",
            data: { devices: ["r1-a"], loop: "tessaya-room-9" },
          };
          assert.isTrue((yield* receiveAtBrain("roomLoop", act)).ok);
          assert.isFalse((yield* receiveAtBrain("roomLoop", { ...act, kind: "tool.call" })).ok);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'home-box')`;
          assert.isFalse((yield* receiveAtBrain("roomLoop", act)).ok);
          yield* sql`DELETE FROM fabric_settings WHERE key = ${HOME_KEY}`;
          stop();
          assert.deepStrictEqual(
            seen.map((e) => [e.id, e.kind, e.evidence[0]?.ref]),
            [["01M7S5PFZT37HFQF8W42C34567", "room.loop.takeover", "env-home"]],
          );
        }),
    );
  },
);
