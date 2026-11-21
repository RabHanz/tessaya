import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import * as MemberPreferences from "./MemberPreferences.ts";
import { layerMemory } from "./TessayaDatabase.ts";

it.layer(Layer.provideMerge(MemberPreferences.layer, layerMemory))(
  "preferences live on her brain",
  (it) => {
    it.effect(
      "a worker's own rows move up once, the newer of each pair stands, and a worker cut off reads none",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const prefs = yield* MemberPreferences.MemberPreferences;
          // The brain's own preference, older than the worker's copy of the same key, and one the worker never had.
          yield* prefs.set("owner", "persona", "alfred");
          yield* sql`UPDATE tessaya_member_preferences SET updated_at = '2026-11-14T00:00:00.000Z'`;
          yield* prefs.set("owner", "voice", "anna");
          const brainRows = yield* sql<
            Record<string, string>
          >`SELECT * FROM tessaya_member_preferences`;
          // Now this database is a worker's that kept its own copy (21 Nov: two of his servers).
          yield* sql`DELETE FROM tessaya_member_preferences`;
          yield* sql`INSERT INTO tessaya_member_preferences (member_id, key, value, updated_at)
          VALUES ('owner', 'persona', 'freya', '2026-11-20T00:00:00.000Z'), ('owner', 'listenWait', '4', '2026-11-19T00:00:00.000Z')`;
          yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'Tessaya')`;
          assert.deepStrictEqual(yield* prefs.of("owner"), {});
          assert.deepStrictEqual(yield* sql`SELECT * FROM tessaya_member_preferences`, []);
          const queued = yield* sql<{ id: string; op: string; payload: string }>`
          SELECT id, op, payload FROM tessaya_brain_outbox`;
          assert.deepStrictEqual(
            queued.map((q) => q.op),
            ["preferences"],
          );
          // Back to the brain's rows, then the worker's queued copy lands there, once.
          yield* sql`DELETE FROM fabric_settings WHERE key = ${HOME_KEY}`;
          for (const r of brainRows)
            yield* sql`INSERT INTO tessaya_member_preferences ${sql.insert(r)}`;
          const box = {
            id: queued[0]!.id,
            op: "preferences",
            payload: JSON.parse(queued[0]!.payload),
          };
          assert.isTrue((yield* receiveAtBrain("outbox", box)).ok);
          assert.isTrue((yield* receiveAtBrain("outbox", box)).ok);
          assert.deepStrictEqual(yield* prefs.of("owner"), {
            persona: "freya",
            voice: "anna",
            listenWait: "4",
          });
        }),
    );
  },
);
