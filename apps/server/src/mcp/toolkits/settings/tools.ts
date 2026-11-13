/**
 * Every Tessaya setting by voice, for every vessel: find one by his words, read it, explain it, change it. Free ones
 * change at once with a way back; confirm and owner ones wait for his yes on his phone; never ones are refused.
 */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { On, PeerOrigin } from "../../../peer/PeerVessels.ts";
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
const Key = Schema.String.check(Schema.isMaxLength(80)).annotate({
  description: "The setting's key, from settings_find.",
});

const FindTool = Tool.make("settings_find", {
  ...shared,
  description:
    "Find Tessaya's settings by his words ('make the pill quieter', 'the speech model', 'background activity'): the closest few, each with its key, what it does, where it lives and its safety class, on this server and his other linked ones (those carry `on`, the machine to pass back). Use it before settings_get, settings_explain or settings_set.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMaxLength(200)).annotate({ description: "His words." }),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GetTool = Tool.make("settings_get", {
  ...shared,
  description: "A setting's value now, by its key. A secret is never read.",
  parameters: Schema.Struct({ key: Key, on: Schema.optional(On), ...PeerOrigin }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ExplainTool = Tool.make("settings_explain", {
  ...shared,
  description:
    "What a setting does, its value now, the values it takes when it is a choice, and whether changing it needs his yes.",
  parameters: Schema.Struct({ key: Key, on: Schema.optional(On), ...PeerOrigin }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SetTool = Tool.make("settings_set", {
  ...shared,
  description:
    "Change one setting to a value it takes. Free settings change at once: say in plain words what changed and that he can say 'change it back' (set it to the old value given). Confirm and owner settings come back `asked`: sent to his phone for a yes, so say it waits for him and never that it changed. Never settings are refused with the reason.",
  parameters: Schema.Struct({
    key: Key,
    value: Schema.Unknown.annotate({
      description: "The new value: a word from its choices, a number, true or false.",
    }),
    why: Schema.String.check(Schema.isMaxLength(300)).annotate({
      description: "His request, in his words.",
    }),
    on: Schema.optional(On),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit, so every vessel gets them through its one registration. */
export const SettingsTools = [FindTool, GetTool, ExplainTool, SetTool] as const;
