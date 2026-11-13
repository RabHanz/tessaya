/** The job tools' handlers: thin; BatonJobFlow does the work, and its words come back as one line to say. */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as JobFlow from "../../../baton/BatonJobFlow.ts";
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
  const noJob = { id: null, line: "There is no job by that id." };
  const act = McpToolAccess.writes;

  return {
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
