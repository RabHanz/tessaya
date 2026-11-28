/**
 * The Margin, his day, lists and reminders: two tools, a read and an add-or-tick, each naming The Margin's own tool, so
 * its ~500 tools never enter a turn. TessayaMargin keeps the lists of what may be called.
 */
import { MARGIN_READS, MARGIN_WRITES } from "@t3tools/tessaya-shared/margin";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
  success: Schema.Unknown,
};
const Args = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "The Margin tool's own arguments, as its description below names them.",
  }),
);

const MarginReadTool = Tool.make("margin_read", {
  ...shared,
  description:
    'Read his day, lists and reminders live from The Margin, the app that holds them ("what\'s on my Margin today", "what\'s on the shopping list", "any reminders?"). `tool` is one of The Margin\'s reads: get_my_week (his days, events and open cards; date_from, date_to as YYYY-MM-DD, timezone), get_week_overview (the week in one short read), get_morning_brief, list_reminders, list_shopping_lists, list_shopping_items (list_id, include_checked), list_chores, list_family_events (date_from, date_to), get_meal_plan (week_of required), search_cards (query required), get_cards (card_ids), list_notifications (unread_only), list_habits, list_workspaces. Say what it answers in a short line or two; never read out long lists unless he asks.',
  parameters: Schema.Struct({ tool: Schema.Literals(MARGIN_READS), args: Args }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const MarginWriteTool = Tool.make("margin_write", {
  ...shared,
  description:
    'Add or tick something in The Margin, which holds his lists and reminders. "Add milk to the shopping list": add_shopping_item with name (and quantity). "Tick off milk", "I got the eggs": check_shopping_item with item_id from margin_read list_shopping_items. "Remind me to call Sam on Friday at 9", "put the dentist on Tuesday", or anything you are unsure where it goes: capture with text as he said it (and timezone). A chore done: complete_chore (chore_id from list_chores). A card or task done: complete_card (card_id from search_cards). A habit done: log_habit_entry (habit_id from list_habits). A reminder on a card he names: set_reminder (card_id, reminder_at). "Remind me out loud in 20 minutes" is tessaya_alarm, not this. It never deletes, shares, pays or sends anything to anyone. `reason` is a few words on why, shown beside the change in The Margin.',
  parameters: Schema.Struct({
    tool: Schema.Literals(MARGIN_WRITES),
    args: Args,
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MarginTools = [MarginReadTool, MarginWriteTool] as const;
