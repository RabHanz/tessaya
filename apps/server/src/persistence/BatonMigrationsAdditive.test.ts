/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off - this test reads the migration files as text, which is the only way to assert what their SQL does.
/**
 * D7, as a test rather than a promise.
 *
 * Baton's rollback story is not a `down` migration — the migrator has none —
 * it is that **every Baton migration is additive**, so a build from before it
 * opens the database, ignores what it does not know, and runs. That has been
 * rehearsed by hand after every phase. This asserts it, so the next migration
 * cannot quietly break it.
 *
 * What "additive" means here, precisely: create tables, create indexes, and add
 * columns to tables Baton itself owns. Never drop, never rename, never alter a
 * column an older build reads.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { batonMigrationManifest } from "./BatonMigrations.ts";
import { migrationManifest } from "./Migrations.ts";

const MIGRATIONS_DIR = NodePath.join(import.meta.dirname, "Migrations", "Baton");

/** The migrations this fork added. Upstream's are upstream's business. */
const BATON_MIGRATIONS = batonMigrationManifest;

const sourceOf = (id: number, name: string): string => {
  const file = `${String(id).padStart(3, "0")}_${name}.ts`;
  return NodeFS.readFileSync(NodePath.join(MIGRATIONS_DIR, file), "utf8");
};

/** Triggers whose body may delete or update: each runs on later writes, never at migration time, and is reviewed. */
const REVIEWED_TRIGGERS = new Set(["fabric_memory_vectors_gone"]);

/** Migrations whose UPDATE only fills a column the same migration added, which an older build never reads. */
const REVIEWED_BACKFILLS = new Set(["31_MemoryPersona"]);

/** Comments out first (a commented-out END must not end a trigger early), then the reviewed triggers' bodies. */
const withoutTriggerBodies = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace(
      /\bCREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\b[\s\S]*?\bEND\b/gi,
      (trigger, name: string) => (REVIEWED_TRIGGERS.has(name) ? "" : trigger),
    );

/** Statements that would make a Baton migration unsafe to roll back past. */
const FORBIDDEN: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\bDROP\s+TABLE\b/i, what: "drops a table" },
  { pattern: /\bDROP\s+COLUMN\b/i, what: "drops a column" },
  { pattern: /\bDROP\s+INDEX\b/i, what: "drops an index" },
  { pattern: /\bRENAME\s+TO\b/i, what: "renames something" },
  { pattern: /\bALTER\s+TABLE\s+\w+\s+RENAME\b/i, what: "renames a column" },
  { pattern: /\bDELETE\s+FROM\b/i, what: "deletes rows" },
  { pattern: /\bUPDATE\s+\w+\s+SET\b/i, what: "rewrites rows" },
];

describe("every Tessaya migration is additive", () => {
  it("has migrations to check", () => {
    // A test that silently checks nothing is worse than no test.
    expect(BATON_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it("reads past a reviewed trigger's body only, and nothing after it", () => {
    const body = "AFTER DELETE ON a BEGIN DELETE FROM b WHERE id = old.id; END; DELETE FROM c";
    expect(
      withoutTriggerBodies(`CREATE TRIGGER IF NOT EXISTS fabric_memory_vectors_gone ${body}`),
    ).toBe("; DELETE FROM c");
    // An unreviewed trigger is checked like any statement.
    expect(withoutTriggerBodies(`CREATE TRIGGER other ${body}`)).toContain("DELETE FROM b");
    // A commented-out END does not end the trigger early.
    expect(
      withoutTriggerBodies(
        "CREATE TRIGGER fabric_memory_vectors_gone AFTER DELETE ON a BEGIN -- END\n DELETE FROM b; END;",
      ),
    ).toBe(";");
  });

  it("never drops, renames or rewrites anything", () => {
    for (const [id, name] of BATON_MIGRATIONS) {
      // A trigger's body runs on later writes, not at migration time, so its DELETE or UPDATE changes nothing here.
      const source = withoutTriggerBodies(sourceOf(id, name));
      for (const rule of FORBIDDEN) {
        if (rule.what === "rewrites rows" && REVIEWED_BACKFILLS.has(`${String(id)}_${name}`)) continue;
        expect(
          rule.pattern.test(source),
          `${String(id)}_${name} ${rule.what}, which an older build cannot survive (D7)`,
        ).toBe(false);
      }
    }
  });

  it("only touches tables Tessaya owns", () => {
    // An `ALTER TABLE` on an upstream table would change a shape a stock T3
    // build reads, which is the one thing D11 and D7 exist to prevent.
    for (const [id, name] of BATON_MIGRATIONS) {
      const source = sourceOf(id, name);
      for (const match of source.matchAll(
        /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE)\s+([a-z_]+)/gi,
      )) {
        const table = match[1] ?? "";
        expect(
          /^(fabric|tessaya)_/.test(table),
          `${String(id)}_${name} touches '${table}', which Tessaya does not own`,
        ).toBe(true);
      }
    }
  });

  it("is registered in order, with no gaps or repeats", () => {
    const ids = BATON_MIGRATIONS.map(([id]) => id);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves upstream's manifest entirely to upstream", () => {
    // The point of D48: `Migrations.ts` is byte-identical to upstream's, so the
    // file they touch on every migration is not a file we touch at all. If a
    // Baton entry ever reappears there, the number spaces have merged again
    // and upstream's next migration is one release away from being skipped.
    expect(migrationManifest.filter(([, name]) => /fabric|baton/.test(name.toLowerCase()))).toEqual(
      [],
    );
  });
});
