// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";

import { fold } from "./tessaya-fold-into-brain.ts";

const SCHEMA = `
  CREATE TABLE tessaya_action_events (id TEXT PRIMARY KEY, at INTEGER, kind TEXT, origin TEXT, actor_kind TEXT,
    actor_id TEXT, certainty REAL, cause_json TEXT, evidence_json TEXT, persona TEXT, subject TEXT, outcome TEXT,
    data_json TEXT);
  CREATE TABLE tessaya_brain_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, role TEXT, model TEXT,
    input INTEGER, output INTEGER, feature TEXT, call_key TEXT, event_id TEXT);
  CREATE TABLE fabric_memory_items (id TEXT PRIMARY KEY, kind TEXT, text TEXT, source_ref TEXT, origin TEXT,
    received_at TEXT);
  CREATE TABLE tessaya_affect_state (persona TEXT PRIMARY KEY, state_json TEXT);
  CREATE TABLE fabric_phone_prompts (id TEXT PRIMARY KEY, status TEXT, expires_at INTEGER);
`;
const db = (...rows: ReadonlyArray<string>) => {
  const d = new NodeSqlite.DatabaseSync(":memory:");
  d.exec(SCHEMA);
  for (const r of rows) d.exec(r);
  return d;
};
const event = (id: string, data = "{}") =>
  `INSERT INTO tessaya_action_events VALUES ('${id}', 1, 'k', 'env-onnyx', 'system', 'a', 1, '[]', '[]', NULL, 's', 'o', '${data}')`;

it("folds a peer's state into the brain once, keeping the brain's copy of anything it already holds", () => {
  const peer = db(
    event("e1"),
    event("e2", '{"x":1}'),
    event("e3", '{"y":2}'),
    "INSERT INTO tessaya_brain_usage (at, role, model, input, output, event_id) VALUES (5, 'brain', 'm', 1, 1, 'u1')",
    "INSERT INTO tessaya_brain_usage (at, role, model, input, output, event_id) VALUES (6, 'brain', 'm', 1, 1, 'u2')",
    "INSERT INTO fabric_memory_items VALUES ('m1', 'fact', 'likes tea', 'turn:1', 'env-onnyx', NULL)",
    "INSERT INTO fabric_memory_items VALUES ('m2', 'fact', 'likes rain', 'turn:2', 'env-onnyx', NULL)",
    "INSERT INTO tessaya_affect_state VALUES ('executive', '{\"a\":1}')",
    "INSERT INTO tessaya_affect_state VALUES ('alter-ego', '{\"a\":2}')",
    "INSERT INTO fabric_phone_prompts VALUES ('p-live', 'pending', 100)",
    "INSERT INTO fabric_phone_prompts VALUES ('p-old', 'pending', 1)",
  );
  const brain = db(
    event("e1"),
    // The same event, its data tagged there by an earlier fold: still the same event, the brain's kept.
    event("e2", '{"x":9}'),
    // Another autoincrement id for the same call.
    "INSERT INTO tessaya_brain_usage (id, at, role, model, input, output, event_id) VALUES (40, 5, 'brain', 'm', 1, 1, 'u1')",
    // The same memory under another id.
    "INSERT INTO fabric_memory_items VALUES ('other', 'fact', 'likes tea', 'turn:1', 'env-hetzner', NULL)",
    "INSERT INTO tessaya_affect_state VALUES ('executive', '{\"a\":5}')",
  );
  const dry = fold(peer, brain, { label: "onnyx", apply: false, now: 50 });
  const byTable = Object.fromEntries(dry.tables.map((t) => [t.table, t]));
  assert.deepStrictEqual(
    [byTable["tessaya_action_events"]!.imported, byTable["tessaya_action_events"]!.duplicates],
    [1, 2],
  );
  assert.deepStrictEqual(byTable["tessaya_action_events"]!.conflicts, []);
  assert.strictEqual(byTable["tessaya_brain_usage"]!.imported, 1);
  assert.strictEqual(byTable["fabric_memory_items"]!.imported, 1);
  assert.deepStrictEqual(byTable["tessaya_affect_state"]!.conflicts, ["executive"]);
  assert.strictEqual(byTable["fabric_phone_prompts"]!.imported, 1);
  // A dry run writes nothing.
  assert.strictEqual(
    (brain.prepare("SELECT COUNT(*) AS n FROM tessaya_action_events").get() as { n: number }).n,
    2,
  );

  fold(peer, brain, { label: "onnyx", apply: true, now: 50 });
  const e3 = brain.prepare("SELECT data_json FROM tessaya_action_events WHERE id = 'e3'").get() as {
    data_json: string;
  };
  assert.deepStrictEqual(JSON.parse(e3.data_json), {
    y: 2,
    migrated: { from: "onnyx", at: new Date(50).toISOString() },
  });
  assert.strictEqual(
    (
      brain.prepare("SELECT data_json FROM tessaya_action_events WHERE id = 'e2'").get() as {
        data_json: string;
      }
    ).data_json,
    '{"x":9}',
  );
  assert.strictEqual(
    (
      brain
        .prepare("SELECT state_json FROM tessaya_affect_state WHERE persona = 'executive'")
        .get() as {
        state_json: string;
      }
    ).state_json,
    '{"a":5}',
  );
  assert.ok(brain.prepare("SELECT 1 FROM tessaya_action_events WHERE kind = 'brain.fold'").get());
  // Run again: nothing new arrives.
  const again = fold(peer, brain, { label: "onnyx", apply: false, now: 60 });
  assert.strictEqual(
    again.tables.reduce((n, t) => n + t.imported, 0),
    0,
  );
});
