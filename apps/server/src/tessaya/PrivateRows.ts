// @effect-diagnostics globalJsonInEffect:off
/**
 * His PIN-protected private store, kept once on her brain (one-self move 4). Only its rows move: ciphertext items,
 * wrapped keys, the audit and the sealed private events. His PIN, the unlock and every encrypt and decrypt stay on the
 * server where he entered the PIN, so nothing but ciphertext ever leaves the brain or reaches it. This is a SQL client
 * for TessayaPrivateMemoryService that runs each of its statements on the brain; on the brain it is the local one.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import { makeBrainLink } from "./BrainHost.ts";

const PRIVATE_TABLE = /^tessaya_private_(stores|items|audit|events)$/;

/**
 * Whether a statement is one of the private store's own (one statement, only its four tables), and whether it reads or
 * writes. The brain runs nothing else a worker sends it.
 */
export const privateStatement = (sql: string): "read" | "write" | null => {
  if (sql.includes(";")) return null;
  const tables = [
    ...sql.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi),
  ].map((m) => m[1]!);
  if (tables.length === 0 || !tables.every((t) => PRIVATE_TABLE.test(t))) return null;
  if (/^\s*SELECT\b/i.test(sql)) return "read";
  return /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) ? "write" : null;
};

const away = (operation: string) =>
  new SqlError({
    reason: new ConnectionError({
      cause: new Error("her brain can't be reached"),
      message: "His private store lives on her brain, which can't be reached just now.",
      operation,
    }),
  });

/** The brain's side: one of the private store's statements, as a worker sent it. */
export const privateRowsAtBrain = Effect.fn("PrivateRows.atBrain")(function* (ask: {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly values: boolean;
}) {
  if (privateStatement(ask.sql) === null) return null;
  const store = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(store)) return null;
  const run = store.value.unsafe(ask.sql, ask.params);
  return ask.values ? yield* run.values : yield* run;
});

/**
 * The private store's SQL client: on her brain, the local database; anywhere else, each statement runs on the brain.
 * A read with the brain away fails (the store is there); a write waits in the outbox and lands once she's back.
 */
export const privateRowsClient = Effect.gen(function* () {
  const local = yield* SqlClient.SqlClient;
  const brain = yield* makeBrainLink;
  const run = Effect.fn("PrivateRows.run")(function* (
    sql: string,
    params: ReadonlyArray<unknown>,
    values: boolean,
  ) {
    if (yield* brain.isBrain) {
      const here = local.unsafe(sql, params);
      return (values ? yield* here.values : yield* here) as unknown as ReadonlyArray<never>;
    }
    const kind = privateStatement(sql);
    if (kind === null) return yield* away("execute");
    const ask = { sql, params, values };
    const answer =
      kind === "read"
        ? yield* brain.send("privateRows", ask)
        : yield* brain.sendOrQueue("privateRows", ask);
    if (Option.isNone(answer)) {
      if (kind === "read") return yield* away("execute");
      return [] as ReadonlyArray<never>;
    }
    return (Array.isArray(answer.value) ? answer.value : []) as unknown as ReadonlyArray<never>;
  });
  const connection: Connection = {
    execute: (sql, params, transformRows) =>
      Effect.map(run(sql, params, false), (rows) => (transformRows ? transformRows(rows) : rows)),
    executeRaw: (sql, params) => run(sql, params, false),
    executeValues: (sql, params) => run(sql, params, true),
    executeValuesUnprepared: (sql, params) => run(sql, params, true),
    executeUnprepared: (sql, params, transformRows) =>
      Effect.map(run(sql, params, false), (rows) => (transformRows ? transformRows(rows) : rows)),
    executeStream: () => Stream.die(new Error("the private store does not stream")),
  };
  return yield* SqlClient.make({
    driver: "tessaya-brain",
    acquirer: Effect.succeed(connection),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [],
  }).pipe(Effect.provide(Reactivity.layer));
});

const TABLES = [
  "tessaya_private_stores",
  "tessaya_private_items",
  "tessaya_private_audit",
  "tessaya_private_events",
] as const;
const KEY: Readonly<Record<(typeof TABLES)[number], string>> = {
  tessaya_private_stores: "id",
  tessaya_private_items: "id",
  tessaya_private_audit: "rowid",
  tessaya_private_events: "id",
};

/**
 * Once, on a server that isn't her brain: the private rows it held before the brain kept them go up, as ciphertext.
 * A copy of every row is written beside its state first, then a dry-run count; a person whose store the brain already
 * holds under another key is never merged (two stores can't be one without his PIN), so then nothing moves and it says
 * so. Rows go up additively, are read back on the brain, and only then deleted here. Some(report) when it ran.
 */
export const moveUpPrivate = Effect.fn("PrivateRows.moveUp")(function* (keptAt: string | null) {
  const local = yield* SqlClient.SqlClient;
  const brain = yield* makeBrainLink;
  if (yield* brain.isBrain) return Option.none<Record<string, unknown>>();
  const rows: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  for (const t of TABLES)
    rows[t] = yield* local
      .unsafe<Record<string, unknown>>(`SELECT * FROM ${t}`)
      .pipe(Effect.orElseSucceed(() => []));
  const counts = Object.fromEntries(TABLES.map((t) => [t, rows[t]!.length]));
  if (TABLES.every((t) => rows[t]!.length === 0))
    return Option.some<Record<string, unknown>>({ counts, moved: 0 });
  if (keptAt !== null) {
    const NodeFS = yield* Effect.promise(() => import("node:fs"));
    yield* Effect.sync(() => {
      if (!NodeFS.existsSync(keptAt)) NodeFS.writeFileSync(keptAt, `${JSON.stringify(rows)}\n`);
    });
  }
  // two stores for one person can't become one without his PIN: refuse rather than hide either
  const theirs = yield* brain.send("privateRows", {
    sql: "SELECT id, person_id FROM tessaya_private_stores",
    params: [],
    values: false,
  });
  if (Option.isNone(theirs)) return Option.none<Record<string, unknown>>();
  const brainStores = (Array.isArray(theirs.value) ? theirs.value : []) as ReadonlyArray<{
    id: string;
    person_id: string;
  }>;
  const clash = rows["tessaya_private_stores"]!.find((r) =>
    brainStores.some((b) => b.person_id === r["person_id"] && b.id !== r["id"]),
  );
  if (clash !== undefined)
    return Option.some<Record<string, unknown>>({
      counts,
      moved: 0,
      clash: String(clash["person_id"]),
    });
  let moved = 0;
  for (const t of TABLES)
    for (const r of rows[t]!) {
      const cols = Object.keys(r).filter((c) => c !== "rowid");
      const sql = `INSERT OR IGNORE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      if (
        Option.isNone(
          yield* brain.send("privateRows", { sql, params: cols.map((c) => r[c]), values: false }),
        )
      )
        return Option.none<Record<string, unknown>>();
      moved++;
    }
  // read back: every store and item id is there before anything is deleted here
  for (const t of ["tessaya_private_stores", "tessaya_private_items"] as const) {
    const ids = rows[t]!.map((r) => r[KEY[t]]);
    if (ids.length === 0) continue;
    const back = yield* brain.send("privateRows", {
      sql: `SELECT COUNT(*) AS n FROM ${t} WHERE id IN (${ids.map(() => "?").join(", ")})`,
      params: ids,
      values: false,
    });
    const n =
      Option.isSome(back) && Array.isArray(back.value)
        ? Number((back.value[0] as { n?: number })?.n ?? 0)
        : -1;
    if (n !== ids.length)
      return Option.some<Record<string, unknown>>({ counts, moved, verified: false });
  }
  for (const t of TABLES) yield* local.unsafe(`DELETE FROM ${t}`).pipe(Effect.ignore);
  return Option.some<Record<string, unknown>>({ counts, moved, verified: true });
});
