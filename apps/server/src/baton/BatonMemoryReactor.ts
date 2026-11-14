// @effect-diagnostics nodeBuiltinImport:off
/**
 * Memory's two background jobs (D150): learn from a job when its worker reports, and run the daily
 * consolidation. Nothing here blocks or fails a thread; errors are logged and dropped.
 */
import * as NodeCrypto from "node:crypto";

import type { ThreadId, WorkSession } from "@t3tools/tessaya-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { BatonJobService } from "./BatonJobService.ts";
import { dailyEpisode } from "./BatonMemoryEpisode.ts";
import { pullIfEnabled } from "./BatonMemoryPull.ts";
import { BatonMemoryLearning } from "./BatonMemoryLearning.ts";
import { BatonMemoryService } from "./BatonMemoryService.ts";
import { BatonMemorySync } from "./BatonMemorySync.ts";
import { BatonOneShot } from "./BatonOneShot.ts";
import { checkJobReport, learnFromJobReply } from "./BatonPlaybook.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

export class BatonMemoryReactor extends Context.Service<
  BatonMemoryReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/baton/BatonMemoryReactor") {}

/** The project's title, which memory scopes by (as a turn's project is), or null when it is not known. */
const projectTitle = Effect.fn("BatonMemoryReactor.projectTitle")(function* (projectId: string) {
  const projects = yield* (yield* BatonEngine).projects;
  return projects.find((p) => p.id === projectId)?.title ?? null;
});

/**
 * A job worker's thread finished a turn after the go-ahead: its last message is the report. The
 * planning turn is not a report, so a thread with a single user message is skipped.
 */
export const learnFromJobThread = Effect.fn("BatonMemoryReactor.learnFromJobThread")(function* (
  threadId: ThreadId,
) {
  const id = yield* (yield* WorkSessionService).findForThread(threadId);
  if (id === null) return;
  const terms = yield* (yield* BatonJobService).terms(id);
  if (terms === null || terms.phase !== "approved") return;
  const engine = yield* BatonEngine;
  const shell = yield* engine.threadShell(threadId);
  if (shell?.status !== "completed") return;
  const messages = yield* engine.recentMessages(threadId, 3);
  const last = messages.at(-1);
  if (last?.role !== "assistant" || messages.filter((m) => m.role === "user").length < 2) return;
  const memory = yield* BatonMemoryService;
  const digest = NodeCrypto.createHash("sha1").update(last.text).digest("hex");
  if (!(yield* memory.noteOnce(`job:${threadId}`, digest))) return;
  const learning = yield* BatonMemoryLearning;
  yield* learning.learn({
    origin: "job",
    said: terms.goal,
    reply: last.text,
    sourceRef: id,
    tainted: false,
    project: null,
  });
  const session = yield* (yield* WorkSessionService).get(id).pipe(Effect.orElseSucceed(() => null));
  yield* learning.episode({
    origin: "job",
    title: `the job "${terms.goal.slice(0, 60)}"`,
    transcript: `Goal: ${terms.goal}\n\nReport: ${last.text}`,
    sourceRef: `job:${id}:${digest.slice(0, 12)}`,
    project: session === null ? null : yield* projectTitle(session.projectId),
    tainted: false,
  });
});

/**
 * A work session left "active" (settled or archived): one episode from its goal, where it got to and its last
 * exchange. A job's session is left to the job's own episode.
 */
export const episodeFromSession = Effect.fn("BatonMemoryReactor.episodeFromSession")(function* (
  session: WorkSession,
) {
  if (session.status === "active") return null;
  if ((yield* (yield* BatonJobService).terms(session.id)) !== null) return null;
  const messages =
    session.activeThreadId === null
      ? []
      : yield* (yield* BatonEngine).recentMessages(session.activeThreadId, 2);
  const transcript = [
    `Session: ${session.title}`,
    session.objective === "" ? null : `Goal: ${session.objective}`,
    session.synopsis?.currentAction == null
      ? null
      : `Where it got to: ${session.synopsis.currentAction}`,
    ...messages.map((m) => `${m.role === "user" ? "He" : "The agent"}: ${m.text.slice(0, 1_500)}`),
    `It ended ${session.status}.`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n\n");
  return yield* (yield* BatonMemoryLearning).episode({
    origin: "session",
    title: `the session "${session.title.slice(0, 60)}"`,
    transcript,
    sourceRef: `session:${session.id}:${session.updatedAt}`,
    project: yield* projectTitle(session.projectId),
    tainted: false,
  });
});

const FIRST_PASS = "10 minutes";
const DAILY = "1 day";
const WEEK_MS = 7 * 86_400_000;

/** Once a week, on the first daily tick of it: fold near-duplicates into one item. */
const weeklyIfDue = Effect.gen(function* () {
  const week = Math.floor((yield* Clock.currentTimeMillis) / WEEK_MS);
  if (!(yield* (yield* BatonMemoryService).noteOnce("weekly-rewrite", String(week)))) return;
  yield* (yield* BatonMemoryLearning).rewriteNearDuplicates;
});

export const layer = Layer.effect(
  BatonMemoryReactor,
  Effect.gen(function* () {
    const engine = yield* BatonEngine;
    const workSessions = yield* WorkSessionService;
    const context = yield* Effect.context<
      | BatonJobService
      | WorkSessionService
      | BatonEngine
      | BatonMemoryService
      | BatonMemoryLearning
      | BatonMemorySync
      | BatonOneShot
      | ChildProcessSpawner.ChildProcessSpawner
      | Path.Path
      | ServerConfig.ServerConfig
    >();
    return {
      start: Effect.fn("BatonMemoryReactor.start")(function* () {
        yield* forkParked(
          Stream.runForEach(engine.changedThreads, (threadId) =>
            learnFromJobThread(threadId).pipe(
              Effect.andThen(learnFromJobReply(threadId)),
              Effect.andThen(checkJobReport(threadId)),
              Effect.provideContext(context),
              Effect.ignoreCause({ log: true }),
            ),
          ),
        );
        yield* forkParked(
          Stream.runForEach(
            Stream.unwrap(Effect.map(workSessions.subscribe, Stream.fromSubscription)).pipe(
              Stream.scoped,
            ),
            (item) =>
              item.kind === "fabric.workSession.statusChanged" && item.previousStatus === "active"
                ? episodeFromSession(item.workSession).pipe(
                    Effect.provideContext(context),
                    Effect.ignoreCause({ log: true }),
                  )
                : Effect.void,
          ),
        );
        yield* forkParked(
          Effect.sleep(FIRST_PASS).pipe(
            Effect.andThen(
              Effect.flatMap(BatonMemoryLearning, (learning) => learning.consolidate).pipe(
                Effect.andThen(Effect.flatMap(Clock.currentTimeMillis, dailyEpisode)),
                Effect.andThen(weeklyIfDue),
                Effect.andThen(pullIfEnabled),
                Effect.ignoreCause({ log: true }),
                Effect.repeat(Schedule.spaced(DAILY)),
              ),
            ),
            Effect.provideContext(context),
          ),
        );
      }),
    };
  }),
);
