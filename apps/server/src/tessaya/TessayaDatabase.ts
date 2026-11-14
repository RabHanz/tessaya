/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Baton's own database: `userdata/baton.sqlite`, beside upstream's `statev2.sqlite`.
 *
 * Upstream owns its file, its migration table and its number space; Baton owns this one (the
 * port plan's "Data" section). Baton's repositories are built against this client only, so
 * upstream's `SqlClient` never sees a Baton table and Baton never patches upstream's Sqlite layer.
 *
 * First boot of the ported build seeds it from the pre-v2 `state.sqlite`, which still holds
 * Baton's seven `fabric_*` tables (D71 kept the names): the legacy file is opened read-only,
 * copied with `VACUUM INTO`, and everything that is not Baton's is dropped from the copy. The
 * legacy file is never written, so rolling back to a pre-v2 build keeps working.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { BATON_MIGRATIONS_TABLE, runTessayaMigrations } from "../persistence/TessayaMigrations.ts";

export const BATON_DB_FILE = "baton.sqlite";
export const LEGACY_STATE_FILE = "state.sqlite";

export interface SeedReport {
  readonly seeded: boolean;
  readonly reason: string;
  readonly rows: Readonly<Record<string, number>>;
}

const isTessayaTable = (name: string): boolean => name.startsWith("fabric_");

/**
 * Seed `tessayaPath` from Baton's tables in `legacyPath`. Synchronous and dependency-free so it is
 * rehearsed on copies of real userdata with the same code the server runs. Does nothing when the
 * Baton file exists or the legacy file has no Baton migrations.
 */
export function seedTessayaDatabase(tessayaPath: string, legacyPath: string): SeedReport {
  if (NodeFS.existsSync(tessayaPath)) return { seeded: false, reason: "exists", rows: {} };
  if (!NodeFS.existsSync(legacyPath)) return { seeded: false, reason: "no legacy file", rows: {} };

  const legacy = new NodeSqlite.DatabaseSync(legacyPath, { readOnly: true });
  try {
    const hasMigrations = legacy
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(BATON_MIGRATIONS_TABLE);
    if (hasMigrations === undefined) {
      return { seeded: false, reason: "legacy file has no Tessaya tables", rows: {} };
    }
    const expected: Record<string, number> = {};
    for (const { name } of legacy
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all() as Array<{ name: string }>) {
      if (!isTessayaTable(name)) continue;
      expected[name] = (
        legacy.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }
      ).n;
    }
    // Write to a temporary name and rename, so a crash mid-seed never leaves a half file that
    // the next boot would take for a seeded one.
    const partial = `${tessayaPath}.seeding`;
    NodeFS.rmSync(partial, { force: true });
    legacy.prepare("VACUUM INTO ?").run(partial);
    legacy.close();

    const copy = new NodeSqlite.DatabaseSync(partial);
    try {
      copy.exec("PRAGMA foreign_keys = OFF");
      const foreign = copy
        .prepare(
          "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view', 'trigger')",
        )
        .all() as Array<{ type: string; name: string }>;
      for (const { type, name } of foreign) {
        if (type === "table" && isTessayaTable(name)) continue;
        if (type !== "table" && name.startsWith("fabric_")) continue;
        copy.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`);
      }
      const rows: Record<string, number> = {};
      for (const [name, count] of Object.entries(expected)) {
        rows[name] = (copy.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
        if (rows[name] !== count) {
          throw new Error(`Tessaya seed: ${name} has ${rows[name]} rows, expected ${count}`);
        }
      }
      copy.exec("VACUUM");
      copy.close();
      NodeFS.renameSync(partial, tessayaPath);
      return { seeded: true, reason: "copied from the pre-v2 state.sqlite", rows };
    } catch (error) {
      copy.close();
      NodeFS.rmSync(partial, { force: true });
      throw error;
    }
  } finally {
    if (legacy.isOpen) legacy.close();
  }
}

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA synchronous = NORMAL;`;
    yield* runTessayaMigrations();
  }),
);

export class TessayaDatabaseSeedError extends Schema.TaggedError<TessayaDatabaseSeedError>()(
  "BatonDatabaseSeedError",
  { cause: Schema.Defect() },
) {}

/** The SqlClient Baton's repositories are built with. Never provided to upstream's layers. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const dir = NodePath.dirname(dbPath);
    const tessayaPath = NodePath.join(dir, BATON_DB_FILE);
    const report = yield* Effect.try({
      try: () => seedTessayaDatabase(tessayaPath, NodePath.join(dir, LEGACY_STATE_FILE)),
      catch: (cause) => new TessayaDatabaseSeedError({ cause }),
    });
    if (report.seeded) {
      yield* Effect.log("Tessaya database seeded").pipe(Effect.annotateLogs({ rows: report.rows }));
    }
    return Layer.provideMerge(setup, NodeSqliteClient.layer({ filename: tessayaPath }));
  }),
);

export const layerMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);
