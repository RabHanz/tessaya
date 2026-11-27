import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useWorkspaceTabs } from "../../layout/workspace/WorkspaceTabsContext";

/**
 * What covers the bottom of a screen drawn edge to edge (Talk, the Sleeve): the home indicator and, on a tab, the
 * floating tab bar, which iOS leaves out of the safe area.
 */
export function useBottomClearance(): number {
  const insets = useSafeAreaInsets();
  return Math.max(insets.bottom, useWorkspaceTabs()?.bottomClearance ?? 0);
}

/** The end padding of a Tessaya page's list; the tab bar's room is already in its safe area or scroll inset. */
export function useListEndPadding(): number {
  return Math.max(useSafeAreaInsets().bottom, 18) + 18;
}
