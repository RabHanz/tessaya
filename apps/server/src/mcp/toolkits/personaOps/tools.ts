/**
 * Acting in the ops system as the turn's persona (its own worker there): the phones' warm-ups, a post that waits for his
 * yes in the ops system, and passing on his decision in his own voice. The ops system decides who may do what on which account.
 */
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
const Serial = Schema.String.check(Schema.isMaxLength(64)).annotate({
  description: "The phone's adb serial, as ops_warmups lists it.",
});
const Platform = Schema.Literals(["tiktok", "instagram", "web"]);
const Handle = Schema.String.check(Schema.isMaxLength(30)).annotate({
  description: "The account's handle, without the @.",
});

const WarmupsTool = Tool.make("ops_warmups", {
  ...shared,
  description:
    "The phones' warm-up schedules in the ops system: each account, its platform and phone, whether it is on, and the days a session ran. Read it before changing one, and for the phone serial the others need.",
  parameters: Schema.Struct({
    deviceSerial: Schema.optionalKey(Serial),
    platform: Schema.optionalKey(Platform),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const WarmupSetTool = Tool.make("ops_warmup_set", {
  ...shared,
  description:
    "Set or pause one account's daily watch-only warm-up on one phone in the ops system: what it searches, minutes a day, and days before its first post. It only watches, never likes or comments. the ops system refuses an account this persona was not given.",
  parameters: Schema.Struct({
    deviceSerial: Serial,
    platform: Platform,
    account: Handle,
    nicheTerms: Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(12),
    ),
    minutesPerDay: Schema.Number,
    daysBeforeFirstPost: Schema.Number,
    site: Schema.optionalKey(
      Schema.String.annotate({ description: "For platform web only: the https page it opens." }),
    ),
    enabled: Schema.Boolean.annotate({ description: "false pauses it." }),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const WarmupRunTool = Tool.make("ops_warmup_run", {
  ...shared,
  description:
    "Ask the ops system for a warm-up session now on one phone and platform; it runs on the next pass, one per phone at a time and one a day per account.",
  parameters: Schema.Struct({ deviceSerial: Serial, platform: Platform }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PostTool = Tool.make("ops_post", {
  ...shared,
  description:
    "Ask the ops system to post through a phone on one of his accounts (TikTok today). Nothing posts without his yes: it files an approval, which waits in his inbox and in the ops system. Say it is waiting for him, never that it is posted.",
  parameters: Schema.Struct({
    deviceSerial: Serial,
    platform: Schema.Literal("tiktok"),
    account: Handle,
    mediaRef: Schema.String.check(Schema.isMaxLength(500)).annotate({
      description: "Where the media is, as a path on the box that holds the phone.",
    }),
    caption: Schema.String.check(Schema.isMaxLength(2200)),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const DecideTool = Tool.make("ops_decide", {
  ...shared,
  description:
    'His decision on an ops system approval (a post waiting for his yes), when he says it in his own voice ("approve that post"). Only his own verified voice is passed on; otherwise it tells him where to decide it. The approval id is on the card and in what ops_post answered.',
  parameters: Schema.Struct({
    approvalId: Schema.String.check(Schema.isMaxLength(64)),
    decision: Schema.Literals(["approve", "reject"]),
    reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AccessTool = Tool.make("ops_access", {
  ...shared,
  description:
    "Which personas may act in the ops system and the accounts the ops system shows each (list), or take a persona's access away (revoke: its token leaves the brain). Only he revokes.",
  parameters: Schema.Struct({
    op: Schema.Literals(["list", "revoke"]),
    persona: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PersonaOpsTools = [
  WarmupsTool,
  WarmupSetTool,
  WarmupRunTool,
  PostTool,
  DecideTool,
  AccessTool,
] as const;
