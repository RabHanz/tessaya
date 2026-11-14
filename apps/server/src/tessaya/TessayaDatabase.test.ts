// @effect-diagnostics nodeBuiltinImport:off
/**
 * baton.sqlite: Baton's migrations run in their own file and table, and the first boot of the
 * ported build seeds it from a pre-v2 state.sqlite without writing to that file.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, expect } from "vite-plus/test";

import {
  BATON_MIGRATIONS_TABLE,
  tessayaMigrationManifest,
  runTessayaMigrations,
} from "../persistence/TessayaMigrations.ts";
import { seedTessayaDatabase } from "./TessayaDatabase.ts";

const dirs: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-db-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const sha = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

/** A pre-v2 state.sqlite: upstream tables plus Baton's, migrated by the real manifest. */
const legacyStateFile = (dir: string) =>
  Effect.gen(function* () {
    const file = NodePath.join(dir, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO projection_threads VALUES ('t1'), ('t2')`;
      yield* runTessayaMigrations();
      yield* sql`INSERT INTO fabric_work_sessions (id, project_id, title, risk_class, priority, created_at, updated_at) VALUES ('ws-1', 'p1', 'Work', 'low', 'normal', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file })));
    return file;
  });

describe("Tessaya's database", () => {
  it.effect("records Tessaya's migrations in Tessaya's own table", () =>
    Effect.gen(function* () {
      yield* runTessayaMigrations();
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly migration_id: number;
      }>`SELECT migration_id FROM ${sql(BATON_MIGRATIONS_TABLE)} ORDER BY migration_id`;
      assert.deepStrictEqual(
        rows.map((row) => row.migration_id),
        tessayaMigrationManifest.map(([id]) => id),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("seeds from a pre-v2 state.sqlite: Tessaya's tables and rows, nothing else", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const legacy = yield* legacyStateFile(dir);
      const before = sha(legacy);
      const baton = NodePath.join(dir, "baton.sqlite");

      const report = seedTessayaDatabase(baton, legacy);
      expect(report.seeded).toBe(true);
      expect(sha(legacy)).toBe(before);

      const db = new NodeSqlite.DatabaseSync(baton, { readOnly: true });
      const tables = (
        db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      db.close();
      // sqlite_sequence is SQLite's own, made for any AUTOINCREMENT column.
      expect(tables.every((name) => name.startsWith("fabric_") || name.startsWith("sqlite_"))).toBe(
        true,
      );
      expect(tables).toContain(BATON_MIGRATIONS_TABLE);
      expect(tables).not.toContain("projection_threads");
      expect(report.rows[BATON_MIGRATIONS_TABLE]).toBe(tessayaMigrationManifest.length);
      expect(report.rows["fabric_work_sessions"]).toBe(1);
    }),
  );

  it("does nothing when baton.sqlite exists or there is nothing to seed from", () => {
    const dir = tempDir();
    const baton = NodePath.join(dir, "baton.sqlite");
    expect(seedTessayaDatabase(baton, NodePath.join(dir, "state.sqlite")).reason).toBe(
      "no legacy file",
    );
    NodeFS.writeFileSync(baton, "");
    expect(seedTessayaDatabase(baton, NodePath.join(dir, "state.sqlite")).reason).toBe("exists");
  });

  it("does not seed from a state.sqlite that never had Tessaya", () => {
    const dir = tempDir();
    const legacy = NodePath.join(dir, "state.sqlite");
    const db = new NodeSqlite.DatabaseSync(legacy);
    db.exec("CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)");
    db.close();
    const report = seedTessayaDatabase(NodePath.join(dir, "baton.sqlite"), legacy);
    expect(report.seeded).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(dir, "baton.sqlite"))).toBe(false);
  });
});
