import {
  primaryTabCapacity,
  TESSAYA_TAB_LABELS,
  TESSAYA_TAB_ORDER,
  tessayaAppOn,
} from "../../tessaya/tessayaTabs";

export const NAVIGATION_TAB_ORDER = ["threads", "pullRequests", "usage"] as const;
// Baton (0025-tessaya-phone.patch): Tessaya's own app adds Today and Devices (features/tessaya).
export type NavigationTab =
  | (typeof NAVIGATION_TAB_ORDER)[number]
  | Exclude<(typeof TESSAYA_TAB_ORDER)[number], (typeof NAVIGATION_TAB_ORDER)[number]>;

export function navigationCustomizationAvailable(
  registeredSections: number = NAVIGATION_TAB_ORDER.length,
) {
  return registeredSections > 4;
}

export const NAVIGATION_TAB_LABELS: Readonly<Record<NavigationTab, string>> = {
  ...TESSAYA_TAB_LABELS,
  threads: tessayaAppOn() ? TESSAYA_TAB_LABELS.threads : "Threads",
  pullRequests: "Pulls",
  usage: "Usage",
};

function isNavigationTab(value: unknown): value is NavigationTab {
  return NAVIGATION_TAB_ORDER.some((tab) => tab === value);
}

/** Complete older preferences without losing their order or retaining removed sections. */
export function resolveNavigationTabOrder(saved?: readonly unknown[]): readonly NavigationTab[] {
  if (tessayaAppOn()) return TESSAYA_TAB_ORDER;
  if (!saved?.length) return NAVIGATION_TAB_ORDER;
  return [...new Set([...saved.filter(isNavigationTab), ...NAVIGATION_TAB_ORDER])];
}

export function moveNavigationTab(
  saved: readonly unknown[] | undefined,
  tab: NavigationTab,
  position: number,
): readonly NavigationTab[] {
  const order = [...resolveNavigationTabOrder(saved)];
  const from = order.indexOf(tab);
  const to = Math.max(0, Math.min(order.length - 1, position));
  order.splice(from, 1);
  order.splice(to, 0, tab);
  return order;
}

export function resolveHiddenNavigationTabs(saved?: readonly unknown[]): readonly NavigationTab[] {
  return [...new Set(saved?.filter(isNavigationTab) ?? [])];
}

export function toggleNavigationTabVisibility(
  saved: readonly unknown[] | undefined,
  tab: NavigationTab,
) {
  const hidden = resolveHiddenNavigationTabs(saved);
  return hidden.includes(tab) ? hidden.filter((candidate) => candidate !== tab) : [...hidden, tab];
}

export function enabledNavigationTabs(saved?: readonly unknown[], hidden?: readonly unknown[]) {
  const excluded = resolveHiddenNavigationTabs(hidden);
  return resolveNavigationTabOrder(saved).filter((tab) => !excluded.includes(tab));
}

export function visibleNavigationTabs(
  saved?: readonly unknown[],
  hidden?: readonly unknown[],
  capacity = 4,
) {
  return enabledNavigationTabs(saved, hidden).slice(
    0,
    primaryTabCapacity(tessayaAppOn(), capacity),
  );
}

export function overflowNavigationTabs(saved?: readonly unknown[], hidden?: readonly unknown[]) {
  return enabledNavigationTabs(saved, hidden).slice(primaryTabCapacity(tessayaAppOn(), 4));
}

export function selectedNavigationTab(
  saved: readonly unknown[] | undefined,
  selected: NavigationTab,
  settingsOpen: boolean,
  hidden?: readonly unknown[],
  capacity = 4,
): NavigationTab | "settings" {
  return settingsOpen || !visibleNavigationTabs(saved, hidden, capacity).includes(selected)
    ? "settings"
    : selected;
}

export function resolveSelectedNavigationTab(
  saved: readonly unknown[] | undefined,
  hidden: readonly unknown[] | undefined,
  selected: NavigationTab,
) {
  const enabled = enabledNavigationTabs(saved, hidden);
  return enabled.includes(selected) ? selected : enabled[0];
}
