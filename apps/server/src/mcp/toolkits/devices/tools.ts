/**
 * Tessaya's hardware devices (the R1 first), for agents on T3's /mcp. Harmless controls run; the camera and a restart
 * go to his phone for a yes, and the reply says so.
 */
import {
  BatonDevicesCallResult,
  DeviceTagAction,
  DeviceWatchInput,
  R1_KEY_SLOTS,
  R1KeyBinding,
  R1_LEDS,
  R1_MOODS,
  type R1KeySlot,
} from "@t3tools/baton-contracts";
import { DEVICE_TOOL_TEXT } from "@t3tools/baton-shared/deviceTools";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { On, PeerOrigin } from "../../../peer/PeerVessels.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DEVICE } from "@t3tools/baton-shared/productNames";

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

/** The act ops a tool may use; forget is refused for outside agents (his own Tessaya forgets one when he asks). */
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
  "forget",
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
    op: Schema.Literals(["camera", "reboot", "away", "update"]),
    enabled: Schema.optional(Schema.Boolean).annotate({
      description: `For away: true lets the ${DEVICE} connect away from home, false keeps it home only.`,
    }),
    version: Schema.optional(Schema.String.check(Schema.isMaxLength(30))).annotate({
      description:
        "For update: a signed release such as smp-0.3.95 from device_list's updates; leave out for the recommended one.",
    }),
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

const ItemId = Schema.String.check(Schema.isMaxLength(80)).annotate({
  description: "An item id from the device's manifest, e.g. power.battery_pct.",
});
const ReadTool = Tool.make("device_read", {
  ...shared,
  description: DEVICE_TOOL_TEXT.device_read,
  parameters: Schema.Struct({
    id: Id,
    items: Schema.optionalKey(Schema.Array(ItemId).check(Schema.isMaxLength(50))),
    on: Schema.optional(On),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const SetTool = Tool.make("device_set", {
  ...shared,
  description: DEVICE_TOOL_TEXT.device_set,
  parameters: Schema.Struct({
    id: Id,
    itemId: ItemId,
    value: Schema.optionalKey(
      Schema.Union([
        Schema.Number,
        Schema.Boolean,
        Schema.String.check(Schema.isMaxLength(200)),
        Schema.Null,
        // A Bluetooth device in his words, by address, or a new one to pair (bt.connect, audio.output).
        Schema.Struct({
          name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
          mac: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(17))),
          pair: Schema.optionalKey(Schema.Boolean),
        }),
      ]),
    ),
    confirmed: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "He said yes to exactly this change, just now." }),
    ),
    on: Schema.optional(On),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ButtonTool = Tool.make("device_button", {
  ...shared,
  description: DEVICE_TOOL_TEXT.device_button,
  parameters: Schema.Struct({
    id: Id,
    slot: Schema.Literals(Object.keys(R1_KEY_SLOTS) as Array<R1KeySlot>),
    bind: R1KeyBinding,
    on: Schema.optional(On),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WatchTool = Tool.make("device_watch", {
  ...shared,
  description: DEVICE_TOOL_TEXT.device_watch,
  parameters: Schema.Struct({
    ...DeviceWatchInput.fields,
    on: Schema.optional(On),
    ...PeerOrigin,
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit, beside the house's tools. */
export const DeviceTools = [
  ListTool,
  ActTool,
  OwnerTool,
  TagTool,
  ReadTool,
  SetTool,
  WatchTool,
  ButtonTool,
] as const;
