/** The Memory area of Tessaya's window (D150): the bar, then one row per memory, grouped by kind. */
import {
  isLesson,
  LESSONS_CAP,
  whyRemembered,
  type MemoryItem,
  type MemoryKind,
  type MemoryVersion,
} from "@t3tools/baton-shared/memory";

import type { HomeControl } from "../home/batonHome.ts";
import type { SyncPeer } from "./memorySync.ts";

export interface MemoryTabState {
  readonly items: ReadonlyArray<MemoryItem>;
  readonly query: string;
  /** "all", a kind, "held" (waiting for his yes) or "replaced" (history). */
  readonly filter: string;
  readonly usedIds: ReadonlySet<string>;
  readonly usedOnly: boolean;
  readonly syncOn: boolean;
  /** The servers the window is connected to, each with whether its walled memory syncs. */
  readonly peers: ReadonlyArray<SyncPeer>;
  readonly pullOn: boolean;
  readonly status: string;
  /** The item whose History is open, and its earlier wordings (newest first). */
  readonly history?: {
    readonly id: string;
    readonly versions: ReadonlyArray<MemoryVersion>;
  } | null;
}

const BY_TEXT: Readonly<Record<MemoryVersion["by"], string>> = {
  him: "you",
  consolidate: "merging similar memories",
  rewrite: "the weekly rewrite",
  sync: "another of your servers",
  import: "an import",
};

/** An item's earlier wordings under it, each with Restore (a new version; the history stays). */
export const historyRows = (
  item: MemoryItem,
  section: string,
  versions: ReadonlyArray<MemoryVersion>,
): ReadonlyArray<HomeControl> =>
  versions.length === 0
    ? [
        {
          id: `m.history.none:${item.id}`,
          section,
          label: "No earlier wording",
          kind: "check",
          status: "ok",
          detail: "This memory has not been changed.",
        },
      ]
    : versions.map((v) => ({
        id: `m.restore:${item.id}:${v.version}`,
        section,
        label: v.text,
        hint: `Version ${v.version}, ${v.at.slice(0, 16).replace("T", " ")}, changed by ${BY_TEXT[v.by]}: ${v.why}.`,
        kind: "action" as const,
        button: "Restore",
      }));

const KINDS: ReadonlyArray<readonly [MemoryKind, string]> = [
  ["preference", "Preferences"],
  ["correction", "Corrections"],
  ["decision", "Decisions"],
  ["fact", "Facts"],
  ["learning", "Learnings"],
  ["episode", "Episodes"],
  ["note", "Notes"],
];

export const memoryMatches = (item: MemoryItem, words: ReadonlyArray<string>): boolean => {
  const hay = `${item.text} ${item.kind} ${item.scopeRef ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};

export const memoryMeta = (item: MemoryItem, used: boolean): string =>
  [
    item.kind,
    item.source === "user" ? "your words" : `${Math.round(item.confidence * 100)}% sure`,
    item.scope === "global" ? null : `${item.scope}: ${item.scopeRef ?? ""}`,
    item.source === "import" ? "imported" : null,
    item.pinned ? "pinned" : null,
    used ? "used in the last answer" : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");

export const memoryControls = (s: MemoryTabState): ReadonlyArray<HomeControl> => {
  const live = s.items.filter((i) => i.supersededBy === null && !i.proposed);
  const held = s.items.filter((i) => i.proposed);
  const replaced = s.items.filter((i) => i.supersededBy !== null);
  const kinds = [
    { value: "all", label: "All", count: live.length },
    ...KINDS.map(([value, label]) => ({
      value,
      label,
      count: live.filter((i) => i.kind === value).length,
    })).filter((k) => k.count > 0),
    ...(held.length > 0 ? [{ value: "held", label: "Waiting for you", count: held.length }] : []),
    ...(replaced.length > 0
      ? [{ value: "replaced", label: "Replaced", count: replaced.length }]
      : []),
  ];
  const bar: HomeControl = {
    id: "m.bar",
    section: "Memory",
    label: "Memory",
    kind: "memoryBar",
    query: s.query,
    filter: s.filter,
    kinds,
    usedOnly: s.usedOnly,
    usedCount: s.usedIds.size,
    syncOn: s.syncOn,
    peers: s.peers,
    pullOn: s.pullOn,
    status: s.status,
  };

  const pool = s.filter === "held" ? held : s.filter === "replaced" ? replaced : live;
  const words = s.query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = pool
    .filter(
      (i) =>
        s.filter === "all" || s.filter === "held" || s.filter === "replaced" || i.kind === s.filter,
    )
    .filter((i) => !s.usedOnly || s.usedIds.has(i.id))
    .filter((i) => memoryMatches(i, words));

  const row = (item: MemoryItem, section: string): HomeControl => ({
    id: `m:${item.id}`,
    section,
    label: item.text,
    hint: memoryMeta(item, s.usedIds.has(item.id)),
    kind: "memory",
    pinned: item.pinned,
    held: item.proposed,
    why: whyRemembered(item),
  });
  const sectionOf = (item: MemoryItem): string =>
    item.proposed
      ? "Waiting for your yes"
      : item.supersededBy !== null
        ? "Replaced"
        : (KINDS.find(([k]) => k === item.kind)?.[1] ?? "Notes");
  const ordered = [...shown].toSorted(
    (a, b) =>
      KINDS.findIndex(([k]) => k === a.kind) - KINDS.findIndex(([k]) => k === b.kind) ||
      Number(b.pinned) - Number(a.pinned) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  const rows = ordered.flatMap((i) => [
    row(i, sectionOf(i)),
    ...(s.history?.id === i.id ? historyRows(i, sectionOf(i), s.history.versions) : []),
  ]);
  // His lessons: how many, against the cap, and what they do.
  const lessons = live.filter(isLesson).length;
  const lessonRow: ReadonlyArray<HomeControl> =
    lessons === 0
      ? []
      : [
          {
            id: "m.lessons",
            section: "Corrections",
            label: "Lessons you taught",
            kind: "check",
            status: "ok",
            detail: `${lessons} of ${LESSONS_CAP}${lessons > LESSONS_CAP ? `: the newest ${LESSONS_CAP} are used` : ""}. They come first in what she recalls, and win where another memory disagrees.`,
          },
        ];
  if (rows.length > 0) return [bar, ...lessonRow, ...rows];
  return [
    bar,
    {
      id: "m.empty",
      section: "Memory",
      label: s.items.length === 0 ? "Nothing remembered yet" : "Nothing matches",
      hint:
        s.items.length === 0
          ? 'Say "remember that..." and it is kept here. What you teach it while you work is added as it learns.'
          : "Try fewer words, or pick All.",
      kind: "check",
      status: "ok",
      detail: s.items.length === 0 ? "Nothing is being kept." : "No memory fits the filter.",
    },
  ];
};

/** `m.pin:<id>` and the like carry the memory's id after the colon. */
export const memoryIdOf = (id: string, prefix: string): string | null =>
  id.startsWith(`${prefix}:`) ? id.slice(prefix.length + 1) : null;
