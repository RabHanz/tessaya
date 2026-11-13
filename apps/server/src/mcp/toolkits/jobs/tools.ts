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

const StartTool = Tool.make("job_start", {
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
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const RetryTool = Tool.make("job_retry", {
  ...shared,
  description: JOB_TOOL_TEXT.job_retry,
  parameters: Schema.Struct({ id: Id, reason: Text(400) }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const RefineTool = Tool.make("job_refine", {
  ...shared,
  description: JOB_TOOL_TEXT.job_refine,
  parameters: Schema.Struct({
    id: Id,
    text: Text(4000),
    widens: Schema.optionalKey(Schema.Boolean),
  }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const AgreeTool = Tool.make("job_agree", {
  ...shared,
  description: JOB_TOOL_TEXT.job_agree,
  parameters: Schema.Struct({ id: Id }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const SplitTool = Tool.make("job_split", {
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
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const StopTool = Tool.make("job_stop", {
  ...shared,
  description: JOB_TOOL_TEXT.job_stop,
  parameters: Schema.Struct({ id: Id }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);
const ScheduleTool = Tool.make("job_schedule", {
  ...shared,
  description: JOB_TOOL_TEXT.job_schedule,
  parameters: Schema.Struct({
    id: Id,
    every_minutes: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 10080 })),
  }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const CloudDispatchTool = Tool.make("cloud_dispatch", {
  ...shared,
  description: JOB_TOOL_TEXT.cloud_dispatch,
  parameters: Schema.Struct({
    repo: Text(120),
    branch: Text(120),
    brief: Text(4000),
    expected_points: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    provider: Schema.optionalKey(Text(20)),
    label: Schema.optionalKey(Text(60)),
    from_web_or_file: Schema.optionalKey(Schema.Boolean),
  }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const ProjectAddTool = Tool.make("project_add", {
  ...shared,
  description: JOB_TOOL_TEXT.project_add,
  parameters: Schema.Struct({
    title: Schema.optionalKey(Text(120)),
    folder: Schema.optionalKey(Text(400)),
    repository: Schema.optionalKey(Text(400)),
  }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const TaskId = Text(200).annotate({ description: "The task's id, from schedules_list." });
const SchedulesListTool = Tool.make("schedules_list", {
  ...shared,
  description: JOB_TOOL_TEXT.schedules_list,
  success: Schema.Unknown,
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const ScheduleRunNowTool = Tool.make("schedule_run_now", {
  ...shared,
  description: JOB_TOOL_TEXT.schedule_run_now,
  parameters: Schema.Struct({ id: TaskId }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const ScheduleDeleteTool = Tool.make("schedule_delete", {
  ...shared,
  description: JOB_TOOL_TEXT.schedule_delete,
  parameters: Schema.Struct({ id: TaskId }),
})
  .annotate(McpSchema.EnabledWhen, roomOnly)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

export const JobTools = [
  CloudDispatchTool,
  ProjectAddTool,
  SchedulesListTool,
  ScheduleRunNowTool,
  ScheduleDeleteTool,
  StartTool,
  RetryTool,
  RefineTool,
  AgreeTool,
  SplitTool,
  StopTool,
  ScheduleTool,
] as const;

/** What one job tool takes, by its name. */
export type JobInput<N extends (typeof JobTools)[number]["name"]> = Tool.Parameters<
  Extract<(typeof JobTools)[number], { readonly name: N }>
>;
