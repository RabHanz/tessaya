/** The job tools' handlers: thin; BatonJobFlow does the work, and its words come back as one line to say. */
import { OrchestratorMcpFailure, ScheduledTaskId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { BatonCloudService } from "../../../baton/BatonCloudService.ts";
import { BatonEngine } from "../../../baton/BatonEngine.ts";
import * as JobFlow from "../../../baton/BatonJobFlow.ts";
import { HomeAssistantService } from "../../../home/HomeAssistantService.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { BatonRuntime, type BatonServices } from "../../../baton/BatonRpcHandlers.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { type JobInput, ROOM_SESSIONS } from "./tools.ts";

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

export const make = Effect.gen(function* () {
  const context = yield* BatonRuntime;
  /** Only the R1's own runner, which judged the voice and held what needs his yes (R1Tools). */
  const roomOnly = Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
    !ROOM_SESSIONS.has(scope.client?.sessionId ?? "")
      ? Effect.fail(refused("Jobs are started by asking Tessaya: use tessaya_ask."))
      : context === null
        ? Effect.fail(refused("Jobs are not available on this server."))
        : Effect.succeed(context),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, BatonServices>) =>
    Effect.flatMap(roomOnly, (services) =>
      Effect.provideContext(effect, services).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                typeof cause === "object" && cause !== null && "message" in cause
                  ? String(cause.message)
                  : "That job request failed. Nothing changed.",
            }),
        ),
      ),
    );
  type Reply = { readonly id: string | null; readonly line: string };
  const noTask: Reply = { id: null, line: "There is no scheduled task by that id." };
  const noJob = { id: null, line: "There is no job by that id." };
  const act = McpToolAccess.writes;

  /** A time on his house's clock ("Fri 14 Nov, 09:00"), never UTC. */
  const houseTime = (iso: string | null) =>
    iso === null
      ? Effect.succeed(null)
      : run(
          Effect.flatMap(HomeAssistantService, (home) => home.timeZone).pipe(
            Effect.map((zone) =>
              new Intl.DateTimeFormat("en-GB", {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: zone === "UTC" ? undefined : zone,
              }).format(DateTime.toDateUtc(DateTime.makeUnsafe(iso))),
            ),
          ),
        );
  const tasks = run(Effect.flatMap(ScheduledTaskService, (scheduler) => scheduler.list()));

  return {
    cloud_dispatch: act((input: JobInput<"cloud_dispatch">) =>
      Effect.map(
        run(
          Effect.flatMap(BatonCloudService, (cloud) =>
            cloud.call(
              {
                op: "dispatch",
                ...(input.provider === undefined ? {} : { provider: input.provider }),
                args: {
                  repo: input.repo,
                  branch: input.branch,
                  brief: input.brief,
                  expectedUsage: input.expected_points,
                  fromWeb: input.from_web_or_file === true,
                  ...(input.label === undefined ? {} : { label: input.label }),
                },
              },
              "act",
            ),
          ),
        ),
        (result) =>
          result.ok
            ? {
                id: null,
                line: "Asked. It waits for his answer on a card in Approvals, where he picks the assistant and account; nothing runs before that.",
              }
            : { id: null, line: result.error ?? "The cloud request was not made." },
      ),
    ),
    project_add: act((input: JobInput<"project_add">) =>
      Effect.map(
        run(
          Effect.flatMap(BatonEngine, (engine) =>
            engine.addProject({
              tag: "voice",
              title: input.title,
              folder: input.folder,
              repository: input.repository,
            }),
          ),
        ),
        (added) =>
          "refused" in added
            ? { id: null, line: `No project was added: ${added.refused}` }
            : { id: added.projectId, line: `Added the project at ${added.folder}.` },
      ),
    ),
    schedules_list: McpToolAccess.reads(() =>
      Effect.flatMap(tasks, (listed) =>
        Effect.forEach(listed.tasks, (task) =>
          Effect.map(houseTime(task.nextRunAt), (next) => ({
            id: task.id,
            title: task.title,
            on: task.enabled,
            next,
            last: task.lastRunStatus,
          })),
        ),
      ),
    ),
    schedule_run_now: act((input: JobInput<"schedule_run_now">) =>
      Effect.gen(function* () {
        if (!(yield* tasks).tasks.some((task) => task.id === input.id)) return noTask;
        const ran = yield* run(
          Effect.flatMap(ScheduledTaskService, (scheduler) =>
            scheduler.runNow({ id: ScheduledTaskId.make(input.id) }),
          ),
        );
        return {
          id: input.id,
          line:
            ran.threadId === null
              ? "It did not start."
              : "Started its run; it does not wait for it to finish.",
        } satisfies Reply;
      }),
    ),
    schedule_delete: act((input: JobInput<"schedule_delete">) =>
      Effect.gen(function* () {
        if (!(yield* tasks).tasks.some((task) => task.id === input.id)) return noTask;
        yield* run(
          Effect.flatMap(ScheduledTaskService, (scheduler) =>
            scheduler.delete({ id: ScheduledTaskId.make(input.id) }),
          ),
        );
        return { id: input.id, line: "Deleted; it will not run again." } satisfies Reply;
      }),
    ),
    job_start: act((input: JobInput<"job_start">) =>
      Effect.gen(function* () {
        const origin = yield* TurnOrigin;
        const started = yield* run(
          JobFlow.placeJob({
            project: input.project,
            title: input.title,
            goal: input.goal,
            folders: input.folders ?? [],
            tools: input.tools ?? [],
            ...(input.worker === undefined ? {} : { worker: input.worker }),
            ...(input.report_every_minutes === undefined
              ? {}
              : { reportEveryMinutes: input.report_every_minutes }),
            // Its plan-ready and done lines are said on the R1 he asked; a replay's never are.
            ...(origin?.kind === "device" && origin.rehearsal !== true
              ? { origin: origin.id }
              : {}),
          }),
        );
        return {
          id: started.terms.workSessionId,
          line: `Opened ${input.title} in ${input.project} on ${started.model}. It writes its plan first in its own thread and does nothing until he agrees; say you will tell him when the plan is ready.`,
        };
      }),
    ),
    job_retry: act((input: JobInput<"job_retry">) =>
      Effect.map(run(JobFlow.retryJob(input.id)), (line) => ({ id: input.id, line })),
    ),
    job_refine: act((input: JobInput<"job_refine">) =>
      Effect.map(
        run(
          JobFlow.refineJob({
            id: input.id,
            text: input.text,
            via: "voice",
            ...(input.widens === true ? { widens: true } : {}),
          }),
        ),
        (terms) =>
          terms === null
            ? noJob
            : { id: input.id, line: "Passed on; the worker is making its plan again." },
      ),
    ),
    job_agree: act((input: JobInput<"job_agree">) =>
      Effect.map(run(JobFlow.agreeJob(input.id)), (terms) =>
        terms === null
          ? noJob
          : {
              id: input.id,
              line:
                terms.phase === "approved"
                  ? "Agreed; the worker has started."
                  : "Its plan is not written yet; nothing started.",
            },
      ),
    ),
    job_split: act((input: JobInput<"job_split">) =>
      Effect.map(
        run(
          JobFlow.splitJob({
            id: input.id,
            parts: input.parts.map((p) => ({
              title: p.title,
              goal: p.goal,
              ...(p.role === undefined ? {} : { role: p.role }),
              ...(p.routine === true ? { routine: true } : {}),
              ...(p.after === undefined ? {} : { after: p.after }),
            })),
          }),
        ),
        (started) => ({
          id: input.id,
          line:
            started.length === 0
              ? "Nothing was split: the job is not agreed yet, or it has no thread."
              : `Started ${started.length} workers, one per part; one summary goes to the job's thread when they are all in.`,
        }),
      ),
    ),
    job_stop: act((input: JobInput<"job_stop">) =>
      Effect.map(run(JobFlow.stopJob(input.id)), (stopped) => ({
        id: input.id,
        line: stopped ? "Stopped. Its thread and plan stay." : "Nothing was running to stop.",
      })),
    ),
    job_schedule: act((input: JobInput<"job_schedule">) =>
      Effect.map(
        run(
          JobFlow.scheduleJob({
            id: input.id,
            everyMinutes: input.every_minutes === 0 ? null : input.every_minutes,
          }),
        ),
        (terms) =>
          terms === null
            ? noJob
            : input.every_minutes === 0
              ? { id: input.id, line: "The schedule is off." }
              : terms.scheduleTaskId === null
                ? { id: input.id, line: "Only a job whose plan he agreed runs on a schedule." }
                : { id: input.id, line: `It runs again every ${input.every_minutes} minutes.` },
      ),
    ),
  };
});
