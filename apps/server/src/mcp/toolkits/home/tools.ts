/**
 * The Director's house through Tessaya (Home Assistant), for agents on T3's /mcp and his desktop assistant alike. Every
 * write is risk-checked on the server; a risky one waits for his yes on his phone, and the reply says so.
 */
import { BatonHomeCallResult, HOME_AUTOMATION_KINDS } from "@t3tools/baton-contracts";
import { HOME_TOOL_TEXT } from "@t3tools/baton-shared/homeTools";
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
  success: BatonHomeCallResult,
};
const Text = (max: number, description?: string) =>
  Schema.String.check(Schema.isMaxLength(max)).annotate(
    description === undefined ? {} : { description },
  );
const Obj = Schema.Record(Schema.String, Schema.Unknown);

const FindTool = Tool.make("home_find", {
  ...shared,
  description: HOME_TOOL_TEXT.home_find,
  parameters: Schema.Struct({
    text: Schema.optionalKey(Text(200, "Words in its name, room or device, e.g. 'study fan'.")),
    area: Schema.optionalKey(Text(100, "A room name.")),
    domain: Schema.optionalKey(Text(60)),
    limit: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const StateTool = Tool.make("home_state", {
  ...shared,
  description: HOME_TOOL_TEXT.home_state,
  parameters: Schema.Struct({
    entityId: Text(200),
    since: Schema.optionalKey(Text(40)),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const DoTool = Tool.make("home_do", {
  ...shared,
  description: HOME_TOOL_TEXT.home_do,
  parameters: Schema.Struct({
    domain: Text(60, "e.g. light"),
    service: Text(80, "e.g. turn_off"),
    target: Schema.optionalKey(
      Obj.annotate({ description: "{entity_id | device_id | area_id: id or list}" }),
    ),
    data: Schema.optionalKey(
      Obj.annotate({ description: "The service's own fields, e.g. {brightness_pct: 40}." }),
    ),
    why: Text(500, "His request, in his words."),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const UndoTool = Tool.make("home_undo", {
  ...shared,
  description: HOME_TOOL_TEXT.home_undo,
  parameters: Schema.Struct({ id: Text(120) }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const AutomationsTool = Tool.make("home_automations", {
  ...shared,
  description: HOME_TOOL_TEXT.home_automations,
  parameters: Schema.Struct({ all: Schema.optionalKey(Schema.Boolean) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const AutomationSaveTool = Tool.make("home_automation_save", {
  ...shared,
  description: HOME_TOOL_TEXT.home_automation_save,
  parameters: Schema.Struct({
    id: Schema.optionalKey(Text(120, "Only to replace an existing automation.")),
    alias: Text(120, "A short name he will recognise."),
    kind: Schema.Literals(HOME_AUTOMATION_KINDS),
    runInMinutes: Schema.optionalKey(
      Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60 * 24 })).annotate({
        description: "A one-off delay: run once this many minutes from now.",
      }),
    ),
    expiresInMinutes: Schema.optionalKey(
      Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60 * 24 * 90 })),
    ),
    expiresAt: Schema.optionalKey(Text(40, "ISO time it ends.")),
    once: Schema.optionalKey(Schema.Boolean),
    triggers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    conditions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    actions: Schema.Array(Schema.Unknown),
    request: Text(500, "His request, in his words."),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const AutomationSetTool = Tool.make("home_automation_set", {
  ...shared,
  description: HOME_TOOL_TEXT.home_automation_set,
  parameters: Schema.Struct({ id: Text(120), op: Schema.Literals(["pause", "resume", "delete"]) }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit, so the house rides on its one registration in server.ts. */
export const HomeTools = [
  FindTool,
  StateTool,
  DoTool,
  UndoTool,
  AutomationsTool,
  AutomationSaveTool,
  AutomationSetTool,
] as const;
