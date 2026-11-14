/**
 * Messages and announcements between the people of this home, for every vessel and agent: send, read, play, react,
 * and do-not-disturb. TessayaComms decides who may reach whom; these only carry the request.
 */
import { CommsAddress, CommsForms } from "@t3tools/tessaya-contracts";
import { COMMS_TOOL_TEXT } from "@t3tools/tessaya-shared/commsTools";
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
const NoteId = Schema.String.check(Schema.isMaxLength(64)).annotate({
  description: "The message's id, from comms_inbox.",
});

const SendTool = Tool.make("comms_send", {
  ...shared,
  description: COMMS_TOOL_TEXT.comms_send,
  parameters: Schema.Struct({
    to: Schema.Array(CommsAddress).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
    kind: Schema.Literals(["text", "announce", "voice"]),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
    forms: Schema.optionalKey(CommsForms),
    urgency: Schema.optionalKey(Schema.Literals(["normal", "soon", "urgent"])),
    private: Schema.optionalKey(Schema.Boolean),
    replyTo: Schema.optionalKey(NoteId),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const InboxTool = Tool.make("comms_inbox", {
  ...shared,
  description: COMMS_TOOL_TEXT.comms_inbox,
  parameters: Schema.Struct({ unreadOnly: Schema.optionalKey(Schema.Boolean) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const PlayTool = Tool.make("comms_play", {
  ...shared,
  description: COMMS_TOOL_TEXT.comms_play,
  parameters: Schema.Struct({ id: NoteId }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const ReactTool = Tool.make("comms_react", {
  ...shared,
  description: COMMS_TOOL_TEXT.comms_react,
  parameters: Schema.Struct({
    id: NoteId,
    emoji: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const DndTool = Tool.make("comms_dnd", {
  ...shared,
  description: COMMS_TOOL_TEXT.comms_dnd,
  parameters: Schema.Struct({
    until: Schema.NullOr(
      Schema.String.check(Schema.isMaxLength(40)).annotate({
        description: "When it ends, as an ISO date and time with its offset; null turns it off.",
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const EmergencyTool = Tool.make("comms_emergency", {
  ...shared,
  description: COMMS_TOOL_TEXT.comms_emergency,
  parameters: Schema.Struct({
    kind: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(40)).annotate({
        description: "The emergency's id, as comms_emergency without a kind lists them.",
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const EmergencyOkTool = Tool.make("comms_emergency_ok", {
  ...shared,
  description: COMMS_TOOL_TEXT.comms_emergency_ok,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const FalseAlarmTool = Tool.make("comms_false_alarm", {
  ...shared,
  description: COMMS_TOOL_TEXT.comms_false_alarm,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CommsTools = [
  SendTool,
  InboxTool,
  PlayTool,
  ReactTool,
  DndTool,
  EmergencyTool,
  EmergencyOkTool,
  FalseAlarmTool,
] as const;
