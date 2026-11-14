// @effect-diagnostics nodeBuiltinImport:off
/**
 * The job's flow from his words to work (D145): the worker thread is made in plan mode with his
 * words verbatim, and only his agreement (or a standing "start" grant at plan time) lets it work.
 * The RPC handlers, the desktop tools and the phone all call these; none holds the flow itself.
 */
import {
  BatonJobPlacementError,
  type BatonJobPlaceInput,
  type BatonJobRefineInput,
  type BatonFleetEntry,
  type BatonJobScheduleInput,
  type BatonJobSplitInput,
  type BatonJobStartInput,
  WorkSessionId,
} from "@t3tools/baton-contracts";
import {
  partsSettled,
  partsSummary,
  MAX_PARTS,
  SUMMARY_MARK,
} from "@t3tools/baton-shared/coordinator";
import { BLOCKED_MARK } from "@t3tools/baton-shared/coordinator";
import { placeJob as placeFromWords } from "@t3tools/baton-shared/jobPlacement";
import { briefNudge, NUDGE_MARK, parseJobBrief } from "@t3tools/baton-shared/jobBrief";
import {
  buildReport,
  reportCadence,
  reportDue,
  retryRefusal,
  retryText,
} from "@t3tools/baton-shared/jobReport";
import { inQuietHours } from "@t3tools/baton-shared/attention";
import { DEFAULT_POLICY } from "@t3tools/baton-shared/initiative";
import {
  jobChanges,
  jobMoment,
  jobNotice,
  outboundDecision,
  permissionsSummary,
  workerFirstMessage,
} from "@t3tools/baton-shared/jobs";
import { watchFleet } from "@t3tools/baton-shared/watch";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  orchestrationV2RunWorkStartedAt,
  type ProviderInstanceId,
  ProviderDriverKind,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

import type { ScheduledTaskId } from "@t3tools/contracts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as NodePath from "node:path";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { HomeDevices } from "../home/HomeDevices.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { spendOf, type Spend } from "./BatonJobSpend.ts";
import { planningFrame, readPack } from "./OperatingSystemPack.ts";
import { expressOr } from "./TessayaExpression.ts";
import { routeFor } from "./BrainRoutes.ts";
import { DEFAULT_ROUTING, ROUTINE_EFFORT } from "@t3tools/baton-shared/costRouting";
import { modelOf, roleFor, type Brain } from "@t3tools/baton-shared/osPack";
import { BatonJobService } from "./BatonJobService.ts";
import { BatonMemoryService, MemoryViewer } from "./BatonMemoryService.ts";
import { BatonRecordService } from "./BatonRecordService.ts";
import * as FleetQuery from "./FleetQuery.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

const threadOf = Effect.fn("BatonJobFlow.threadOf")(function* (id: WorkSessionId) {
  const workSession = yield* (yield* WorkSessionService).get(id);
  return (
    workSession.providerSessions.find((session) => session.detachedAt === null)?.threadId ?? null
  );
});

/** The routing table's aliases are Claude's: another provider keeps the model it was given. */
const routesByTable = Effect.fn("BatonJobFlow.routesByTable")(function* (
  instanceId: ProviderInstanceId,
) {
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  if (Option.isNone(registry)) return true;
  const instance = yield* registry.value.getInstance(instanceId);
  return instance === undefined || instance.driverKind === "claudeAgent";
});

/** A Claude worker on a model alias and its effort; the alias resolves to the newest model of that size. */
const onBrain = (selection: ModelSelection, brain: Brain): ModelSelection => ({
  ...selection,
  model: brain.model,
  options: [{ id: "effort", value: brain.effort }],
});

/**
 * Routine work runs on the brain's routing table's `background` model. The job's own provider login carries it, as
 * every part of a job does; the table's login column applies to Tessaya's own calls.
 */
const routineBrain = routeFor("background").pipe(
  Effect.map((route) => ({ model: route.model, effort: route.effort ?? ROUTINE_EFFORT })),
  // A part must still start when the settings file can't be read: on the cheap model, and the log says why.
  Effect.catch((error) =>
    Effect.logWarning("brain: settings unreadable; a routine part runs on the cheap model", {
      error: error.message,
    }).pipe(Effect.as({ model: DEFAULT_ROUTING.cheap, effort: ROUTINE_EFFORT })),
  ),
);

/** The planning frame, with the brief of the specialist a part is given to. */
const frame = (userdata: string, role: string | undefined): string => {
  const base = planningFrame(userdata);
  const brief = role === undefined ? undefined : readPack(userdata).roles[role];
  return brief === undefined ? base : `${base}\n\nYour role (${role}): ${brief}`;
};

export interface StartOptions {
  /** This job is a part of another (the coordinator, D148). */
  readonly parentId?: WorkSessionId;
  /** Already agreed as part of the parent's plan: no planning pause, and it works at once. */
  readonly agreed?: boolean;
  /** A specialist role of the pack, whose brief is put in the frame. */
  readonly role?: string;
  /** The R1 he asked on, where its plan-ready and done lines are said. */
  readonly origin?: string;
}

export const startJob = Effect.fn("BatonJobFlow.start")(function* (
  input: BatonJobStartInput,
  options: StartOptions = {},
) {
  const jobs = yield* BatonJobService;
  const engine = yield* BatonEngine;
  const workSessions = yield* WorkSessionService;
  const uuid = Effect.gen(function* () {
    const ms = yield* Clock.currentTimeMillis;
    const noise = yield* Random.nextIntBetween(0, 2 ** 31 - 1);
    return `${ms.toString(36)}-${noise.toString(36)}`;
  });
  const id = input.id ?? WorkSessionId.make(`job-${yield* uuid}`);
  const userdata = NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath);
  // A whole job he did not pick a model for is the lead's, on the model its pack file names (D148);
  // a model he chose, and a part, keep their own. The clients send Claude's default when he picked none.
  const modelSelection =
    options.parentId === undefined &&
    input.modelSelection.model ===
      DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")] &&
    (yield* routesByTable(input.modelSelection.instanceId))
      ? onBrain(input.modelSelection, modelOf(readPack(userdata), "executive"))
      : input.modelSelection;
  const terms = yield* jobs.create({
    id,
    projectId: input.projectId,
    title: input.title,
    goal: input.goal,
    permissions: input.permissions,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    workerInstanceId: input.modelSelection.instanceId,
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    ...(options.role === undefined ? {} : { persona: options.role }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
  // A retried start finds the thread it already made.
  const existing = yield* threadOf(id);
  if (existing !== null) return { terms, threadId: existing, model: modelSelection.model };
  const workSession = yield* workSessions.get(id);
  const threadId = ThreadIdSchema.make(`job-thread-${yield* uuid}`);
  // The recall a sentence of his gets (memoryClient.forSentence), as the job's own persona when the pack knows it and
  // it is neither the lead (who sees through walls) nor private. The first message is kept with the thread, so it is
  // read in the walled view, and memory that is slow or down never holds the job up.
  const own = readPack(userdata).personas.find(
    (p) => p.id === options.role && !p.lead && p.private !== true,
  );
  const remembered = yield* (yield* BatonMemoryService)
    .recall({
      text: input.goal,
      budgetTokens: 300,
      ...(own === undefined ? {} : { agent: own.id }),
      scopeRef: (yield* engine.projects).find((p) => p.id === input.projectId)?.title ?? undefined,
    })
    .pipe(
      Effect.provideService(MemoryViewer, "client"),
      Effect.timeout("2 seconds"),
      Effect.catchCause(() => Effect.succeed({ block: "" })),
    );
  const launched = yield* engine.launchThread({
    tag: "job",
    threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: options.agreed === true ? "default" : "plan",
    worktreePath: workSession.primaryWorktreePath,
    branch: workSession.baseBranch,
    text: workerFirstMessage({
      verbatim: input.goal,
      frame: frame(userdata, options.role),
      memory: remembered.block,
      ...(options.agreed === true ? { agreed: true } : {}),
      permissionsSummary: permissionsSummary(terms.permissions, terms.limits, terms.grants),
    }),
  });
  if (launched === null) {
    return yield* Effect.die(new Error("The worker thread could not be started."));
  }
  yield* workSessions.attachThread({
    id,
    threadId: launched,
    providerInstanceId: input.modelSelection.instanceId,
    providerDriver: null,
    origin: "created",
  });
  if (options.agreed === true) {
    yield* jobs.planReady(id);
    return {
      terms: (yield* jobs.agree(id)) ?? terms,
      threadId: launched,
      model: modelSelection.model,
    };
  }
  return { terms, threadId: launched, model: modelSelection.model };
});

/** The plan stands and the work begins: out of plan mode, and told to go. */

/** A job from his words: the project he named here and the first ready Claude, then an ordinary start. */
export const placeJob = Effect.fn("BatonJobFlow.place")(function* (input: BatonJobPlaceInput) {
  const engine = yield* BatonEngine;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const placed = placeFromWords(
    input.project,
    yield* engine.projects,
    yield* registry.getProviders,
    input.worker,
  );
  if (!placed.ok) return yield* new BatonJobPlacementError({ detail: placed.why });
  const { project, label, worker } = placed.value;
  return yield* startJob(
    {
      projectId: project.id,
      title: input.title,
      goal: input.goal,
      permissions: {
        folders: input.folders,
        projects: [label],
        tools: input.tools.length === 0 ? ["read"] : input.tools,
      },
      ...(input.reportEveryMinutes === undefined
        ? {}
        : { limits: { reportEveryMinutes: input.reportEveryMinutes } }),
      modelSelection: { instanceId: worker.instanceId, model: worker.model } as ModelSelection,
      // Anything the worker would ask permission for becomes a card that needs him.
      runtimeMode: "approval-required",
    },
    input.origin === undefined ? {} : { origin: input.origin },
  );
});

export const beginWork = Effect.fn("BatonJobFlow.beginWork")(function* (threadId: ThreadId) {
  const engine = yield* BatonEngine;
  yield* engine
    .setInteractionMode({ tag: "job", threadId, interactionMode: "default" })
    .pipe(Effect.ignoreCause({ log: true }));
  yield* engine.sendMessage({
    tag: "job",
    threadId,
    text: "Go ahead with the plan as it stands. Stay inside what you were allowed.",
  });
});

export const agreeJob = Effect.fn("BatonJobFlow.agree")(function* (id: WorkSessionId) {
  const jobs = yield* BatonJobService;
  let before = yield* jobs.terms(id);
  if (before === null) return null;
  // The worker's planning turn has ended, so the plan is in the thread: a reply there, a click or
  // a spoken yes is an answer to it. (A reactor will notice this by itself in a later step.)
  if (before.phase === "drafting_plan") {
    const threadId = yield* threadOf(id);
    const shell = threadId === null ? null : yield* (yield* BatonEngine).threadShell(threadId);
    if (shell?.status === "completed") before = (yield* jobs.planReady(id)) ?? before;
  }
  const terms = yield* jobs.agree(id);
  // Only a job that was waiting starts; agreeing twice sends nothing twice.
  if (terms !== null && before.phase === "awaiting_agreement" && terms.phase === "approved") {
    const threadId = yield* threadOf(id);
    if (threadId !== null) yield* beginWork(threadId);
  }
  return terms;
});

export const refineJob = Effect.fn("BatonJobFlow.refine")(function* (input: BatonJobRefineInput) {
  const jobs = yield* BatonJobService;
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  const terms = yield* jobs.refine(
    input.id,
    {
      by: input.note === true ? "baton" : "him",
      at,
      via: input.note === true ? "thread" : input.via,
      text: input.text,
    },
    input.widens === true,
  );
  if (terms === null || input.note === true) return terms;
  const threadId = yield* threadOf(input.id);
  // The plan is made again with his words, word for word.
  if (threadId !== null) {
    const engine = yield* BatonEngine;
    yield* engine.sendMessage({ tag: "job", threadId, text: input.text });
  }
  return terms;
});

/** Runs that actually ran: one is a turn the worker took. Queued, cancelled and rolled-back ones are not. */
const TURN_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
]);

/**
 * A guide, never a cap (his decision): a persona's background turns in a day, and the whole team's.
 * Passing one is noted once that day; nothing is stopped or held back.
 */
export const PERSONA_DAY_GUIDE = 40;
export const TEAM_DAY_GUIDE = 120;
const DAY_MS = 24 * 60 * 60_000;

/** Which personas, and whether the whole team, have passed the day's guide. */
export const pastGuide = (counts: ReadonlyMap<string, number>) => ({
  personas: [...counts].filter(([, n]) => n > PERSONA_DAY_GUIDE).map(([persona]) => persona),
  team: [...counts.values()].reduce((a, b) => a + b, 0) > TEAM_DAY_GUIDE,
});

/** Turns each persona's jobs took since `since`, by persona. */
const dayTurns = Effect.fn("BatonJobFlow.dayTurns")(function* (
  entries: ReadonlyArray<BatonFleetEntry>,
  personas: ReadonlyMap<string, string>,
  since: number,
) {
  const engine = yield* BatonEngine;
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const persona = personas.get(entry.workSessionId);
    if (persona === undefined) continue;
    let n = 0;
    for (const thread of entry.threads) {
      const runs = yield* engine.threadRuns(thread.threadId);
      n += runs.filter(
        (r) =>
          TURN_STATUSES.has(r.status) &&
          DateTime.toEpochMillis(orchestrationV2RunWorkStartedAt(r)) > since,
      ).length;
    }
    counts.set(persona, (counts.get(persona) ?? 0) + n);
  }
  return counts;
});

/** What each worker has taken so far, for the cards and for the caps. */
export const turnCounts = Effect.fn("BatonJobFlow.turnCounts")(function* (
  entries: ReadonlyArray<BatonFleetEntry>,
) {
  const engine = yield* BatonEngine;
  const counts = new Map<string, number>();
  for (const entry of entries) {
    let n = 0;
    for (const thread of entry.threads) {
      const runs = yield* engine.threadRuns(thread.threadId);
      n += runs.filter((r) => TURN_STATUSES.has(r.status)).length;
    }
    counts.set(entry.workSessionId, n);
  }
  return counts;
});

/** What each worker has spent, read from its own transcript; empty when this server keeps no state folder. */
export const spendCounts = Effect.fn("BatonJobFlow.spendCounts")(function* (
  entries: ReadonlyArray<BatonFleetEntry>,
) {
  const config = yield* ServerConfig.ServerConfig;
  const stateDir = (config as { readonly stateDir?: string }).stateDir;
  const out = new Map<string, Spend>();
  if (stateDir === undefined) return out;
  const engine = yield* BatonEngine;
  for (const entry of entries) {
    const nativeIds: string[] = [];
    for (const thread of entry.threads) {
      const provider = yield* engine.activeProviderThread(thread.threadId);
      const id = provider?.nativeThreadRef?.nativeId;
      if (id != null) nativeIds.push(id);
    }
    if (nativeIds.length > 0) out.set(entry.workSessionId, spendOf({ nativeIds, stateDir }));
  }
  return out;
});

export const listJobs = Effect.fn("BatonJobFlow.list")(function* () {
  const jobs = yield* BatonJobService;
  const fleet = yield* FleetQuery.getFleet({});
  return yield* jobs.view({
    entries: fleet.entries,
    turns: yield* turnCounts(fleet.entries),
    spend: yield* spendCounts(fleet.entries),
  });
});

/**
 * The caps are enforced, not only shown: an agreed job whose worker is still going after its time or
 * turns are used up is stopped (its thread and plan stay) and a line says why. Raising the cap with a
 * refinement lets it go on. Spend is read from the worker's own transcript; a dollar cap trips on what could be priced.
 */
export const enforceCaps = Effect.fn("BatonJobFlow.enforceCaps")(function* (
  entries: ReadonlyArray<BatonFleetEntry>,
) {
  const jobs = yield* BatonJobService;
  const cards = yield* jobs.view({
    entries,
    turns: yield* turnCounts(entries),
    spend: yield* spendCounts(entries),
  });
  const stopped: string[] = [];
  for (const card of cards) {
    // Only a worker that is going: one waiting for him, or finished, spends nothing.
    if (
      card.phase !== "approved" ||
      card.limitReached === null ||
      !["working", "starting", "monitoring"].includes(card.state)
    ) {
      continue;
    }
    if (!(yield* stopJob(card.workSessionId))) continue;
    const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* jobs.refine(card.workSessionId, {
      by: "baton",
      at,
      via: "thread",
      text: `Stopped: it reached its ${card.limitReached} limit. Raise the limit to let it go on.`,
    });
    stopped.push(card.workSessionId);
  }
  return stopped;
});

/**
 * Counts each persona's background turns today (UTC) and, the first time a persona or the team passes
 * the guide that day, says so once in the Record. Nothing is stopped. Returns who was noted.
 */
export const noteDayTurns = Effect.fn("BatonJobFlow.noteDayTurns")(function* (
  entries: ReadonlyArray<BatonFleetEntry>,
) {
  const record = yield* Effect.serviceOption(BatonRecordService);
  if (Option.isNone(record)) return [];
  const now = yield* Clock.currentTimeMillis;
  const dayStart = now - (now % DAY_MS);
  const counts = yield* dayTurns(entries, yield* (yield* BatonJobService).personas(), dayStart);
  const past = pastGuide(counts);
  if (!past.team && past.personas.length === 0) return [];
  const told = yield* record.value.query({
    kind: "background_turns",
    since: DateTime.formatIso(DateTime.makeUnsafe(dayStart - 1)),
    limit: 50,
  });
  const roster = readPack(NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath)).personas;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const notes = [
    ...past.personas.map((id) => ({
      actor: roster.find((p) => p.id === id)?.name ?? id,
      line: `${counts.get(id)} background turns today, past the guide of ${PERSONA_DAY_GUIDE}`,
    })),
    ...(past.team
      ? [
          {
            actor: "team",
            line: `${total} background turns today, past the guide of ${TEAM_DAY_GUIDE}`,
          },
        ]
      : []),
  ].filter((n) => !told.some((r) => r.actor === n.actor));
  for (const note of notes) {
    yield* record.value.append({
      kind: "background_turns",
      actor: note.actor,
      subject: `${note.actor === "team" ? "The team has used" : `${note.actor} has used`} ${note.line}. Nothing was stopped.`,
      outcome: "noted",
      detail: [...counts].map(([persona, n]) => `${persona}: ${n}`).join(", "),
    });
  }
  return notes.map((n) => n.actor);
});

/**
 * A failed worker is asked to try again by itself, but only for a job holding a standing "retry"
 * permission (off unless he gave it) and only inside its retry budget. A job that stopped at a limit
 * is never retried here: that needs his decision to raise the limit.
 */
export const autoRetry = Effect.fn("BatonJobFlow.autoRetry")(function* (
  entries: ReadonlyArray<BatonFleetEntry>,
) {
  const jobs = yield* BatonJobService;
  const cards = yield* jobs.view({ entries });
  const retried: string[] = [];
  for (const card of cards) {
    if (card.group !== "failed" || card.limitReached !== null) continue;
    if (outboundDecision(card.terms.grants, "retry") !== "standing") continue;
    if (retryRefusal(card) !== null) continue;
    const threadId = yield* threadOf(card.workSessionId);
    if (threadId === null) continue;
    const entry = entries.find((e) => e.workSessionId === card.workSessionId);
    const text = retryText(card, "the worker failed", entry?.synopsis?.currentAction ?? null);
    const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    // The record comes first: it counts against the budget even if the message below fails.
    yield* jobs.refine(card.workSessionId, { by: "baton", at, via: "thread", text });
    yield* (yield* BatonEngine).sendMessage({ tag: "job", threadId, text });
    retried.push(card.workSessionId);
  }
  return retried;
});

/**
 * A thread changed: if it is a job's worker that has finished writing its plan, the plan is ready
 * (and a job holding a standing "start" permission begins at once). Anything else changes nothing.
 */
export const noticePlan = Effect.fn("BatonJobFlow.noticePlan")(function* (threadId: ThreadId) {
  const jobs = yield* BatonJobService;
  const id = yield* (yield* WorkSessionService).findForThread(threadId);
  if (id === null) return;
  const terms = yield* jobs.terms(id);
  if (terms === null || terms.phase !== "drafting_plan") return;
  const engine = yield* BatonEngine;
  const shell = yield* engine.threadShell(threadId);
  if (shell?.status !== "completed") return;
  // A plan without the job brief is not ready: ask once, and accept it on the second try so a
  // worker that will not comply cannot hold the job forever.
  const last = (yield* engine.recentMessages(threadId, 1)).findLast((m) => m.role === "assistant");
  const brief = parseJobBrief(last?.text ?? "");
  if (!brief.ok) {
    const asked = terms.revisions.some((r) => r.text.startsWith(NUDGE_MARK));
    if (!asked) {
      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* jobs.refine(id, {
        by: "baton",
        at,
        via: "thread",
        text: `${NUDGE_MARK} ${brief.missing.join(", ")}`,
      });
      yield* engine.sendMessage({ tag: "job", threadId, text: briefNudge(brief.missing) });
      return;
    }
  }
  const next = yield* jobs.planReady(id);
  if (next?.phase === "approved") yield* beginWork(threadId);
});

/** His stop: the worker's running turn ends now. The job and its thread stay for him to read. */
export const stopJob = Effect.fn("BatonJobFlow.stop")(function* (id: WorkSessionId) {
  const threadId = yield* threadOf(id);
  if (threadId === null) return false;
  return yield* (yield* BatonEngine).interruptThread({ tag: "job", threadId });
});

/** His retry (from the phone or the window): the same message an automatic retry sends, if the job may be retried. */
export const retryJob = Effect.fn("BatonJobFlow.retry")(function* (id: WorkSessionId) {
  const jobs = yield* BatonJobService;
  const fleet = yield* FleetQuery.getFleet({});
  const card = (yield* jobs.view({ entries: fleet.entries })).find((c) => c.workSessionId === id);
  if (card === undefined) return "There is no such job.";
  const refusal = retryRefusal(card);
  if (refusal !== null) return refusal;
  const threadId = yield* threadOf(id);
  if (threadId === null) return "That job has no worker to ask.";
  const entry = fleet.entries.find((e) => e.workSessionId === id);
  const text = retryText(card, "he asked for another try", entry?.synopsis?.currentAction ?? null);
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  yield* jobs.refine(id, { by: "him", at, via: "text", text });
  yield* (yield* BatonEngine).sendMessage({ tag: "job", threadId, text });
  return "Asked it to try again.";
});

/**
 * A job that has been agreed runs again on a schedule in its own thread, so each run reports where
 * the first one did. Schedules are T3's own scheduled tasks (D145); null takes the schedule off.
 */
export const scheduleJob = Effect.fn("BatonJobFlow.schedule")(function* (
  input: BatonJobScheduleInput,
) {
  const jobs = yield* BatonJobService;
  const tasks = yield* ScheduledTaskService;
  const terms = yield* jobs.terms(input.id);
  if (terms === null) return null;
  if (input.everyMinutes === null) {
    if (terms.scheduleTaskId !== null) {
      yield* tasks
        .delete({ id: terms.scheduleTaskId as ScheduledTaskId })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    return yield* jobs.setSchedule(input.id, null);
  }
  // Recurring work runs unattended, so only a plan he has agreed to is repeated.
  if (terms.phase !== "approved") return terms;
  const threadId = yield* threadOf(input.id);
  const shell = threadId === null ? null : yield* (yield* BatonEngine).threadShell(threadId);
  if (threadId === null || shell === null) return terms;
  const workSession = yield* (yield* WorkSessionService).get(input.id);
  const saved = yield* tasks
    .upsert({
      ...(terms.scheduleTaskId === null ? {} : { id: terms.scheduleTaskId as ScheduledTaskId }),
      title: `${workSession.title} (scheduled)`,
      prompt: `Run this job again and report what changed since the last run.\n\nThe job: ${terms.goal}`,
      enabled: true,
      schedule: {
        type: "interval",
        everyMs: Math.max(60_000, Math.round(input.everyMinutes * 60_000)),
      },
      projectId: shell.projectId,
      threadId,
      workspaceStrategy:
        shell.worktreePath === null
          ? { type: "root" }
          : { type: "existing_worktree", worktreePath: shell.worktreePath },
      modelSelection: shell.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
    })
    .pipe(Effect.catchTags({ ScheduledTaskError: () => Effect.succeed(null) }));
  return saved === null ? terms : yield* jobs.setSchedule(input.id, saved.task.id);
});

/**
 * Splits an agreed job into parts, each its own worker started already agreed (the parent's plan
 * named them), inside the parent's own permissions. Refused for a plan not yet agreed.
 */
/** Starts one part of an agreed job, already agreed, with its role and model. */
const launchPart = Effect.fn("BatonJobFlow.launchPart")(function* (input: {
  readonly parentId: WorkSessionId;
  readonly id: WorkSessionId;
  readonly title: string;
  readonly goal: string;
  readonly role?: string | undefined;
  readonly routine?: boolean | undefined;
}) {
  const jobs = yield* BatonJobService;
  const parent = yield* jobs.terms(input.parentId);
  const workSession = yield* (yield* WorkSessionService).get(input.parentId);
  const userdata = NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath);
  const parentThread = yield* threadOf(input.parentId);
  const shell =
    parentThread === null ? null : yield* (yield* BatonEngine).threadShell(parentThread);
  if (parent === null || shell === null) return null;
  // A specialist's own tool list (its roster file) narrows the part's tools further; it never adds one.
  const own = readPack(userdata).personas.find((p) => p.id === input.role)?.tools ?? null;
  const result = yield* startJob(
    {
      id: input.id,
      projectId: workSession.projectId,
      title: input.title,
      goal: input.goal,
      // A part never has more than its parent: the same folders, projects and tools.
      permissions:
        own === null
          ? parent.permissions
          : {
              ...parent.permissions,
              tools: parent.permissions.tools.filter((t) => own.some((o) => o.toLowerCase() === t)),
            },
      // Routine work on the cheap model. On the lead's own model, a specialist runs on the model its pack
      // file names; a model he picked for the job stays for its other parts.
      modelSelection: !(yield* routesByTable(shell.modelSelection.instanceId))
        ? shell.modelSelection
        : input.routine === true
          ? onBrain(shell.modelSelection, yield* routineBrain)
          : input.role !== undefined &&
              shell.modelSelection.model === modelOf(readPack(userdata), "executive").model
            ? onBrain(shell.modelSelection, modelOf(readPack(userdata), input.role))
            : shell.modelSelection,
      runtimeMode: "approval-required",
    },
    {
      parentId: input.parentId,
      agreed: true,
      ...(input.role === undefined ? {} : { role: input.role }),
    },
  );
  yield* jobs.clearPartSpec(input.id);
  // The card shows which model a step used (D148).
  yield* jobs.refine(input.id, {
    by: "baton",
    at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
    via: "thread",
    text: `Model: ${result.model}${input.routine === true ? " (routine step, cheap model)" : ""}`,
  });
  return { id: input.id, threadId: result.threadId };
});

/**
 * Splits an agreed job into parts, each its own worker started already agreed (the parent's plan
 * named them), inside the parent's own permissions. A part that waits on earlier ones is recorded
 * and started when they are done. Refused for a plan not yet agreed.
 */
export const splitJob = Effect.fn("BatonJobFlow.split")(function* (input: BatonJobSplitInput) {
  const jobs = yield* BatonJobService;
  const parent = yield* jobs.terms(input.id);
  if (parent === null || parent.phase !== "approved") return [];
  const workSession = yield* (yield* WorkSessionService).get(input.id);
  const started: Array<{ readonly id: WorkSessionId; readonly threadId: ThreadId }> = [];
  const partId = (n: number) => WorkSessionId.make(`${input.id}-part-${n}`);
  const pack = readPack(NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath));
  for (const [i, said] of input.parts.slice(0, MAX_PARTS).entries()) {
    // The lead names the specialist as he knows it (Sebastian) or by its file (research).
    const part = said.role === undefined ? said : { ...said, role: roleFor(pack, said.role) };
    const id = partId(i + 1);
    // Only earlier parts can be waited on, so there is no cycle to find.
    const after = [...new Set(part.after ?? [])].filter((n) => n >= 1 && n <= i).map(partId);
    if (after.length === 0) {
      const one = yield* launchPart({ parentId: input.id, id, ...part });
      if (one !== null) started.push(one);
      continue;
    }
    yield* jobs.create({
      id,
      projectId: workSession.projectId,
      title: part.title,
      goal: part.goal,
      permissions: parent.permissions,
      parentId: input.id,
      partSpec: {
        after,
        ...(part.role === undefined ? {} : { role: part.role }),
        ...(part.routine === true ? { routine: true } : {}),
      },
    });
  }
  return started;
});

/**
 * Starts the parts whose earlier parts are all done, and marks a part that can never start because one
 * it waits on failed. True when something started or was blocked, so the caller waits for the next change.
 */
export const releaseWaiting = Effect.fn("BatonJobFlow.releaseWaiting")(function* (
  parentId: WorkSessionId,
  entries: ReadonlyArray<BatonFleetEntry>,
) {
  const jobs = yield* BatonJobService;
  const all = yield* jobs.parts(parentId);
  const cards = yield* jobs.view({ entries });
  const group = new Map(cards.map((c) => [c.workSessionId as string, c.group]));
  let changed = false;
  for (const part of all) {
    if (part.partSpec === null) continue;
    const states = part.partSpec.after.map((id) => group.get(id));
    const failed = part.partSpec.after.filter((_, i) => states[i] === "failed");
    if (failed.length > 0) {
      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* jobs.refine(part.workSessionId, {
        by: "baton",
        at,
        via: "thread",
        text: `${BLOCKED_MARK} ${failed.join(", ")} failed`,
      });
      yield* jobs.clearPartSpec(part.workSessionId);
      changed = true;
    } else if (states.every((g) => g === "done")) {
      const title = entries.find((e) => e.workSessionId === part.workSessionId)?.title;
      const ws = yield* (yield* WorkSessionService).get(part.workSessionId);
      yield* launchPart({
        parentId,
        id: part.workSessionId,
        title: title ?? ws.title,
        goal: part.goal,
        role: part.partSpec.role,
        routine: part.partSpec.routine,
      });
      changed = true;
    }
  }
  return changed;
});

/**
 * When every part has settled, one summary goes to the parent's thread, once: what each did and
 * what failed, read from the cards and the watch. The mark in the parent's record keeps it once.
 */
export const summarizeParts = Effect.fn("BatonJobFlow.summarizeParts")(function* (
  parentId: WorkSessionId,
  entries: ReadonlyArray<BatonFleetEntry>,
) {
  const jobs = yield* BatonJobService;
  const parent = yield* jobs.terms(parentId);
  if (parent === null || parent.revisions.some((r) => r.text.startsWith(SUMMARY_MARK)))
    return false;
  const parts = (yield* jobs.view({ entries })).filter((j) => j.terms.parentId === parentId);
  // A part still waiting to start, or never started because one it needed failed, has no thread yet.
  const rest = (yield* jobs.parts(parentId)).filter(
    (t) => !parts.some((p) => p.workSessionId === t.workSessionId),
  );
  if (rest.some((t) => t.partSpec !== null)) return false;
  if (!partsSettled(parts)) return false;
  const threadId = yield* threadOf(parentId);
  if (threadId === null) return false;
  const now = yield* Clock.currentTimeMillis;
  const workSessions = yield* WorkSessionService;
  const blocked = yield* Effect.forEach(
    rest.filter((t) => t.revisions.some((r) => r.text.startsWith(BLOCKED_MARK))),
    (t) =>
      Effect.map(workSessions.get(t.workSessionId), (ws) => ({
        title: ws.title,
        why: t.revisions
          .find((r) => r.text.startsWith(BLOCKED_MARK))!
          .text.slice(BLOCKED_MARK.length)
          .trim(),
      })),
  );
  const text = partsSummary({
    blocked,
    parentTitle: entries.find((e) => e.workSessionId === parentId)?.title ?? parentId,
    parts,
    findings: watchFleet(entries, now),
  });
  const at = DateTime.formatIso(DateTime.makeUnsafe(now));
  yield* jobs.refine(parentId, { by: "baton", at, via: "thread", text });
  return yield* (yield* BatonEngine).sendMessage({ tag: "job", threadId, text });
});

/** A thread changed: if it is a part, the coordinator looks at whether its parent's parts are all in. */
export const noticePart = Effect.fn("BatonJobFlow.noticePart")(function* (threadId: ThreadId) {
  const id = yield* (yield* WorkSessionService).findForThread(threadId);
  if (id === null) return;
  const terms = yield* (yield* BatonJobService).terms(id);
  if (terms?.parentId == null) return;
  const entries = (yield* FleetQuery.getFleet({})).entries;
  // Starting a waiting part changes the fleet; the summary waits for the next change.
  if (yield* releaseWaiting(terms.parentId, entries)) return;
  yield* summarizeParts(terms.parentId, entries);
});

/** Worker states in which a progress report is worth writing: it is going, or it is stuck on something. */
const REPORTING_STATES: ReadonlySet<string> = new Set([
  "working",
  "starting",
  "monitoring",
  "needs_input",
  "needs_approval",
  "failed",
  "limited",
  "offline",
]);

/**
 * A progress report in each agreed, unfinished job's record every so often (60 minutes unless the job
 * said otherwise): what happened, what is next, what blocks, what it has used. Written from state, so it
 * costs no turn and never wakes the worker.
 */
export const postReports = Effect.fn("BatonJobFlow.postReports")(function* (
  entries: ReadonlyArray<BatonFleetEntry>,
) {
  const jobs = yield* BatonJobService;
  const spend = yield* spendCounts(entries);
  const cards = yield* jobs.view({ entries, turns: yield* turnCounts(entries), spend });
  const now = yield* Clock.currentTimeMillis;
  const wrote: string[] = [];
  for (const card of cards) {
    const entry = entries.find((e) => e.workSessionId === card.workSessionId);
    if (entry === undefined || card.phase !== "approved" || !REPORTING_STATES.has(card.state))
      continue;
    if (!reportDue(card.terms.revisions, card.terms.createdAt, reportCadence(card), now)) continue;
    const synopsis = entry.synopsis;
    const text = buildReport({
      title: card.title,
      state: card.state,
      minutes: card.usage?.minutes ?? 0,
      turns: card.usage?.turns ?? 0,
      dollars: card.usage?.dollars ?? null,
      partial: card.usage?.partial ?? false,
      doing: synopsis?.currentAction ?? null,
      findings: synopsis?.recentFindings.map((f) => f.text) ?? [],
      changedFiles: synopsis?.changedFiles ?? [],
      next: synopsis?.next ?? [],
      needsUser: synopsis?.needsUser ?? entry.needsUser,
      failedChecks: synopsis?.validation.filter((v) => v.outcome === "failed").length ?? 0,
      limitReached: card.limitReached,
    });
    yield* jobs.refine(card.workSessionId, {
      by: "baton",
      at: DateTime.formatIso(DateTime.makeUnsafe(now)),
      via: "thread",
      text,
    });
    wrote.push(card.workSessionId);
  }
  return wrote;
});

/** Where each job stood when last written to the Record, read back so a restart sees changes made while it was down. */
export const jobRecordSeed = Effect.fn("BatonJobFlow.jobRecordSeed")(function* () {
  const seen = new Map<string, string>();
  const record = yield* Effect.serviceOption(BatonRecordService);
  if (Option.isNone(record)) return seen;
  // Newest first, so the first row per job is where it stands.
  for (const row of yield* record.value.query({ kind: "job", limit: 500 }))
    if (row.ref !== null && !seen.has(row.ref)) seen.set(row.ref, row.outcome);
  return seen;
});

/**
 * A job's change said on the R1 he asked it on (voice/say opens a session there, so he can answer): never in quiet
 * hours, and at most the nudge budget an hour. The Record row is kept either way, so nothing is lost when it is quiet.
 */
const sayOnOrigin = Effect.fn("BatonJobFlow.sayOnOrigin")(function* (
  device: string,
  line: string,
  said: Array<number>,
) {
  const devices = yield* Effect.serviceOption(HomeDevices);
  if (Option.isNone(devices)) return;
  const now = yield* Clock.currentTimeMillis;
  const house = yield* Effect.serviceOption(HomeAssistantService);
  const zone = Option.isSome(house) ? yield* house.value.timeZone : "UTC";
  // shortcut: the desktop's own quiet hours never reach the server, so the default policy's hold here.
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(
      now,
    ),
  );
  if (inQuietHours(DEFAULT_POLICY.quietHours, hour)) return;
  const recent = said.filter((at) => now - at < 3_600_000);
  if (recent.length >= DEFAULT_POLICY.maxPerHour) return;
  said.splice(0, said.length, ...recent, now);
  yield* devices.value
    .command(device, { op: "say", text: line }, { who: "Tessaya", surface: "assistant" })
    .pipe(Effect.ignoreCause({ log: true }));
});

/** Each job whose phase or standing changed, as one Record row, and said where he asked for it. */
export const recordJobChanges = Effect.fn("BatonJobFlow.recordJobChanges")(function* (
  entries: ReadonlyArray<BatonFleetEntry>,
  seen: Map<string, string>,
  said: Array<number> = [],
) {
  const record = yield* Effect.serviceOption(BatonRecordService);
  if (Option.isNone(record)) return;
  const changes = jobChanges(yield* (yield* BatonJobService).view({ entries }), seen);
  if (changes.length === 0) return;
  const origins = yield* (yield* BatonJobService).origins();
  const projects = new Map((yield* (yield* BatonEngine).projects).map((p) => [p.id, p.title]));
  const personas = yield* (yield* BatonJobService).personas();
  const roster = readPack(NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath)).personas;
  for (const { job, outcome } of changes) {
    const projectId = entries.find((e) => e.workSessionId === job.workSessionId)?.projectId;
    const persona = personas.get(job.workSessionId);
    yield* record.value.append({
      kind: "job",
      // A specialist's outcome is its own line in the Record, under its name; it reports to no other agent.
      actor: roster.find((p) => p.id === persona)?.name ?? persona ?? "job",
      project: projectId === undefined ? null : (projects.get(projectId) ?? null),
      ref: job.workSessionId,
      subject: job.title,
      outcome,
    });
    const origin = origins.get(job.workSessionId);
    const line = jobNotice(job.title, outcome);
    if (origin !== undefined && line !== null) {
      // In the voice of the persona the job is for; sayOnOrigin keeps the quiet hours and the hourly budget.
      const moment = jobMoment(outcome);
      const own =
        moment === null
          ? null
          : yield* expressOr(moment.event, {
              persona,
              plain: line,
              facts: { title: job.title, ...moment.facts },
            });
      yield* sayOnOrigin(origin, own?.text ?? line, said);
    }
  }
});
