#!/usr/bin/env node
/* oxlint-disable t3code/no-low-value-comments -- Baton file predating the rule (D82) */
/**
 * Writes the status file Tessaya reads for "what needs me" (shape: packages/tessaya-shared/src/needsFeeds.ts,
 * doc: docs/baton/STATUS_FILES.md). Any system can run it from cron or a hook. Node only, no installs.
 *
 *   status-file.mjs --out /path/cockpit.json --source "Cockpit approvals" \
 *     --item 'a1|Approve the invoice run|Waiting since Monday|80|2026-11-05T09:00:00Z' --item 'a2|Check the deploy'
 *   some-command | status-file.mjs --out file.json --source Peers --items-json -
 *
 * An --item is `id|title|why|weight|due`; only the title is required. The write is atomic, so a reader
 * never sees half a file.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ITEMS_MAX = 50;

const clean = (v, max) =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined;

/** `id|title|why|weight|due` -> an item, or null when it has no title. */
export const parseItem = (spec) => {
  const parts = spec.split("|");
  const [id, title, why, weight, due] = parts.length === 1 ? [undefined, parts[0]] : parts;
  const t = clean(title, 160);
  if (t === undefined) return null;
  const w = Number(weight);
  const dueMs = due === undefined ? NaN : Date.parse(due);
  return {
    id: clean(id, 80) ?? t,
    title: t,
    ...(clean(why, 200) === undefined ? {} : { why: clean(why, 200) }),
    ...(weight === undefined || weight.trim() === "" || Number.isNaN(w)
      ? {}
      : { weight: Math.max(0, Math.min(100, w)) }),
    ...(Number.isNaN(dueMs) ? {} : { due: new Date(dueMs).toISOString() }),
  };
};

/** The document the reader expects. Items without a title are dropped; at most 50 are kept. */
export const buildStatus = (source, items, now = new Date()) => {
  const name = clean(source, 60);
  if (name === undefined)
    throw new Error("--source is required: the name of the system writing this");
  const kept = items
    .map((i) =>
      typeof i === "string"
        ? parseItem(i)
        : parseItem(
            `${i.id ?? ""}|${i.title ?? ""}|${i.why ?? ""}|${i.weight ?? ""}|${i.due ?? ""}`,
          ),
    )
    .filter((i) => i !== null)
    .slice(0, ITEMS_MAX);
  return { source: name, asOf: now.toISOString(), items: kept };
};

export const writeAtomic = (file, doc) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.resolve(file)), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`);
  NodeFS.renameSync(temp, file);
};

const main = () => {
  const argv = process.argv.slice(2);
  const opt = { items: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${key} needs a value`);
    if (key === "--out") opt.out = value;
    else if (key === "--source") opt.source = value;
    else if (key === "--item") opt.items.push(value);
    else if (key === "--items-json") {
      const raw =
        value === "-" ? NodeFS.readFileSync(0, "utf8") : NodeFS.readFileSync(value, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("--items-json must hold a JSON array");
      opt.items.push(...parsed);
    } else throw new Error(`unknown option ${key}`);
  }
  if (opt.out === undefined) throw new Error("--out is required: where to write the file");
  const doc = buildStatus(opt.source, opt.items);
  writeAtomic(opt.out, doc);
  console.log(`wrote ${doc.items.length} item(s) for "${doc.source}" to ${opt.out}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`status-file: ${error.message}`);
    process.exit(1);
  }
}
