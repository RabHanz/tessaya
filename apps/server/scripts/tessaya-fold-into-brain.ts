// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalJsonInEffect:off preferSchemaOverJson:off
/**
 * One brain, slice 3 (one-brain-2026-11-18 §3): folds a former peer's Tessaya state into the brain's `baton.sqlite`.
 * `--from` is always a copy (made read-only off that machine); `--into` is opened read-only unless `--apply`, which first
 * backs it up beside itself. Machine-local tables (its sessions, devices, settings) stay; the private layer never moves.
 * Usage: --from <copy of the peer's baton.sqlite> --into <brain's baton.sqlite> --label onnyx [--report out.json] [--apply]
 */
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

type Row = Record<string, NodeSqlite.SQLOutputValue>;

export interface TableReport {
  readonly table: string;
  readonly inPeer: number;
  readonly inBrain: number;
  /** Rows the fold adds (or added, with `--apply`). */
  readonly imported: number;
  /** Already on the brain, the same. */
  readonly duplicates: number;
  /** Already on the brain by key, but different there: the brain's copy is kept. */
  readonly conflicts: ReadonlyArray<string>;
}

export interface FoldReport {
  readonly label: string;
  readonly applied: boolean;
  readonly at: string;
  readonly tables: ReadonlyArray<TableReport>;
  /** Tables left where they are, and why. */
  readonly kept: Readonly<Record<string, string>>;
}

/** Each machine's own, or the brain's already: never folded. */
const KEPT: Readonly<Record<string, string>> = {
  fabric_settings: "that server's own settings, device keys and pulse state",
  fabric_devices: "device records belong to the hub the device logs in to (the brain's)",
  fabric_device_state: "a cache of the devices that server saw",
  fabric_adopted_sessions:
    "terminal sessions on that machine stay with it (T3: a thread belongs to its environment)",
  fabric_weaves: "messages queued for that machine's own sessions",
  fabric_sql_migrations: "schema bookkeeping",
  fabric_memory_fts: "rebuilt from memory items by the brain",
  fabric_memory_vectors: "rebuilt from memory items by the brain",
  fabric_memory_meta: "that server's memory bookkeeping",
  tessaya_private_stores: "the private layer never leaves its device",
  tessaya_private_items: "the private layer never leaves its device",
  tessaya_private_audit: "the private layer never leaves its device",
};

const has = (db: NodeSqlite.DatabaseSync, table: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
  undefined;
const all = (db: NodeSqlite.DatabaseSync, table: string): Array<Row> =>
  has(db, table) ? (db.prepare(`SELECT * FROM "${table}"`).all() as Array<Row>) : [];
const columns = (db: NodeSqlite.DatabaseSync, table: string) =>
  new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );

const insert = (db: NodeSqlite.DatabaseSync, table: string, row: Row) => {
  const keep = columns(db, table);
  const names = Object.keys(row).filter((k) => keep.has(k));
  db.prepare(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((n) => row[n] ?? null));
};

const same = (a: Row, b: Row, ignore: ReadonlyArray<string>) =>
  Object.keys(a).every((k) => ignore.includes(k) || a[k] === b[k]);

interface Plan {
  readonly table: string;
  /** The row's identity on both machines. */
  readonly key: (row: Row) => string;
  /** Columns that may differ and still be the same row (an autoincrement id). */
  readonly ignore?: ReadonlyArray<string>;
  /** Columns left for the brain to assign. */
  readonly drop?: ReadonlyArray<string>;
  readonly take?: (row: Row, now: number) => boolean;
  /** The row as the brain stores it, with where it came from. */
  readonly tag?: (row: Row, from: { label: string; at: string }) => Row;
}

const withData = (column: string) => (row: Row, from: { label: string; at: string }) => {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row[column] ?? "{}")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      data = parsed as Record<string, unknown>;
  } catch {
    data = { raw: row[column] };
  }
  return {
    ...row,
    [column]: JSON.stringify({ ...data, migrated: { from: from.label, at: from.at } }),
  };
};

const PLANS: ReadonlyArray<Plan> = [
  // The seeded owner row is made on each server at its first start: the same member, a moment apart.
  { table: "tessaya_household_members", key: (r) => String(r["id"]), ignore: ["created_at"] },
  {
    table: "fabric_memory_items",
    // A memory both servers learned stays once: by id, then by what it came from and says.
    key: (r) => String(r["id"]),
    tag: (r, from) => ({ ...r, received_at: from.at }),
  },
  { table: "fabric_memory_tombstones", key: (r) => String(r["id"]) },
  {
    table: "tessaya_action_events",
    key: (r) => String(r["id"]),
    ignore: ["data_json"],
    tag: withData("data_json"),
  },
  {
    table: "tessaya_brain_usage",
    key: (r) =>
      r["event_id"] !== null
        ? `e:${String(r["event_id"])}`
        : r["call_key"] !== null
          ? `c:${String(r["call_key"])}`
          : `t:${JSON.stringify([r["at"], r["role"], r["model"], r["input"], r["output"], r["feature"]])}`,
    ignore: ["id"],
    drop: ["id"],
  },
  {
    table: "fabric_record",
    key: (r) =>
      r["event_id"] !== null
        ? `e:${String(r["event_id"])}`
        : `t:${JSON.stringify([r["at"], r["kind"], r["actor"], r["ref"], r["subject"], r["outcome"]])}`,
    ignore: ["id"],
    drop: ["id"],
  },
  // Her mood per persona: the brain's row is the one she lives by; only a persona the brain never held arrives.
  { table: "tessaya_affect_state", key: (r) => String(r["persona"]) },
  {
    table: "fabric_phone_prompts",
    key: (r) => String(r["id"]),
    take: (r, now) => r["status"] === "pending" && Number(r["expires_at"]) > now,
  },
];

export const fold = (
  from: NodeSqlite.DatabaseSync,
  into: NodeSqlite.DatabaseSync,
  options: { readonly label: string; readonly apply: boolean; readonly now: number },
): FoldReport => {
  const at = new Date(options.now).toISOString();
  const tables: Array<TableReport> = [];
  if (options.apply) into.exec("BEGIN IMMEDIATE");
  try {
    for (const plan of PLANS) {
      const theirs = all(from, plan.table).filter((r) => plan.take?.(r, options.now) ?? true);
      const mineRows = all(into, plan.table);
      const mine = new Map(mineRows.map((r) => [plan.key(r), r]));
      // Memory: the same words from the same source, under another id, are one memory.
      const bySource =
        plan.table === "fabric_memory_items"
          ? new Set(mineRows.map((r) => `${String(r["source_ref"])}\u0000${String(r["text"])}`))
          : null;
      let imported = 0;
      let duplicates = 0;
      const conflicts: Array<string> = [];
      for (const row of theirs) {
        const key = plan.key(row);
        const held = mine.get(key);
        if (held !== undefined) {
          if (same(row, held, plan.ignore ?? [])) duplicates++;
          else conflicts.push(key);
          continue;
        }
        if (bySource?.has(`${String(row["source_ref"])}\u0000${String(row["text"])}`) === true) {
          duplicates++;
          continue;
        }
        imported++;
        mine.set(key, row);
        if (!options.apply || !has(into, plan.table)) continue;
        const tagged = plan.tag?.(row, { label: options.label, at }) ?? row;
        insert(
          into,
          plan.table,
          Object.fromEntries(
            Object.entries(tagged).filter(([k]) => !(plan.drop ?? []).includes(k)),
          ),
        );
      }
      tables.push({
        table: plan.table,
        inPeer: theirs.length,
        inBrain: mineRows.length,
        imported,
        duplicates,
        conflicts,
      });
    }
    if (options.apply && has(into, "tessaya_action_events"))
      insert(into, "tessaya_action_events", {
        id: `fold-${options.label}-${options.now}`,
        at: options.now,
        kind: "brain.fold",
        origin: options.label,
        actor_kind: "system",
        actor_id: "tessaya-fold-into-brain",
        certainty: 1,
        cause_json: "[]",
        evidence_json: "[]",
        persona: null,
        subject: options.label,
        outcome: `folded ${tables.reduce((n, t) => n + t.imported, 0)} rows from ${options.label}`,
        data_json: JSON.stringify({ tables: tables.map(({ conflicts: _, ...t }) => t) }),
      });
    if (options.apply) into.exec("COMMIT");
  } catch (error) {
    if (options.apply) into.exec("ROLLBACK");
    throw error;
  }
  return { label: options.label, applied: options.apply, at, tables, kept: KEPT };
};

const main = () => {
  const { values } = NodeUtil.parseArgs({
    options: {
      from: { type: "string" },
      into: { type: "string" },
      label: { type: "string" },
      report: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const { from, into, label, report, apply } = values;
  if (from === undefined || into === undefined || label === undefined)
    throw new Error("--from <copy>, --into <brain baton.sqlite> and --label <peer> are required");
  if (from.includes("/.t3/userdata/"))
    throw new Error("--from must be a copy taken off the peer, never its live database");
  const now = Date.now();
  if (apply) {
    const backup = `${into}.before-fold-${label}-${now}.sqlite`;
    new NodeSqlite.DatabaseSync(into, { readOnly: true }).exec(
      `VACUUM INTO '${backup.replaceAll("'", "''")}'`,
    );
    console.error(`backup: ${backup}`);
  }
  const result = fold(
    new NodeSqlite.DatabaseSync(from, { readOnly: true }),
    new NodeSqlite.DatabaseSync(into, { readOnly: !apply }),
    { label, apply: apply === true, now },
  );
  const json = JSON.stringify(result, null, 2);
  if (report !== undefined) NodeFS.writeFileSync(report, json);
  console.log(json);
};

if (import.meta.main) main();
