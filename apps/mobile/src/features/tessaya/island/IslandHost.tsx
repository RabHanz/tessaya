import { useEffect } from "react";
import { AppState } from "react-native";

import { IslandPill } from "./IslandPill";
import { postIslandOutside } from "./islandSystem";
import { useIslandItems } from "./useIslandItems";

/** The island on every screen, and on the lock screen or in the shade once the app leaves the front. */
export function IslandHost(props: { readonly open: (href: string) => void }) {
  const items = useIslandItems();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the island to the system as the app goes to the background
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "background") void postIslandOutside(items);
    });
    return () => sub.remove();
  }, [items]);
  return <IslandPill items={items} open={props.open} />;
}
