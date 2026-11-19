/** The job tools' handlers: thin; BatonJobFlow does the work, and its words come back as one line to say. */
import { houseZone } from "../../../tessaya/houseZone.ts";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { GuestShareService } from "../../../guest/GuestShareService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { PeerLinkRequests } from "../../../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../../../peer/PeerLinks.ts";
import { DatabaseStorage } from "../../../persistence/DatabaseStorage.ts";
import { ProviderAuthService } from "../../../provider/ProviderAuthService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { StorageCleanup } from "../../../storageCleanup.ts";

import { TessayaCloudService } from "../../../tessaya/TessayaCloudService.ts";
import { TessayaComms } from "../../../tessaya/TessayaComms.ts";
import { TessayaEngine } from "../../../tessaya/TessayaEngine.ts";
import { HouseholdCaller } from "../../../tessaya/TessayaHousehold.ts";
import { TessayaMemorySync } from "../../../tessaya/TessayaMemorySync.ts";
import * as JobFlow from "../../../tessaya/TessayaJobFlow.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { TessayaRuntime, type TessayaServices } from "../../../tessaya/TessayaRpcHandlers.ts";
import { conversationKey, TurnOrigin } from "../../../tessaya/TessayaTurn.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { commsCaller } from "../comms/handlers.ts";
import { type JobInput, ROOM_SESSIONS } from "./tools.ts";

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

const isProviderInstanceId = Schema.is(ProviderInstanceId);

export const make = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  // The server's own services, as its Settings reach them; absent on a server built without them.
  const storageCleanup = yield* Effect.serviceOption(StorageCleanup);
  const databaseStorage = yield* Effect.serviceOption(DatabaseStorage);
  const providerAuth = yield* Effect.serviceOption(ProviderAuthService);
  const guestShares = yield* Effect.serviceOption(GuestShareService);
  const peerLinks = yield* Effect.serviceOption(PeerLinks);
  const peerLinkRequests = yield* Effect.serviceOption(PeerLinkRequests);
  /** Only a vessel's own runner (R1Tools), which judged the turn and held what needs his yes; the desk's gate asks first. */
  const roomOnly = Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
    !ROOM_SESSIONS.has(scope.client?.sessionId ?? "")
      ? Effect.fail(refused("Jobs are started by asking Tessaya: use tessaya_ask."))
      : context === null
        ? Effect.fail(refused("Jobs are not available on this server."))
        : Effect.succeed(context),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, TessayaServices>) =>
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
  const unavailable = (what: string): Reply => ({
    id: null,
    line: `${what} is not available on this server.`,
  });
  const act = McpToolAccess.writes;

  /** A time on his house's clock ("Fri 14 Nov, 09:00"), never UTC. */
  const houseTime = (iso: string | null) =>
    iso === null
      ? Effect.succeed(null)
      : run(
          houseZone().pipe(
            Effect.map((zone) =>
              new Intl.DateTimeFormat("en-GB", {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: zone,
              }).format(DateTime.toDateUtc(DateTime.makeUnsafe(iso))),
            ),
          ),
        );
  const tasks = run(Effect.flatMap(ScheduledTaskService, (scheduler) => scheduler.list()));

  return {
    cloud_dispatch: act((input: JobInput<"cloud_dispatch">) =>
      Effect.map(
        run(
          Effect.flatMap(TessayaCloudService, (cloud) =>
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
          Effect.flatMap(TessayaEngine, (engine) =>
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
    schedule_pause: act((input: JobInput<"schedule_pause">) =>
      Effect.gen(function* () {
        if (!(yield* tasks).tasks.some((task) => task.id === input.id)) return noTask;
        yield* run(
          Effect.flatMap(ScheduledTaskService, (scheduler) =>
            scheduler.setEnabled({ id: ScheduledTaskId.make(input.id), enabled: input.on }),
          ),
        );
        return {
          id: input.id,
          line: input.on
            ? "Resumed; it runs on its schedule again."
            : "Paused; say resume it to start it again.",
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
    environment_maintain: act((input: JobInput<"environment_maintain">) =>
      Effect.gen(function* () {
        const instance = input.provider?.trim() ?? "";
        const needsProvider = {
          id: null,
          line: "Name the assistant (provider, from providers).",
        } satisfies Reply;
        if (input.op === "providers" || input.op === "refresh_providers") {
          const providers = yield* run(
            Effect.flatMap(ProviderRegistry.ProviderRegistry, (registry) =>
              input.op === "refresh_providers" ? registry.refresh() : registry.getProviders,
            ),
          );
          const lines = providers.map(
            (p) =>
              `${p.displayName ?? p.driver} (${p.instanceId}): ${p.enabled ? p.status : "off"}, sign-in ${p.auth.status}${p.auth.email === undefined ? "" : ` as ${p.auth.email}`}`,
          );
          return {
            id: null,
            line: `${input.op === "refresh_providers" ? "Checked them all again. " : ""}${lines.join("; ") || "No assistants are set up here."}`,
          } satisfies Reply;
        }
        if (input.op === "sign_in_methods" || input.op === "sign_out") {
          if (!isProviderInstanceId(instance)) return needsProvider;
          if (Option.isNone(providerAuth)) return unavailable("Signing assistants in and out");
          const auth = providerAuth.value;
          const instanceId = instance;
          if (input.op === "sign_in_methods") {
            const state = yield* run(
              Stream.runHead(auth.subscribe({ instanceId }, "tessaya-voice").pipe(Stream.take(1))),
            );
            const methods = Option.isSome(state) ? (state.value.methods ?? []) : [];
            return {
              id: instance,
              line:
                methods.length === 0
                  ? "It has no stored sign-in methods to name."
                  : methods
                      .map(
                        (m) =>
                          `${m.name} (${m.id})${m.accountEmail === undefined ? "" : ` as ${m.accountEmail}`}${m.canRemove === false ? ", cannot be removed" : ""}`,
                      )
                      .join("; "),
            } satisfies Reply;
          }
          const method = input.method?.trim() ?? "";
          yield* run(
            method === ""
              ? auth.logout({ instanceId })
              : auth.removeMethod({ instanceId, methodId: method }),
          );
          return {
            id: instance,
            line: `Signed ${instance} out${method === "" ? "" : ` of ${method}`}. Signing in again is done in Settings on this computer, not by voice.`,
          } satisfies Reply;
        }
        if (input.op === "clean_storage") {
          if (Option.isNone(storageCleanup)) return unavailable("Storage clean-up");
          const report = yield* run(storageCleanup.value.runNow);
          const freed = Math.round(report.bytesFreed / 1024 ** 2);
          return {
            id: null,
            line: `Cleaned up: ${report.counts.removed} removed, ${report.counts.kept} kept, ${report.counts.failed} failed, ${freed} MB freed. What it removed is gone; his clean-up rules are in Settings.`,
          } satisfies Reply;
        }
        if (Option.isNone(databaseStorage)) return unavailable("Reclaiming database space");
        yield* run(databaseStorage.value.requestReclaim);
        return {
          id: null,
          line: "The server is restarting to give the database's free space back to the disk; it is back in a minute or two and nothing is lost.",
        } satisfies Reply;
      }),
    ),
    access_manage: act((input: JobInput<"access_manage">) =>
      Effect.gen(function* () {
        const environment = input.environment_id?.trim() ?? "";
        const thread = input.thread_id?.trim() ?? "";
        if (input.op === "share_thread") {
          if (thread === "")
            return { id: null, line: "Name the thread (thread_id)." } satisfies Reply;
          if (Option.isNone(guestShares)) return unavailable("Guest links");
          const made = yield* run(guestShares.value.create({ threadId: ThreadId.make(thread) }));
          return {
            id: made.share.id,
            // Anyone with the link gets in: said only when he asks for it.
            line: `Made a guest link for that thread: ${made.url} . One person can watch it and suggest messages for 24 hours; it cannot be ended early, only left to run out. Do not read the link aloud unless he asks.`,
          } satisfies Reply;
        }
        if (input.op === "answer_link_request") {
          if (thread === "")
            return { id: null, line: "Name the thread (thread_id)." } satisfies Reply;
          if (Option.isNone(peerLinkRequests)) return unavailable("Link requests");
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const records = yield* run(
            threads.getThreadRecords(ThreadId.make(thread), ["turnItems"], {
              turnItemTypes: ["link_request"],
              messageRoles: [],
            }),
          );
          const card = records.turnItems.findLast(
            (item) => item.type === "link_request" && item.linkStatus === "pending",
          );
          if (card === undefined)
            return { id: null, line: "That thread has no link request waiting." } satisfies Reply;
          const answer =
            input.answer === "use_existing"
              ? environment === ""
                ? null
                : ({
                    type: "use-existing",
                    environmentId: EnvironmentId.make(environment),
                  } as const)
              : input.answer === "link"
                ? input.url === undefined || input.pairing_code === undefined
                  ? null
                  : ({
                      type: "link",
                      urls: [input.url],
                      pairingCode: input.pairing_code,
                      access: input.access ?? "approval-required",
                    } as const)
                : ({ type: "decline" } as const);
          if (answer === null)
            return {
              id: null,
              line: "use_existing needs environment_id; link needs url and pairing_code.",
            } satisfies Reply;
          yield* run(
            peerLinkRequests.value.answer({
              threadId: ThreadId.make(thread),
              turnItemId: card.id,
              answer,
            }),
          );
          return {
            id: card.id,
            line:
              answer.type === "decline"
                ? "Declined; the agent is told no."
                : "Answered; the agent is told, and the link shows in links. To undo, unlink it.",
          } satisfies Reply;
        }
        if (Option.isNone(peerLinks)) return unavailable("Linked environments");
        const links = peerLinks.value;
        if (input.op === "links") {
          const listed = yield* run(links.list);
          return {
            id: null,
            line:
              listed
                .map((l) => `${l.label} (${l.environmentId}): ${l.access}, ${l.status}`)
                .join("; ") || "No other environments are linked.",
          } satisfies Reply;
        }
        if (input.op === "unlink") {
          if (environment === "")
            return {
              id: null,
              line: "Name the environment (environment_id, from links).",
            } satisfies Reply;
          const removed = yield* run(links.unlink(EnvironmentId.make(environment)));
          return {
            id: environment,
            line: removed
              ? "Unlinked. Linking it again needs a fresh pairing code from that machine."
              : "It was not linked.",
          } satisfies Reply;
        }
        if (input.url === undefined || input.pairing_code === undefined)
          return { id: null, line: "Linking needs url and pairing_code." } satisfies Reply;
        const linked = yield* run(
          links.link({
            url: input.url,
            pairingCode: input.pairing_code,
            access: input.access ?? "approval-required",
          }),
        );
        return {
          id: linked.environmentId,
          line: `Linked ${linked.label} with ${linked.access} access. To undo, unlink it.`,
        } satisfies Reply;
      }),
    ),
    intercom_switch: act((input: JobInput<"intercom_switch">) =>
      Effect.gen(function* () {
        const caller = yield* commsCaller;
        const result = yield* run(
          Effect.flatMap(TessayaComms, (comms) =>
            comms.call(
              input.on === undefined ? { op: "settings" } : { op: "settings", enabled: input.on },
            ),
          ).pipe(Effect.provideService(HouseholdCaller, caller)),
        );
        if (result.status === "refused") return { id: null, line: result.line } satisfies Reply;
        const on = result.settings?.enabled === true;
        return {
          id: null,
          line: on
            ? `The intercom is on: messages and announcements reach the people and devices in this home.${input.on === true ? " To stop it, turn the intercom off." : ""}`
            : `The intercom is off: no messages or announcements go between devices here.${input.on === false ? " Turning it on again asks his phone first." : ""}`,
        } satisfies Reply;
      }),
    ),
    memory_sync_switch: act((input: JobInput<"memory_sync_switch">) =>
      run(
        Effect.gen(function* () {
          const sync = yield* TessayaMemorySync;
          if (input.on !== undefined) yield* sync.setEnabled(input.on);
          const state = yield* sync.state;
          const servers = state.peers.map((p) => p.label).join(", ");
          return {
            id: null,
            line: !state.enabled
              ? `Memory sync is off: his memory stays on this server only.${input.on === false ? " Turning it on again asks his phone first." : ""}`
              : state.peers.length === 0
                ? "Memory sync is on, but no other server is linked yet; link one in Settings, Memory."
                : `Memory sync is on with ${servers}.${input.on === true ? " To stop it, say stop syncing my memory." : ""}`,
          } satisfies Reply;
        }),
      ),
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
            ...(input.persona === undefined ? {} : { persona: input.persona }),
            ...(input.template === undefined ? {} : { template: input.template }),
            ...(input.report_every_minutes === undefined
              ? {}
              : { reportEveryMinutes: input.report_every_minutes }),
            // Its plan-ready and done lines are said on the R1 he asked; a replay's never are.
            ...(origin?.kind === "device" && origin.rehearsal !== true
              ? { origin: origin.id }
              : {}),
          }),
        );
        // the conversation she started it from is doing it now, on her board
        if (origin !== null && origin.rehearsal !== true)
          yield* run(
            JobFlow.leadOnThread(
              started.terms.workSessionId,
              input.title,
              `${origin.persona ?? ""}|${conversationKey({ vessel: origin, text: "", speaker: origin.speaker, member: origin.member })}`,
            ),
          );
        const opened = `Opened ${input.title} in ${input.project} on ${started.model}, led by ${started.lead}${started.template === null ? "" : ` (template ${started.template})`}.`;
        if (started.pausedUntil !== undefined) {
          const until = yield* houseTime(started.pausedUntil);
          return {
            id: started.terms.workSessionId,
            line: `${opened} Its login is nearly out of usage and no other has room, so it is paused and starts by itself ${until === null ? "once there is room" : `when the limit resets at ${until}`}; tell him that plainly. Talking keeps working meanwhile.`,
          };
        }
        return {
          id: started.terms.workSessionId,
          line: `${opened} It writes its plan first in its own thread and does nothing until he agrees; say you will tell him when the plan is ready.`,
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
