/**
 * The Margin (tessaya-ops handoffs/margin-integration-2026-11-28.md): his day, lists and reminders live there, and she
 * reads them live through its MCP, never copying them. Writes are add and tick only; deletes, sharing, money and
 * sending to another person are never on the list. Pure: the tool lists and where a pushed item goes.
 */

/** What she may read there. */
export const MARGIN_READS = [
  "get_my_week",
  "get_morning_brief",
  "get_week_overview",
  "list_reminders",
  "list_shopping_lists",
  "list_shopping_items",
  "list_chores",
  "list_family_events",
  "get_meal_plan",
  "search_cards",
  "get_cards",
  "list_notifications",
  "list_habits",
  "list_workspaces",
] as const;

/** What she may change there: adding and ticking. */
export const MARGIN_WRITES = [
  "add_shopping_item",
  "check_shopping_item",
  "capture",
  "complete_card",
  "complete_chore",
  "log_habit_entry",
  "set_reminder",
] as const;

export type MarginRead = (typeof MARGIN_READS)[number];
export type MarginWrite = (typeof MARGIN_WRITES)[number];

/** The home's shared lists, which anyone at home may reach; everything else there is the owner's own. */
export const MARGIN_HOUSEHOLD: ReadonlySet<string> = new Set<MarginRead | MarginWrite>([
  "list_shopping_lists",
  "list_shopping_items",
  "list_chores",
  "list_family_events",
  "get_meal_plan",
  "add_shopping_item",
  "check_shopping_item",
  "complete_chore",
]);

/** The writes whose Margin input takes an idempotency key, so a retried turn adds once. */
export const MARGIN_IDEMPOTENT: ReadonlySet<string> = new Set<MarginWrite>([
  "add_shopping_item",
  "capture",
]);

export const MARGIN_ANNOUNCE_KINDS = ["reminder", "card", "chore", "brief"] as const;
export type MarginAnnounceKind = (typeof MARGIN_ANNOUNCE_KINDS)[number];
export const MARGIN_PRIORITIES = ["low", "normal", "high"] as const;
export type MarginPriority = (typeof MARGIN_PRIORITIES)[number];

/** An item due more than this far ahead is not said yet: it waits as a card. */
export const ANNOUNCE_EARLY_MS = 5 * 60_000;

export type AnnounceRoute =
  | { readonly action: "speak"; readonly vessel: string }
  | { readonly action: "card"; readonly why: string };

/**
 * Where an item The Margin pushes goes: said aloud on the vessel he is nearest, or a card on his phone. Low priority,
 * quiet hours or do-not-disturb, not due yet, nowhere near him, or a private item with anyone else there: a card.
 */
export const announceRoute = (input: {
  readonly priority: MarginPriority;
  readonly private: boolean;
  readonly dueAt: number | null;
  readonly now: number;
  /** Quiet hours or his do-not-disturb are on. */
  readonly quiet: boolean;
  /** The vessel her line for him goes to now (`whereToSay`), or null. */
  readonly vessel: string | null;
  /** Someone other than him is placed at that vessel (a guest, another member). */
  readonly othersThere: boolean;
}): AnnounceRoute => {
  if (input.dueAt !== null && input.dueAt - input.now > ANNOUNCE_EARLY_MS)
    return { action: "card", why: "not due yet" };
  if (input.priority === "low") return { action: "card", why: "low priority" };
  if (input.quiet) return { action: "card", why: "quiet hours or do not disturb" };
  if (input.vessel === null) return { action: "card", why: "he is not near a speaker" };
  if (input.private && input.othersThere)
    return { action: "card", why: "private, and someone else is there" };
  return { action: "speak", vessel: input.vessel };
};
