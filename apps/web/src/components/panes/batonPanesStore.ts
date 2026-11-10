import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isElectron } from "../../env";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { resolveStorage } from "../../lib/storage";
import type { ThreadRouteTarget } from "../../threadRoutes";
import {
  closePane,
  dockPaneTree,
  dockPaneTreeToEdge,
  fitPaneTree,
  openPane,
  paneTargetKey,
  resizePaneTree,
  resolvePaneLayout,
  type PaneDropZone,
  type PaneEdge,
  type PaneLayout,
  type PaneSlotId,
  type PaneTree,
} from "./batonPaneLayout";
import { announceClaim, batonWindowId, MAIN_WINDOW_ID, onThreadClaimed } from "./batonWindows";

interface BatonPanesState extends PaneLayout {
  readonly tree: PaneTree | null;
  /** Dragged or moved by hand, so opening a pane adapts the layout instead of resetting it. */
  readonly arranged: boolean;
  /** Threads another window claimed; this window keeps the pane and shows no ChatView for them. */
  readonly ceded: ReadonlyArray<string>;
  /**
   * Decided once from the URL this page started on: only a desktop window opened at home resumes
   * its panes. Web tabs share one layout, so there every tab would jump to the same thread.
   */
  readonly restorePending: boolean;
  readonly settleRestore: () => void;
  /** Any page but home has shown, so a later visit home is a choice, not a reopen. */
  readonly noteLocation: (pathname: string) => void;
  readonly commitRoute: (route: ThreadRouteTarget) => void;
  readonly open: (route: ThreadRouteTarget, target: ThreadRouteTarget) => void;
  readonly close: (id: PaneSlotId) => void;
  readonly resize: (path: ReadonlyArray<number>, index: number, at: number) => void;
  readonly dock: (moved: PaneSlotId, target: PaneSlotId, zone: PaneDropZone) => void;
  readonly dockToEdge: (moved: PaneSlotId, edge: PaneEdge) => void;
  readonly claim: (target: ThreadRouteTarget) => void;
}

const windowId = batonWindowId();

export const useBatonPanesStore = create<BatonPanesState>()(
  persist(
    (set, get) => {
      const currentTree = () => {
        const { tree, arranged, slots } = get();
        return fitPaneTree(
          tree,
          arranged,
          slots.map((slot) => slot.id),
        );
      };
      return {
        slots: [],
        focusedSlotId: null,
        tree: null,
        arranged: false,
        ceded: [],
        restorePending:
          isElectron && typeof window !== "undefined" && startedAtHome(window.location.hash),
        settleRestore: () => set({ restorePending: false }),
        noteLocation: (pathname) => {
          if (pathname !== "/" && get().restorePending) set({ restorePending: false });
        },
        commitRoute: (route) => {
          const state = get();
          const next = resolvePaneLayout(state, route);
          const key = paneTargetKey(route);
          // Only a thread arriving here claims; a reload of a held pane must not take it back.
          const arriving = !state.slots.some((slot) => paneTargetKey(slot.target) === key);
          if (arriving) announceClaim(key);
          if (next.slots !== state.slots || next.focusedSlotId !== state.focusedSlotId) {
            set({
              slots: next.slots,
              focusedSlotId: next.focusedSlotId,
              ceded: arriving ? state.ceded.filter((entry) => entry !== key) : state.ceded,
            });
          }
        },
        open: (route, target) => {
          const key = paneTargetKey(target);
          const next = openPane(get(), route, target);
          announceClaim(key);
          set((state) => ({
            slots: next.slots,
            focusedSlotId: next.focusedSlotId,
            ceded: state.ceded.filter((entry) => entry !== key),
          }));
        },
        close: (id) => {
          const { layout } = closePane(get(), id);
          const held = new Set(layout.slots.map((slot) => paneTargetKey(slot.target)));
          set({
            slots: layout.slots,
            focusedSlotId: layout.focusedSlotId,
            arranged: layout.slots.length > 1 && get().arranged,
            ceded: get().ceded.filter((entry) => held.has(entry)),
          });
        },
        resize: (path, index, at) => {
          const tree = currentTree();
          if (tree !== null) set({ tree: resizePaneTree(tree, path, index, at) });
        },
        dock: (moved, target, zone) => {
          const tree = currentTree();
          if (tree !== null) {
            set({ tree: dockPaneTree(tree, moved, target, zone), arranged: true });
          }
        },
        dockToEdge: (moved, edge) => {
          const tree = currentTree();
          if (tree !== null) set({ tree: dockPaneTreeToEdge(tree, moved, edge), arranged: true });
        },
        claim: (target) => {
          const key = paneTargetKey(target);
          announceClaim(key);
          set((state) => ({ ceded: state.ceded.filter((entry) => entry !== key) }));
        },
      };
    },
    {
      // The main window keeps the key it always had, so a layout from before detaching survives.
      name:
        windowId === MAIN_WINDOW_ID ? "t3code:baton-panes:v1" : `t3code:baton-panes:v1:${windowId}`,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ slots, focusedSlotId, tree, arranged, ceded }) => ({
        slots,
        focusedSlotId,
        tree,
        arranged,
        ceded,
      }),
    },
  ),
);

onThreadClaimed((key) => {
  const { slots, ceded } = useBatonPanesStore.getState();
  if (ceded.includes(key) || !slots.some((slot) => paneTargetKey(slot.target) === key)) return;
  useBatonPanesStore.setState({ ceded: [...ceded, key] });
});

// Every window writes the whole drafts blob, so it would overwrite what another window saved. A
// window owns the drafts of the threads it holds and takes the rest from storage.
export function adoptStoredComposerDrafts(): Promise<void> {
  const before = useComposerDraftStore.getState();
  // A held thread's composer can still write under its draft id until its promotion finalizes.
  const mine = new Set(
    useBatonPanesStore
      .getState()
      .slots.flatMap((slot) => [
        paneTargetKey(slot.target),
        resolveComposerDraftKey(
          before,
          slot.target.kind === "server" ? slot.target.threadRef : slot.target.draftId,
        ) ?? "",
      ]),
  );
  const keep = <A>(entries: Record<string, A>) =>
    Object.fromEntries(Object.entries(entries).filter(([key]) => mine.has(key)));
  const drafts = keep(before.draftsByThreadKey);
  const sessions = keep(before.draftThreadsByThreadKey);
  return Promise.resolve(useComposerDraftStore.persist.rehydrate()).then(() => {
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: { ...state.draftsByThreadKey, ...drafts },
      draftThreadsByThreadKey: { ...state.draftThreadsByThreadKey, ...sessions },
    }));
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === COMPOSER_DRAFT_STORAGE_KEY) void adoptStoredComposerDrafts();
  });
}

export function startedAtHome(hash: string): boolean {
  return hash === "" || hash === "#" || hash === "#/";
}

/** Opens a thread beside the current one. Outside a thread route it has nothing to sit beside. */
export function openThreadInSplit(route: ThreadRouteTarget | null, target: ThreadRouteTarget) {
  if (route === null || paneTargetKey(route) === paneTargetKey(target)) return;
  useBatonPanesStore.getState().open(route, target);
}
