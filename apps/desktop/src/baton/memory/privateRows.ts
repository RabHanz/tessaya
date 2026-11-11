// @effect-diagnostics globalDate:off
/**
 * The People area of the Memory tab (tessaya-ops research/PRIVATE-MEMORIES.md section 9): his everyday memory, his
 * private store and each person's, each under its PIN. Only an open store's rows are drawn; a locked one shows its
 * name, its count and how to open it.
 */
import type { BatonPrivateStore } from "@t3tools/baton-contracts";
import { whyRemembered, type MemoryItem } from "@t3tools/baton-shared/memory";

import type { HomeControl } from "../home/batonHome.ts";
import { text } from "../home/strings.ts";
import { memoryMatches, memoryMeta } from "./memoryRows.ts";

export const EVERYDAY = "everyday";

export interface PrivateAuditRow {
  readonly name: string;
  readonly action: string;
  readonly outcome: string;
  readonly by: string;
  readonly count: number;
  readonly at: string;
}

export interface PrivateTabState {
  readonly stores: ReadonlyArray<BatonPrivateStore>;
  readonly selected: string;
  /** The selected store's memories, while it is open. */
  readonly items: ReadonlyArray<MemoryItem> | null;
  readonly query: string;
  readonly status: string;
  readonly recovery: { readonly name: string; readonly code: string } | null;
  /** Stores this window opened as admin. */
  readonly admin: ReadonlySet<string>;
  readonly audit: {
    readonly intact: boolean;
    readonly rows: ReadonlyArray<PrivateAuditRow>;
  } | null;
  readonly confirmDelete: boolean;
  readonly everydayCount: number | null;
  readonly now: number;
}

/** Open for this window, and not past its lease: the server's sweep may not have run yet. */
export const openNow = (s: BatonPrivateStore, now: number): boolean =>
  s.open && (s.openUntil === null || Date.parse(s.openUntil) > now);

export const storeName = (s: BatonPrivateStore): string =>
  s.kind === "owner" ? text("pv.owner") : s.name;

const stateOf = (s: BatonPrivateStore, now: number) =>
  openNow(s, now)
    ? ("open" as const)
    : s.recoveryOnly
      ? ("recovery" as const)
      : s.waitUntil !== null && Date.parse(s.waitUntil) > now
        ? ("wait" as const)
        : ("locked" as const);

const count = (n: number) => text(n === 1 ? "pv.count.one" : "pv.count", { n });

const noteOf = (s: BatonPrivateStore, now: number): string => {
  const state = stateOf(s, now);
  const lock =
    state === "open"
      ? s.openUntil === null
        ? text("pv.open.now")
        : text("pv.locksIn", {
            n: Math.max(1, Math.ceil((Date.parse(s.openUntil) - now) / 60_000)),
          })
      : state === "wait"
        ? text("pv.wait", { at: new Date(s.waitUntil!).toTimeString().slice(0, 5) })
        : state === "recovery"
          ? text("pv.recoveryOnly")
          : text("pv.locked");
  return [count(s.items), lock, s.recallOff ? text("pv.recallOff") : null]
    .filter((x): x is string => x !== null)
    .join(" · ");
};

export const privateControls = (s: PrivateTabState): ReadonlyArray<HomeControl> => {
  const section = text("pv.section");
  const ownerOpen = s.stores.some((x) => x.kind === "owner" && openNow(x, s.now));
  const ordered = [...s.stores].toSorted(
    (a, b) =>
      Number(b.kind === "owner") - Number(a.kind === "owner") || a.name.localeCompare(b.name),
  );
  const people: HomeControl = {
    id: "m.pv.people",
    section,
    label: section,
    kind: "privatePeople",
    people: [
      {
        id: EVERYDAY,
        name: text("pv.everyday"),
        state: "everyday",
        note: s.everydayCount === null ? text("pv.everyday.note") : count(s.everydayCount),
        selected: s.selected === EVERYDAY,
        admin: false,
      },
      ...ordered.map((x) => ({
        id: x.id,
        name: storeName(x),
        state: stateOf(x, s.now),
        note: noteOf(x, s.now),
        selected: s.selected === x.id,
        admin: ownerOpen && x.kind === "person" && !openNow(x, s.now),
      })),
    ],
    canSetup: !s.stores.some((x) => x.kind === "owner"),
    ownerOpen,
    recovery: s.recovery,
    status: s.status,
  };
  const store = s.stores.find((x) => x.id === s.selected);
  if (store === undefined || s.items === null || !openNow(store, s.now)) return [people];

  const name = storeName(store);
  const bar: HomeControl = {
    id: "m.pv.bar",
    section: name,
    label: name,
    kind: "privateBar",
    store: store.id,
    query: s.query,
    recallOff: store.recallOff,
    canChangePin: !s.admin.has(store.id),
    canDelete: store.kind === "person" && ownerOpen,
    confirmDelete: s.confirmDelete,
    audit:
      s.audit === null
        ? null
        : {
            intact: s.audit.intact,
            rows: s.audit.rows.toReversed().map((r) => ({
              line: [r.name, r.action, r.outcome, r.by, r.count > 0 ? count(r.count) : null]
                .filter((x): x is string => x !== null)
                .join(" · "),
              at: r.at,
            })),
          },
  };
  const words = s.query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = s.items
    .filter((i) => memoryMatches(i, words))
    .toSorted(
      (a, b) => Number(b.proposed) - Number(a.proposed) || b.updatedAt.localeCompare(a.updatedAt),
    );
  const rows = shown.map((item): HomeControl => ({
    id: `m.pv:${store.id}/${item.id}`,
    section: item.proposed ? text("pv.waiting") : name,
    label: item.text,
    hint: memoryMeta(item, false),
    kind: "memory",
    pinned: false,
    held: item.proposed,
    why: whyRemembered(item),
    store: store.id,
  }));
  if (rows.length > 0) return [people, bar, ...rows];
  return [
    people,
    bar,
    {
      id: "m.pv.empty",
      section: name,
      label: s.items.length === 0 ? text("pv.empty") : text("pv.nomatch"),
      kind: "check",
      status: "ok",
      detail: s.items.length === 0 ? text("pv.empty.detail") : text("pv.nomatch.detail"),
    },
  ];
};
