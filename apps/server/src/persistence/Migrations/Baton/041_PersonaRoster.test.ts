// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../../config.ts";
import { runTessayaMigrations } from "../../TessayaMigrations.ts";

/** Who each id was before the 14 Nov roster; null and unknown ids are nobody's face. */
const BEFORE: Record<string, string> = {
  executive: "Tessaya",
  engineering: "Alfred",
  operations: "Freya",
  research: "Sebastian",
};
const nameNow = (id: string | null) =>
  DEFAULT_OS_PACK.personas.find((p) => p.id === id)?.name ?? id;
const OWNERS = [...Object.keys(BEFORE), "legal", null];

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [i, owner] of OWNERS.entries()) {
    yield* sql`
      INSERT INTO fabric_memory_items (id, kind, text, source, confidence, created_at, updated_at, origin, persona, visibility, source_ref)
      VALUES (${`m${i}`}, 'fact', 'x', 'conversation', 1, 'now', 'now', 'stated', ${owner}, ${owner === null ? "household" : "persona"},
        ${owner === null ? null : `conversation:${owner}:3-9`})
    `;
    yield* sql`
      INSERT INTO fabric_job_terms (work_session_id, goal, permissions_json, limits_json, grants_json, created_at, updated_at, persona, part_spec_json)
      VALUES (${`j${i}`}, 'g', '{}', '{}', '[]', 'now', 'now', ${owner}, ${JSON.stringify(owner === null ? {} : { role: owner })})
    `;
    yield* sql`
      INSERT INTO tessaya_member_preferences (member_id, key, value, updated_at)
      VALUES (${`p${i}`}, 'persona', ${owner ?? "none"}, 'now')
    `;
  }
});

const owners = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* sql<{ id: string; persona: string | null; source_ref: string | null }>`
    SELECT id, persona, source_ref FROM fabric_memory_items ORDER BY id`;
  const jobs = yield* sql<{ persona: string | null; role: string | null }>`
    SELECT persona, json_extract(part_spec_json, '$.role') AS role FROM fabric_job_terms ORDER BY work_session_id`;
  const prefs = yield* sql<{ value: string }>`
    SELECT value FROM tessaya_member_preferences ORDER BY member_id`;
  return { memory, jobs, prefs };
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("041_PersonaRoster", (it) => {
  it.effect(
    "moves every persona's records to the same face by name, and no record to another face",
    () =>
      Effect.gen(function* () {
        yield* runTessayaMigrations({ toMigrationInclusive: 40 });
        yield* seed;
        yield* runTessayaMigrations({ toMigrationInclusive: 41 });
        const after = yield* owners;
        for (const [i, owner] of OWNERS.entries()) {
          const face = owner === null ? null : (BEFORE[owner] ?? owner);
          const memory = after.memory[i]!;
          assert.strictEqual(nameNow(memory.persona), face, `memory of ${owner}`);
          assert.strictEqual(
            memory.source_ref,
            owner === null ? null : `conversation:${memory.persona}:3-9`,
          );
          assert.strictEqual(nameNow(after.jobs[i]!.persona), face, `job of ${owner}`);
          assert.strictEqual(nameNow(after.jobs[i]!.role), face, `job part of ${owner}`);
          assert.strictEqual(nameNow(after.prefs[i]!.value), face ?? "none", `preference ${owner}`);
        }
        // Onyx took engineering fresh: nothing from before is his.
        assert.notInclude(
          after.memory.map((m) => m.persona),
          "engineering",
        );
      }),
  );
});

const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-roster-" }).pipe(
  Layer.provide(NodeServices.layer),
);

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), config))(
  "041_PersonaRoster with his own pack",
  (it) => {
    it.effect(
      "leaves his own Alfred on engineering, and takes his nameless edits with the face",
      () =>
        Effect.gen(function* () {
          const roles = NodePath.join(
            NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath),
            "operating-system",
            "roles",
          );
          NodeFS.mkdirSync(roles, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(roles, "engineering.md"),
            "---\nname: Alfred\n---\nMine.",
          );
          NodeFS.writeFileSync(
            NodePath.join(roles, "operations.md"),
            "---\nvoice: anna\n---\nMine.",
          );
          yield* runTessayaMigrations({ toMigrationInclusive: 40 });
          yield* seed;
          yield* runTessayaMigrations({ toMigrationInclusive: 41 });
          const after = yield* owners;
          assert.deepEqual(
            after.jobs.map((j) => j.persona),
            ["executive", "engineering", "companion", "alter-ego", "legal", null],
          );
          assert.deepEqual(NodeFS.readdirSync(roles).toSorted(), [
            "companion.md",
            "engineering.md",
          ]);
        }),
    );
  },
);
