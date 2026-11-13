/**
 * His jobs by voice in the room: the desktop assistant's job tools (their words in JOB_TOOL_TEXT), on the server's own
 * job flow (BatonJobFlow), so a job asked on the R1 opens the same plan-first thread. Only the R1's own Tessaya lists
 * or calls them; an outside agent asks for a job with tessaya_ask.
 */
import { BatonJobTool, WorkSessionId } from "@t3tools/baton-contracts";
import { JOB_TOOL_TEXT } from "@t3tools/baton-shared/jobTools";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { McpSchema, Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** The R1's own callers (home/handlers.ts ROOM_CLIENT and its replay). */
export const ROOM_SESSIONS: ReadonlySet<string> = new Set(["r1-room", "r1-replay"]);

/** Listed only to the room's own runner. */
const roomOnly = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return ROOM_SESSIONS.has(scope?.client?.sessionId ?? "");
};

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
  success: Schema.Struct({ id: Schema.NullOr(Schema.String), line: Schema.String }),
};
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Id = WorkSessionId.annotate({ description: "The job's id, from tessaya_jobs." });

const acts = <T extends Tool.Any>(tool: T) =>
  tool
    .annotate(McpSchema.EnabledWhen, roomOnly)
    .annotate(Tool.Readonly, false)
    .annotate(Tool.OpenWorld, false);

const StartTool = acts(
  Tool.make("job_start", {
    ...shared,
    description: JOB_TOOL_TEXT.job_start,
    parameters: Schema.Struct({
      title: Text(120),
      goal: Text(4000),
      project: Text(200),
      worker: Schema.optionalKey(Text(60)),
      folders: Schema.optionalKey(Schema.Array(Text(300)).check(Schema.isMaxLength(10))),
      tools: Schema.optionalKey(Schema.Array(BatonJobTool).check(Schema.isMaxLength(5))),
      report_every_minutes: Schema.optionalKey(
        Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
      ),
    }),
  }),
).annotate(Tool.Destructive, false);
const RetryTool = acts(
  Tool.make("job_retry", {
    ...shared,
    description: JOB_TOOL_TEXT.job_retry,
    parameters: Schema.Struct({ id: Id, reason: Text(400) }),
  }),
).annotate(Tool.Destructive, false);
const RefineTool = acts(
  Tool.make("job_refine", {
    ...shared,
    description: JOB_TOOL_TEXT.job_refine,
    parameters: Schema.Struct({
      id: Id,
      text: Text(4000),
      widens: Schema.optionalKey(Schema.Boolean),
    }),
  }),
).annotate(Tool.Destructive, false);
const AgreeTool = acts(
  Tool.make("job_agree", {
    ...shared,
    description: JOB_TOOL_TEXT.job_agree,
    parameters: Schema.Struct({ id: Id }),
  }),
).annotate(Tool.Destructive, false);
const SplitTool = acts(
  Tool.make("job_split", {
    ...shared,
    description: JOB_TOOL_TEXT.job_split,
    parameters: Schema.Struct({
      id: Id,
      parts: Schema.Array(
        Schema.Struct({
          title: Text(120),
          goal: Text(4000),
          role: Schema.optionalKey(Text(40)),
          routine: Schema.optionalKey(Schema.Boolean),
          after: Schema.optionalKey(Schema.Array(Schema.Int).check(Schema.isMaxLength(7))),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    }),
  }),
).annotate(Tool.Destructive, false);
const StopTool = acts(
  Tool.make("job_stop", {
    ...shared,
    description: JOB_TOOL_TEXT.job_stop,
    parameters: Schema.Struct({ id: Id }),
  }),
).annotate(Tool.Destructive, true);
const ScheduleTool = acts(
  Tool.make("job_schedule", {
    ...shared,
    description: JOB_TOOL_TEXT.job_schedule,
    parameters: Schema.Struct({
      id: Id,
      every_minutes: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 10080 })),
    }),
  }),
).annotate(Tool.Destructive, true);

export const JobTools = [
  StartTool,
  RetryTool,
  RefineTool,
  AgreeTool,
  SplitTool,
  StopTool,
  ScheduleTool,
] as const;
