/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Baton's migrations, in their own number space and their own tracking table.
 *
 * Why this is separate from `Migrations.ts`
 * ----------------------------------------
 * Upstream's manifest is a single ascending list, and the migrator runs exactly
 * the entries whose id is greater than the highest id recorded in the table —
 * anything at or below it is **silently skipped**. Baton's first six
 * migrations were numbered 054–059 inside that list, which put this fork on a
 * collision course with upstream's next migration: the moment upstream adds its
 * own 054, one of two things happens and both are bad. Merged into our
 * manifest, two entries claim the same id and the migrator fails with
 * `Duplicates`. Renumbered around ours, upstream's new migration sits below our
 * highest applied id and never runs at all — the schema silently diverges and
 * the first symptom is a query against a column that was never added.
 *
 * Putting Baton's migrations in a second manifest with `table:
 * "fabric_sql_migrations"` removes the shared number space entirely. Upstream's
 * list stays byte-identical to theirs, so the file most likely to conflict on
 * every sync stops conflicting; Baton numbers from 1 again and can add
 * migrations without caring what upstream did. Nothing in upstream's migrator
 * had to be reshaped — `MigratorOptions.table` is theirs, and it exists for
 * exactly this.
 *
 * See the maintainers' decision log D48.
 */

import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./Migrations/Baton/001_WorkSessions.ts";
import Migration0002 from "./Migrations/Baton/002_WorkSessionSynopsis.ts";
import Migration0003 from "./Migrations/Baton/003_OrchestrationRules.ts";
import Migration0004 from "./Migrations/Baton/004_Intents.ts";
import Migration0005 from "./Migrations/Baton/005_WorkSessionObservedState.ts";
import Migration0006 from "./Migrations/Baton/006_AdoptedSessions.ts";
import Migration0007 from "./Migrations/Baton/007_IntentLearning.ts";
import Migration0008 from "./Migrations/Baton/008_ThreadAccountMoves.ts";
import Migration0009 from "./Migrations/Baton/009_JobTerms.ts";
import Migration0010 from "./Migrations/Baton/010_JobParts.ts";
import Migration0011 from "./Migrations/Baton/011_JobPartSpec.ts";
import Migration0012 from "./Migrations/Baton/012_Memory.ts";
import Migration0013 from "./Migrations/Baton/013_Commitments.ts";
import Migration0014 from "./Migrations/Baton/014_Weaves.ts";
import Migration0015 from "./Migrations/Baton/015_PhoneRelay.ts";
import Migration0016 from "./Migrations/Baton/016_PhonePromptNeeds.ts";
import Migration0017 from "./Migrations/Baton/017_MemoryReceivedAt.ts";
import Migration0018 from "./Migrations/Baton/018_Record.ts";
import Migration0019 from "./Migrations/Baton/019_JobPersona.ts";
import Migration0020 from "./Migrations/Baton/020_MemoryVectors.ts";
import Migration0021 from "./Migrations/Baton/021_MemoryVersions.ts";
import Migration0022 from "./Migrations/Baton/022_Settings.ts";
import Migration0023 from "./Migrations/Baton/023_WeaveQueue.ts";
import Migration0024 from "./Migrations/Baton/024_LiveQueue.ts";

/**
 * Baton's own tracking table. Upstream's `effect_sql_migrations` is left to
 * upstream.
 */
// Legacy name (D71): live databases track Baton's migrations here; never rename it.
export const BATON_MIGRATIONS_TABLE = "fabric_sql_migrations";

const batonMigrationEntries = [
  [1, "WorkSessions", Migration0001],
  [2, "WorkSessionSynopsis", Migration0002],
  [3, "OrchestrationRules", Migration0003],
  [4, "Intents", Migration0004],
  [5, "WorkSessionObservedState", Migration0005],
  [6, "AdoptedSessions", Migration0006],
  [7, "IntentLearning", Migration0007],
  [8, "ThreadAccountMoves", Migration0008],
  [9, "JobTerms", Migration0009],
  [10, "JobParts", Migration0010],
  [11, "JobPartSpec", Migration0011],
  [12, "Memory", Migration0012],
  [13, "Commitments", Migration0013],
  [14, "Weaves", Migration0014],
  [15, "PhoneRelay", Migration0015],
  [16, "PhonePromptNeeds", Migration0016],
  [17, "MemoryReceivedAt", Migration0017],
  [18, "Record", Migration0018],
  [19, "JobPersona", Migration0019],
  [20, "MemoryVectors", Migration0020],
  [21, "MemoryVersions", Migration0021],
  [22, "Settings", Migration0022],
  [23, "WeaveQueue", Migration0023],
  [24, "LiveQueue", Migration0024],
] as const;

export const batonMigrationManifest = batonMigrationEntries.map(
  ([id, name]) => [id, name] as const,
);

const makeBatonMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      batonMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunBatonMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run Baton's pending migrations against `fabric_sql_migrations`.
 *
 * Called from the SQLite persistence layer after upstream's runner, so a boot
 * applies upstream's schema first and Baton's on top of it.
 */
export const runBatonMigrations = Effect.fn("runBatonMigrations")(function* ({
  toMigrationInclusive,
}: RunBatonMigrationsOptions = {}) {
  const executedMigrations = yield* run({
    loader: makeBatonMigrationLoader(toMigrationInclusive),
    table: BATON_MIGRATIONS_TABLE,
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Tessaya schema is current")
    : Effect.log("Tessaya migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
