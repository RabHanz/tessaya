// @effect-diagnostics globalConsole:off globalConsoleInEffect:off nodeBuiltinImport:off globalDate:off globalJsonInEffect:off
/**
 * One-off (17 Nov): forgets what she learned from our test playback, through the memory service. Items have no bin, so
 * each goes into `--keep` first and `--restore` adds it back. Lists only without `--apply`; run at an idle gap.
 * Usage: --db <baton.sqlite> --windows <osp-playback-windows.json> --keep <out.json> [--apply] | --db <db> --restore <out.json>
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { MemoryItem } from "@t3tools/tessaya-shared/memory";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Memory from "../src/tessaya/TessayaMemoryService.ts";

const { values: args } = NodeUtil.parseArgs({
  options: {
    db: { type: "string" },
    windows: { type: "string" },
    keep: { type: "string" },
    restore: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
if (args.db === undefined) throw new Error("--db <baton.sqlite> is required");

interface Window {
  readonly from: string;
  readonly to: string;
  readonly what: string;
}
interface Kept {
  readonly windows: ReadonlyArray<Window>;
  readonly turns: ReadonlyArray<{ readonly at: string; readonly heard: string }>;
  readonly items: ReadonlyArray<MemoryItem & { readonly why: string }>;
  readonly talks: ReadonlyArray<{ readonly day: string; readonly line: string }>;
  readonly sightings: ReadonlyArray<{
    readonly id: string;
    readonly entity: string;
    readonly at: string;
  }>;
}

/** Sound in the room only: `cmd/voice/wakeinject` runs fed the Tessel digitally while he spoke live, so they stay out. */
const acousticWindows = (file: string): ReadonlyArray<Window> => {
  const w = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
    sessions: ReadonlyArray<{ from: string; to: string; what: string }>;
    plays: ReadonlyArray<{ from: string; to: string; run: string; clip: string }>;
  };
  return [
    ...w.sessions,
    ...w.plays.map((p) => ({ from: p.from, to: p.to, what: `${p.run} ${p.clip}` })),
    // tessaya-ops/osp-results/ask-0618.txt: 06:18:54 to 06:19:41 GMT+5 on 16 Nov, stopped by his key press.
    { from: "2026-11-16T01:18:50.000Z", to: "2026-11-16T01:19:50.000Z", what: "osp ask-0618" },
  ];
};

/** A turn's Record line lands after her reply; what it learned lands up to a learning call later. */
const TURN_GRACE_MS = 15_000;
const LEARN_GRACE_MS = 120_000;
const inside = (wins: ReadonlyArray<Window>, at: string, graceMs: number) => {
  const t = Date.parse(at);
  return wins.find((w) => t >= Date.parse(w.from) && t <= Date.parse(w.to) + graceMs) ?? null;
};
/** As `noteTalk` keeps a line. */
const talkLine = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 80);

const find = Effect.fn("unlearnPlayback.find")(function* (wins: ReadonlyArray<Window>) {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* Memory.TessayaMemoryService;
  const rows = yield* sql<{ at: string; subject: string }>`
    SELECT at, subject FROM fabric_record WHERE kind = 'device' AND subject LIKE 'heard %' ORDER BY at
  `;
  const turns = rows.flatMap((r) => {
    if (inside(wins, r.at, TURN_GRACE_MS) === null) return [];
    const heard = /^heard "(.*)"$/s.exec(r.subject)?.[1];
    return heard === undefined ? [] : [{ at: r.at, heard: JSON.parse(`"${heard}"`) as string }];
  });
  const linesByDay = new Map<string, Set<string>>();
  for (const t of turns) {
    const day = t.at.slice(0, 10);
    linesByDay.set(day, (linesByDay.get(day) ?? new Set()).add(talkLine(t.heard)));
  }
  const all = yield* memory.list({
    admin: true,
    includeProposed: true,
    includeSuperseded: true,
    limit: 100_000,
  });
  const items = all.flatMap((item) => {
    if (item.kind === "understanding") return [];
    const win = inside(wins, item.createdAt, LEARN_GRACE_MS);
    if (win !== null) return [{ ...item, why: `learned during ${win.what}` }];
    // The day's episode is written from that day's talk lines: one of them was our playback.
    const day =
      item.kind === "episode"
        ? /^day:(\d{4}-\d\d-\d\d)$/.exec(item.sourceRef ?? "")?.[1]
        : undefined;
    const heard =
      day === undefined
        ? []
        : [...(linesByDay.get(day) ?? [])].filter((l) => item.text.includes(l));
    return heard.length === 0
      ? []
      : [{ ...item, why: `episode of playback: ${heard.join(" | ")}` }];
  });
  const talks: Array<{ day: string; line: string }> = [];
  for (const [day, lines] of linesByDay)
    for (const line of yield* memory.talks(day)) if (lines.has(line)) talks.push({ day, line });
  const sightings = (yield* sql<{ id: string; entity_id: string; at: string }>`
    SELECT id, entity_id, at FROM fabric_memory_sightings ORDER BY at
  `).flatMap((s) =>
    inside(wins, s.at, TURN_GRACE_MS) === null ? [] : [{ id: s.id, entity: s.entity_id, at: s.at }],
  );
  return { windows: wins, turns, items, talks, sightings } satisfies Kept;
});

const program = Effect.gen(function* () {
  const memory = yield* Memory.TessayaMemoryService;
  if (args.restore !== undefined) {
    const kept = JSON.parse(NodeFS.readFileSync(args.restore, "utf8")) as Kept;
    for (const item of kept.items) {
      const back = yield* memory.add({
        kind: item.kind,
        text: item.text,
        source: item.source,
        sourceRef: item.sourceRef,
        scope: item.scope,
        scopeRef: item.scopeRef,
        confidence: item.confidence,
        pinned: item.pinned,
        expiresAt: item.expiresAt,
        createdAt: item.createdAt,
        ...(item.persona === undefined ? {} : { persona: item.persona }),
        ...(item.visibility === undefined ? {} : { visibility: item.visibility }),
        ...(item.surface === undefined ? {} : { surface: item.surface }),
        ...(item.speaker === undefined ? {} : { speaker: item.speaker }),
      });
      console.log(`restored ${item.id} as ${back.id}`);
    }
    for (const t of kept.talks) yield* memory.noteTalk(t.day, t.line);
    console.log(`restored ${kept.talks.length} talk lines`);
    return;
  }
  if (args.windows === undefined || args.keep === undefined)
    throw new Error("--windows <json> and --keep <out.json> are required");
  const kept = yield* find(acousticWindows(args.windows));
  NodeFS.writeFileSync(args.keep, JSON.stringify(kept, null, 1));
  console.log(`playback turns: ${kept.turns.length}`);
  for (const t of kept.turns) console.log(`  ${t.at} ${t.heard.slice(0, 90)}`);
  console.log(`memory items to forget: ${kept.items.length}`);
  for (const i of kept.items)
    console.log(`  ${i.id} ${i.kind} ${i.createdAt} (${i.why})\n    ${i.text.slice(0, 200)}`);
  console.log(`talk lines to drop: ${kept.talks.length}`);
  for (const t of kept.talks) console.log(`  talks:${t.day} ${t.line}`);
  // No sighting can be binned alone: a person goes to People's bin whole, which he decides in People.
  console.log(`people sightings during playback (left for People): ${kept.sightings.length}`);
  for (const s of kept.sightings) console.log(`  ${s.at} ${s.entity}`);
  console.log(`kept in ${args.keep}`);
  if (!args.apply) return console.log("listed only; --apply forgets them");
  for (const i of kept.items) {
    const gone = yield* memory.forget(i.id);
    if (!gone) throw new Error(`memory item ${i.id} was not forgotten`);
  }
  const days = [...new Set(kept.talks.map((t) => t.day))];
  for (const day of days)
    yield* memory.dropTalks(
      day,
      kept.talks.filter((t) => t.day === day).map((t) => t.line),
    );
  console.log(`forgot ${kept.items.length} items and ${kept.talks.length} talk lines`);
});

const layer = Memory.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: args.db })));
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(layer);
      yield* program.pipe(
        Effect.provideContext(services),
        Effect.provideService(Memory.MemoryViewer, "server"),
      );
    }),
  ),
);
