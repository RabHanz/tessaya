/**
 * Tessaya's hardware devices (the R1 first), for agents on T3's /mcp. Harmless controls run; the camera and a restart
 * go to his phone for a yes, and the reply says so.
 */
import {
  BatonDevicesCallResult,
  DeviceTagAction,
  R1_LEDS,
  R1_MOODS,
} from "@t3tools/baton-contracts";
import { DEVICE_TOOL_TEXT } from "@t3tools/baton-shared/deviceTools";
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
  success: BatonDevicesCallResult,
};
const Id = Schema.String.check(Schema.isMaxLength(60)).annotate({
  description: "The device id from device_list, e.g. r1-3d57b3.",
});

/** The act ops an agent may use; forgetting a device is his, in Settings → Hardware. */
const AGENT_ACT_OPS = [
  "eye",
  "led",
  "vibrate",
  "say",
  "mute",
  "transport",
  "transportConfirm",
  "transportRevert",
  "enrol",
  "diag",
] as const;

const ListTool = Tool.make("device_list", {
  ...shared,
  description: `${DEVICE_TOOL_TEXT.device_list} Devices on his other linked servers carry \`on\`: pass it back to drive one.`,
  parameters: Schema.Struct({ ...PeerOrigin }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const ActTool = Tool.make("device_act", {
  ...shared,
  description: DEVICE_TOOL_TEXT.device_act,
  parameters: Schema.Struct({
    id: Id,
    op: Schema.Literals(AGENT_ACT_OPS),
    mood: Schema.optionalKey(Schema.Literals(R1_MOODS)),
    color: Schema.optionalKey(Schema.Literals(R1_LEDS)),
    ms: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 10, maximum: 1500 }))),
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
    muted: Schema.optionalKey(Schema.Boolean),
    transport: Schema.optionalKey(Schema.Literals(["inhouse", "agora"])),
    cancel: Schema.optionalKey(Schema.Boolean),
    on: Schema.optional(On),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const OwnerTool = Tool.make("device_owner", {
  ...shared,
  description: DEVICE_TOOL_TEXT.device_owner,
  parameters: Schema.Struct({
    id: Id,
    op: Schema.Literals(["camera", "reboot"]),
    on: Schema.optional(On),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const TagTool = Tool.make("device_tag", {
  ...shared,
  description: DEVICE_TOOL_TEXT.device_tag,
  parameters: Schema.Struct({
    op: Schema.Literals(["assign", "remove"]),
    uid: Schema.String.check(Schema.isMaxLength(40)),
    label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
    action: Schema.optionalKey(DeviceTagAction),
    on: Schema.optional(On),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit, beside the house's tools. */
export const DeviceTools = [ListTool, ActTool, OwnerTool, TagTool] as const;
