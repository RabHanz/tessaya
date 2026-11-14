import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ContextMenuItem, LocalApi, ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadRouteTarget } from "../../threadRoutes";
import { paneTargetKey } from "./tessayaPaneLayout";

export const BATON_SPLIT_MENU_ITEM = "baton-open-in-split";
export const BATON_DETACH_MENU_ITEM = "baton-detach-to-window";

/** The thread menu with Baton's items on top; "Open in split" is absent for the thread on screen. */
export function showWithSplitItem(
  api: Pick<LocalApi, "contextMenu">,
  route: ThreadRouteTarget | null,
  threadRef: ScopedThreadRef,
) {
  return <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => {
    const onScreen = route === null || paneTargetKey(route) === scopedThreadKey(threadRef);
    return api.contextMenu.show<T | typeof BATON_SPLIT_MENU_ITEM | typeof BATON_DETACH_MENU_ITEM>(
      [
        ...(onScreen ? [] : [{ id: BATON_SPLIT_MENU_ITEM, label: "Open in split" } as const]),
        { id: BATON_DETACH_MENU_ITEM, label: "Detach to window" },
        ...items,
      ],
      position,
    );
  };
}
