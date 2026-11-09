import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { ThreadRouteTarget } from "../../threadRoutes";

/** Slot ids are fixed so a pane's React key survives every open, close and reassignment. */
export const PANE_SLOT_IDS = ["a", "b", "c", "d"] as const;
export type PaneSlotId = (typeof PANE_SLOT_IDS)[number];

export interface PaneSlot {
  readonly id: PaneSlotId;
  readonly target: ThreadRouteTarget;
}

export interface PaneLayout {
  readonly slots: ReadonlyArray<PaneSlot>;
  readonly focusedSlotId: PaneSlotId | null;
}

export const MIN_PANE_FRACTION = 0.15;

export function paneTargetKey(target: ThreadRouteTarget): string {
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

const freeSlotId = (slots: ReadonlyArray<PaneSlot>): PaneSlotId | null =>
  PANE_SLOT_IDS.find((id) => !slots.some((slot) => slot.id === id)) ?? null;

/** The route is the focus: its pane if open, otherwise the focused pane takes the route's thread. */
export function resolvePaneLayout(layout: PaneLayout, route: ThreadRouteTarget): PaneLayout {
  const routeKey = paneTargetKey(route);
  const open = layout.slots.find((slot) => paneTargetKey(slot.target) === routeKey);
  if (open) {
    return open.id === layout.focusedSlotId ? layout : { ...layout, focusedSlotId: open.id };
  }
  const focused =
    layout.slots.find((slot) => slot.id === layout.focusedSlotId) ?? layout.slots[0] ?? null;
  if (focused === null) return { slots: [{ id: "a", target: route }], focusedSlotId: "a" };
  return {
    slots: layout.slots.map((slot) =>
      slot.id === focused.id ? { id: slot.id, target: route } : slot,
    ),
    focusedSlotId: focused.id,
  };
}

/** Adds a pane without moving focus. A full grid gives up its last unfocused pane. */
export function openPane(
  layout: PaneLayout,
  route: ThreadRouteTarget,
  target: ThreadRouteTarget,
): PaneLayout {
  const resolved = resolvePaneLayout(layout, route);
  const key = paneTargetKey(target);
  if (resolved.slots.some((slot) => paneTargetKey(slot.target) === key)) return resolved;
  const id = freeSlotId(resolved.slots);
  if (id !== null) return { ...resolved, slots: [...resolved.slots, { id, target }] };
  const evicted = resolved.slots.findLast((slot) => slot.id !== resolved.focusedSlotId);
  return {
    ...resolved,
    slots: resolved.slots.map((slot) => (slot.id === evicted?.id ? { id: slot.id, target } : slot)),
  };
}

/** Removes a pane only; its thread and draft are untouched. `next` is where focus must go. */
export function closePane(
  layout: PaneLayout,
  id: PaneSlotId,
): { readonly layout: PaneLayout; readonly next: ThreadRouteTarget | null } {
  const index = layout.slots.findIndex((slot) => slot.id === id);
  if (index === -1 || layout.slots.length <= 1) return { layout, next: null };
  const slots = layout.slots.filter((slot) => slot.id !== id);
  if (layout.focusedSlotId !== id) return { layout: { ...layout, slots }, next: null };
  const neighbour = slots[Math.min(index, slots.length - 1)]!;
  return {
    layout: { slots, focusedSlotId: neighbour.id },
    next: neighbour.target,
  };
}

/**
 * What a pane's environment can do for it now: still coming up, usable, not there at all, or
 * "idle": saved but not yet asked to connect, as every saved environment reads at boot.
 */
export type PaneEnvironmentState = "connecting" | "ready" | "unreachable" | "idle";

export function paneEnvironmentState(input: {
  readonly catalogReady: boolean;
  /** The catalog lists saved environments first; the local one joins after a fetch. */
  readonly localListed: boolean;
  /** Null when the environment is not in the catalog. */
  readonly phase: EnvironmentConnectionPhase | null;
  readonly shellLive: boolean;
}): PaneEnvironmentState {
  if (!input.catalogReady || !input.localListed) return "connecting";
  // Only a first try is worth waiting on; "reconnecting" can retry forever.
  if (input.phase === "connecting") return "connecting";
  if (input.phase === "available") return "idle";
  if (input.phase !== "connected") return "unreachable";
  return input.shellLive ? "ready" : "connecting";
}

/** A pane with nothing to show waits only while something is actually on its way. */
export function paneFallback(input: {
  readonly environment: PaneEnvironmentState | null;
  /** The route still looking its thread up on a usable environment. */
  readonly threadPending: boolean;
}): "loading" | "unavailable" {
  if (input.environment === "connecting") return "loading";
  return input.environment === "ready" && input.threadPending ? "loading" : "unavailable";
}

/** Whether a saved pane can be resumed. A draft passes its project's environment. */
export function paneRestoreState(input: {
  readonly heldElsewhere: boolean;
  /** Null when the pane has no environment left, such as a draft whose session is gone. */
  readonly environment: PaneEnvironmentState | null;
  readonly exists: boolean;
}): "ready" | "waiting" | "gone" {
  if (input.heldElsewhere) return "gone";
  if (input.environment === "connecting") return "waiting";
  // Nothing can say yet whether its thread exists; skipping it lets home's draft overwrite it.
  if (input.environment === "idle") return "ready";
  return input.environment === "ready" && input.exists ? "ready" : "gone";
}

export type PaneRestore =
  | { readonly kind: "wait" }
  | { readonly kind: "stay" }
  | { readonly kind: "go"; readonly target: ThreadRouteTarget };

/**
 * Where a window opened at home resumes: its focused pane, else the next pane in order, skipping
 * threads that are gone or on environments it cannot reach. Waits while a better pane may load.
 */
export function resolvePaneRestore(
  layout: PaneLayout,
  inspect: (target: ThreadRouteTarget) => "ready" | "waiting" | "gone",
): PaneRestore {
  const focused = layout.slots.find((slot) => slot.id === layout.focusedSlotId);
  const ordered = focused
    ? [focused, ...layout.slots.filter((slot) => slot !== focused)]
    : layout.slots;
  for (const slot of ordered) {
    const state = inspect(slot.target);
    if (state === "waiting") return { kind: "wait" };
    if (state === "ready") return { kind: "go", target: slot.target };
  }
  return { kind: "stay" };
}

/**
 * Where panes sit: a split tree whose leaves are slot ids. Rendering flattens it to rects under one
 * parent, so a rearrange moves a pane without remounting its ChatView.
 */
export type PaneDirection = "row" | "column";
export interface PaneSplit {
  readonly dir: PaneDirection;
  readonly sizes: ReadonlyArray<number>;
  readonly children: ReadonlyArray<PaneTree>;
}
export type PaneTree = PaneSlotId | PaneSplit;
export type PaneEdge = "left" | "right" | "top" | "bottom";
export type PaneDropZone = PaneEdge | "center";

export interface PaneBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface PaneDivider {
  readonly path: ReadonlyArray<number>;
  readonly index: number;
  readonly dir: PaneDirection;
  /** The split this divider belongs to, as a fraction of the whole layout. */
  readonly box: PaneBox;
  /** Position inside `box`, 0 to 1 along `dir`. */
  readonly at: number;
}

const WHOLE: PaneBox = { left: 0, top: 0, width: 1, height: 1 };
const equalSizes = (count: number) => Array.from({ length: count }, () => 1 / count);
const split = (dir: PaneDirection, children: ReadonlyArray<PaneTree>): PaneSplit => ({
  dir,
  children,
  sizes: equalSizes(children.length),
});

export function paneLeaves(tree: PaneTree | null): ReadonlyArray<PaneSlotId> {
  if (tree === null) return [];
  return typeof tree === "string" ? [tree] : tree.children.flatMap(paneLeaves);
}

/** The layout nobody arranged: columns up to three, then two by two. */
export function presetPaneTree(ids: ReadonlyArray<PaneSlotId>): PaneTree | null {
  const [a, b, c, d] = ids;
  if (a === undefined) return null;
  if (b === undefined) return a;
  if (c === undefined) return split("row", [a, b]);
  if (d === undefined) return split("row", [a, b, c]);
  return split("row", [split("column", [a, c]), split("column", [b, d])]);
}

function removeLeaf(tree: PaneTree, id: PaneSlotId): PaneTree | null {
  if (typeof tree === "string") return tree === id ? null : tree;
  const kept = tree.children.flatMap((child, index) => {
    const next = removeLeaf(child, id);
    return next === null ? [] : [{ child: next, size: tree.sizes[index] ?? 0 }];
  });
  const [only] = kept;
  if (only === undefined) return null;
  if (kept.length === 1) return only.child;
  const total = kept.reduce((sum, entry) => sum + entry.size, 0);
  return {
    dir: tree.dir,
    children: kept.map((entry) => entry.child),
    sizes: kept.map((entry) => entry.size / total),
  };
}

function insertBeside(
  tree: PaneTree,
  target: PaneSlotId,
  leaf: PaneSlotId,
  edge: PaneEdge,
): PaneTree {
  const dir: PaneDirection = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  if (tree === target) return split(dir, before ? [leaf, target] : [target, leaf]);
  if (typeof tree === "string") return tree;
  const index = tree.children.indexOf(target);
  if (index !== -1 && tree.dir === dir) {
    const half = (tree.sizes[index] ?? 0) / 2;
    const at = before ? index : index + 1;
    return {
      dir,
      children: tree.children.toSpliced(at, 0, leaf),
      sizes: tree.sizes.toSpliced(index, 1, half, half),
    };
  }
  return {
    ...tree,
    children: tree.children.map((child) => insertBeside(child, target, leaf, edge)),
  };
}

function swapLeaves(tree: PaneTree, a: PaneSlotId, b: PaneSlotId): PaneTree {
  if (typeof tree === "string") return tree === a ? b : tree === b ? a : tree;
  return { ...tree, children: tree.children.map((child) => swapLeaves(child, a, b)) };
}

/** The tree for these slots: kept while it still fits, else preset, or adapted once arranged. */
export function fitPaneTree(
  tree: PaneTree | null,
  arranged: boolean,
  ids: ReadonlyArray<PaneSlotId>,
): PaneTree | null {
  const held = paneLeaves(tree);
  if (tree !== null && held.length === ids.length && held.every((id) => ids.includes(id))) {
    return tree;
  }
  if (!arranged || tree === null) return presetPaneTree(ids);
  let next: PaneTree | null = tree;
  for (const id of held) {
    if (next !== null && !ids.includes(id)) next = removeLeaf(next, id);
  }
  for (const id of ids) {
    if (next === null) next = id;
    else if (!held.includes(id)) next = insertBeside(next, paneLeaves(next).at(-1)!, id, "right");
  }
  return next;
}

/** Drop `moved` on `target`: the centre swaps them, an edge docks `moved` on that side. */
export function dockPaneTree(
  tree: PaneTree,
  moved: PaneSlotId,
  target: PaneSlotId,
  zone: PaneDropZone,
): PaneTree {
  if (moved === target) return tree;
  if (zone === "center") return swapLeaves(tree, moved, target);
  const rest = removeLeaf(tree, moved);
  return rest === null ? tree : insertBeside(rest, target, moved, zone);
}

/** The whole side of the layout goes to `moved`; everything else keeps its arrangement. */
export function dockPaneTreeToEdge(tree: PaneTree, moved: PaneSlotId, edge: PaneEdge): PaneTree {
  const rest = removeLeaf(tree, moved);
  if (rest === null) return tree;
  const dir: PaneDirection = edge === "left" || edge === "right" ? "row" : "column";
  return split(dir, edge === "left" || edge === "top" ? [moved, rest] : [rest, moved]);
}

const nextBox = (box: PaneBox, dir: PaneDirection, from: number, size: number): PaneBox =>
  dir === "row"
    ? { ...box, left: box.left + from * box.width, width: size * box.width }
    : { ...box, top: box.top + from * box.height, height: size * box.height };

export function paneRects(
  tree: PaneTree | null,
  box: PaneBox = WHOLE,
): ReadonlyArray<{ readonly id: PaneSlotId; readonly box: PaneBox }> {
  if (tree === null) return [];
  if (typeof tree === "string") return [{ id: tree, box }];
  let from = 0;
  return tree.children.flatMap((child, index) => {
    const size = tree.sizes[index] ?? 0;
    const rects = paneRects(child, nextBox(box, tree.dir, from, size));
    from += size;
    return rects;
  });
}

export function paneDividers(
  tree: PaneTree | null,
  box: PaneBox = WHOLE,
  path: ReadonlyArray<number> = [],
): ReadonlyArray<PaneDivider> {
  if (tree === null || typeof tree === "string") return [];
  const dividers: PaneDivider[] = [];
  let from = 0;
  tree.children.forEach((child, index) => {
    const size = tree.sizes[index] ?? 0;
    dividers.push(...paneDividers(child, nextBox(box, tree.dir, from, size), [...path, index]));
    from += size;
    if (index < tree.children.length - 1) {
      dividers.push({ path, index, dir: tree.dir, box, at: from });
    }
  });
  return dividers;
}

/** Moves one divider; only the two panes beside it change size. */
export function resizePaneTree(
  tree: PaneTree,
  path: ReadonlyArray<number>,
  index: number,
  at: number,
): PaneTree {
  if (typeof tree === "string" || !Number.isFinite(at)) return tree;
  const [head, ...tail] = path;
  if (head !== undefined) {
    return {
      ...tree,
      children: tree.children.map((child, i) =>
        i === head ? resizePaneTree(child, tail, index, at) : child,
      ),
    };
  }
  const before = tree.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  const pair = (tree.sizes[index] ?? 0) + (tree.sizes[index + 1] ?? 0);
  if (pair <= 2 * MIN_PANE_FRACTION) return tree;
  const size = Math.min(pair - MIN_PANE_FRACTION, Math.max(MIN_PANE_FRACTION, at - before));
  return { ...tree, sizes: tree.sizes.toSpliced(index, 2, size, pair - size) };
}

/** The pane next to `id` on that side, for moving a pane from the keyboard. */
export function paneNeighbour(
  rects: ReadonlyArray<{ readonly id: PaneSlotId; readonly box: PaneBox }>,
  id: PaneSlotId,
  edge: PaneEdge,
): PaneSlotId | null {
  const from = rects.find((rect) => rect.id === id)?.box;
  if (from === undefined) return null;
  const centre = (box: PaneBox) => ({
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
  });
  const origin = centre(from);
  const ahead = rects.flatMap((rect) => {
    const point = centre(rect.box);
    const along = {
      left: origin.x - point.x,
      right: point.x - origin.x,
      top: origin.y - point.y,
      bottom: point.y - origin.y,
    }[edge];
    const across = edge === "left" || edge === "right" ? point.y - origin.y : point.x - origin.x;
    return rect.id === id || along <= 0.001
      ? []
      : [{ id: rect.id, cost: along + Math.abs(across) }];
  });
  return ahead.toSorted((a, b) => a.cost - b.cost)[0]?.id ?? null;
}

/** Near an edge docks there, the middle swaps. `x` and `y` are 0 to 1 within the pane. */
export function paneDropZone(x: number, y: number): PaneDropZone {
  const edges: ReadonlyArray<readonly [PaneEdge, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [edge, distance] = edges.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return distance < 0.25 ? edge : "center";
}
