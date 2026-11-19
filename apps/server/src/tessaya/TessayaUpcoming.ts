// @effect-diagnostics globalDate:off
/**
 * Coming up: one list of what will happen later, read through the services that own each kind of item, and each change
 * sent back to its owner. Nothing is stored here. A source that cannot do something says so in a sentence.
 */
import type {
  HomeAutomationRow,
  OrchestrationRuleError,
  OrchestrationRuleWithFirings,
  TessayaCommitment,
  TessayaLiveQueued,
  UpcomingChangeInput,
  UpcomingChangeResult,
  UpcomingItem,
  UpcomingListResult,
} from "@t3tools/tessaya-contracts";
import { UpcomingError } from "@t3tools/tessaya-contracts";
import type { ScheduledTask } from "@t3tools/contracts";
import { isDeviceRule } from "@t3tools/tessaya-shared/deviceRules";
import { orderUpcoming, UPCOMING_DAYS } from "@t3tools/tessaya-shared/upcoming";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  HomeAssistantService,
  type HomeActor,
  type HomeRefusedError,
} from "../home/HomeAssistantService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { ScheduledTaskError } from "@t3tools/contracts";
import { OrchestrationRuleService } from "./OrchestrationRuleService.ts";
import { TessayaCommitmentService } from "./TessayaCommitmentService.ts";
import { TessayaTurn } from "./TessayaTurn.ts";
import { ThreadAccountMoves } from "./ThreadAccountMoves.ts";

const short = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const can = (cancel: boolean, pause: boolean, move: boolean) => ({ cancel, pause, move });

export const houseItems = (rows: ReadonlyArray<HomeAutomationRow>): ReadonlyArray<UpcomingItem> =>
  rows
    .filter((r) => r.mine && r.status === "active")
    .map((r) => {
      const at = r.runsAt == null ? null : Date.parse(r.runsAt);
      const rule = isDeviceRule(r.id);
      return {
        id: `house:${r.id}`,
        source: rule ? "rule" : "house",
        title: short(r.alias, 200),
        line: short(
          r.request === null
            ? `${r.kind ?? "automation"} in the house`
            : `You asked: "${r.request}"`,
          400,
        ),
        at,
        condition:
          at !== null ? null : rule ? "Waiting for its device" : "Waiting for what it watches",
        repeats: at !== null && !r.once ? "daily" : null,
        paused: r.paused,
        can: can(true, true, at !== null && r.once),
      };
    });

export const reminderItems = (
  list: ReadonlyArray<TessayaCommitment>,
): ReadonlyArray<UpcomingItem> =>
  list
    .filter((c) => c.status === "open" && c.due !== null)
    .map((c) => ({
      id: `reminder:${c.id}`,
      source: "reminder",
      title: short(c.text, 200),
      line: c.owner === "you" ? "A reminder for you." : "Something Tessaya said she would do.",
      at: c.due,
      condition: null,
      repeats: null,
      paused: false,
      can: can(true, false, true),
    }));

const everyText = (ms: number) =>
  ms % 86_400_000 === 0
    ? `every ${ms / 86_400_000} d`
    : ms % 3_600_000 === 0
      ? `every ${ms / 3_600_000} h`
      : `every ${Math.round(ms / 60_000)} min`;

const repeatsOf = (task: ScheduledTask): string | null => {
  const s = task.schedule;
  if (s.type === "interval") return everyText(s.everyMs);
  if (s.type === "fixed_time")
    return s.weekdays === undefined || s.weekdays.length === 0 || s.weekdays.length === 7
      ? `daily ${s.timeOfDay}`
      : `weekly ${s.timeOfDay}`;
  return null;
};

export const taskItems = (tasks: ReadonlyArray<ScheduledTask>): ReadonlyArray<UpcomingItem> =>
  tasks.flatMap((t): ReadonlyArray<UpcomingItem> => {
    const at = t.nextRunAt === null ? null : Date.parse(t.nextRunAt);
    const webhook = t.schedule.type === "webhook";
    // A one-off that ran, or a task its policy blocks, has nothing coming.
    if (at === null && t.enabled && !webhook) return [];
    return [
      {
        id: `task:${t.id}`,
        source: "task",
        title: short(t.title, 200),
        line: short(`Scheduled task: ${t.prompt}`, 400),
        at,
        condition:
          at !== null
            ? null
            : webhook
              ? "Waiting for its webhook"
              : "Paused until you turn it back on",
        repeats: repeatsOf(t),
        paused: !t.enabled,
        can: can(true, true, t.schedule.type === "once"),
      },
    ];
  });

export const ruleItems = (
  rules: ReadonlyArray<OrchestrationRuleWithFirings>,
): ReadonlyArray<UpcomingItem> =>
  rules
    .filter(({ rule }) => rule.status !== "exhausted")
    .map(({ rule }) => ({
      id: `rule:${rule.id}`,
      source: "rule",
      title: short(rule.source, 200),
      line: `A rule on a session; it has run ${rule.firedCount} of ${rule.maxFirings} times.`,
      at: null,
      condition: "Waiting for the session it watches",
      repeats: null,
      paused: rule.status === "disabled",
      can: can(false, true, false),
    }));

const queuedText = (change: TessayaLiveQueued) =>
  [
    change.accountKey === undefined ? null : `account ${change.accountKey}`,
    change.model === undefined ? null : `model ${change.model}`,
    change.effort === undefined ? null : `effort ${change.effort}`,
  ]
    .filter((p) => p !== null)
    .join(", ") || "a restart";

export const moveItems = (waiting: {
  readonly threads: ReadonlyArray<{ readonly threadId: string; readonly instanceId: string }>;
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string;
    readonly change: TessayaLiveQueued;
  }>;
}): ReadonlyArray<UpcomingItem> => [
  ...waiting.threads.map((m) => ({
    id: `move:thread:${m.threadId}`,
    source: "move" as const,
    title: `Move a thread to ${m.instanceId}`,
    line: "Its turn is still running, so the move waits for it to end.",
    at: null,
    condition: "Waiting for its turn to end",
    repeats: null,
    paused: false,
    can: can(true, false, false),
  })),
  ...waiting.sessions.map((s) => ({
    id: `move:session:${s.sessionId}`,
    source: "move" as const,
    title: `Switch a session to ${queuedText(s.change)}`,
    line: "The session is busy, so the change waits for it to go quiet.",
    at: null,
    condition: "Waiting for the session to go quiet",
    repeats: null,
    paused: false,
    can: can(true, false, false),
  })),
];

export const dateItems = (
  dates: ReadonlyArray<{ readonly text: string; readonly kind: string; readonly at: number }>,
): ReadonlyArray<UpcomingItem> =>
  dates.map((d, i) => ({
    id: `date:${i}:${d.at}`,
    source: "date",
    title: short(d.text, 200),
    line: "From your memories.",
    at: d.at,
    allDay: true,
    condition: null,
    repeats: d.kind === "every year" ? "every year" : null,
    paused: false,
    can: can(false, false, false),
  }));

/** The sentence for an op a source cannot do. */
export const refusal = (item: UpcomingItem, op: UpcomingChangeInput["op"]): string | null => {
  if (op === "cancel" && !item.can.cancel)
    return item.source === "date"
      ? "That comes from your memories; change or forget the memory itself."
      : item.source === "rule"
        ? "A rule can be switched off, not deleted."
        : "That cannot be cancelled from here.";
  if ((op === "pause" || op === "resume") && !item.can.pause)
    return item.source === "reminder"
      ? "A reminder cannot be paused; move it or cancel it."
      : item.source === "date"
        ? "That comes from your memories; change or forget the memory itself."
        : "That cannot be paused.";
  if (op === "move" && !item.can.move)
    return item.repeats !== null && item.source === "task"
      ? `It repeats (${item.repeats}); change its schedule in Scheduled tasks.`
      : item.at === null
        ? "It waits on something, not a time, so there is no time to move."
        : item.source === "date"
          ? "That comes from your memories; change the memory itself."
          : "Its time cannot be moved from here.";
  if (op === "pause" && item.paused) return "It is already paused.";
  if (op === "resume" && !item.paused) return "It is not paused.";
  return null;
};

export class TessayaUpcoming extends Context.Service<
  TessayaUpcoming,
  {
    readonly list: (input: { readonly days?: number }) => Effect.Effect<UpcomingListResult>;
    readonly change: (
      input: UpcomingChangeInput,
      by: HomeActor,
    ) => Effect.Effect<UpcomingChangeResult, UpcomingError>;
  }
>()("t3/tessaya/TessayaUpcoming") {}

/** Each owner as the caller's context has it: the house or the scheduler may be absent on a server, never assumed. */
const owners = Effect.all({
  home: Effect.serviceOption(HomeAssistantService),
  commitments: Effect.serviceOption(TessayaCommitmentService),
  tasks: Effect.serviceOption(ScheduledTaskService),
  rules: Effect.serviceOption(OrchestrationRuleService),
  moves: Effect.serviceOption(ThreadAccountMoves),
  turn: Effect.serviceOption(TessayaTurn),
});

export const make = Effect.sync(() => {
  const list = Effect.fn("TessayaUpcoming.list")(function* (input: { readonly days?: number }) {
    const { home, commitments, tasks, rules, moves, turn } = yield* owners;
    // Each source read on its own: one that fails is named, and the rest still show.
    const sources: ReadonlyArray<{
      readonly name: string;
      readonly read: Effect.Effect<
        ReadonlyArray<UpcomingItem>,
        HomeRefusedError | ScheduledTaskError | OrchestrationRuleError
      >;
    }> = [
      ...Option.match(home, {
        onNone: () => [],
        onSome: (h) => [{ name: "the house", read: Effect.map(h.automations({}), houseItems) }],
      }),
      ...Option.match(commitments, {
        onNone: () => [],
        onSome: (c) => [{ name: "your reminders", read: Effect.map(c.list, reminderItems) }],
      }),
      ...Option.match(tasks, {
        onNone: () => [],
        onSome: (t) => [
          { name: "scheduled tasks", read: Effect.map(t.list(), (r) => taskItems(r.tasks)) },
        ],
      }),
      ...Option.match(rules, {
        onNone: () => [],
        onSome: (r) => [
          { name: "rules", read: Effect.map(r.list({ includeDisabled: true }), ruleItems) },
        ],
      }),
      ...Option.match(moves, {
        onNone: () => [],
        onSome: (m) => [{ name: "waiting moves", read: Effect.map(m.waiting, moveItems) }],
      }),
      ...Option.match(turn, {
        onNone: () => [],
        onSome: (t) => [{ name: "your memories", read: Effect.map(t.comingUp, dateItems) }],
      }),
    ];
    const read = yield* Effect.forEach(
      sources,
      (s) => Effect.result(s.read).pipe(Effect.map((r) => ({ name: s.name, r }))),
      { concurrency: "unbounded" },
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      items: orderUpcoming(
        read.flatMap(({ r }) => (r._tag === "Success" ? r.success : [])),
        now,
        input.days ?? UPCOMING_DAYS,
      ),
      unreadable: read.flatMap(({ name, r }) => (r._tag === "Failure" ? [name] : [])),
    } satisfies UpcomingListResult;
  });

  const fail = (reason: string) => Effect.fail(new UpcomingError({ reason }));
  const done = (line: string): UpcomingChangeResult => ({ done: true, line });
  const asReason = (e: unknown) =>
    new UpcomingError({
      reason:
        typeof e === "object" && e !== null && "why" in e && typeof e.why === "string"
          ? e.why
          : typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
            ? e.message
            : "That could not be done. Nothing changed.",
    });

  const change = Effect.fn("TessayaUpcoming.change")(function* (
    input: UpcomingChangeInput,
    by: HomeActor,
  ) {
    // Read now, so the change is judged on the item as it is, not as a stale screen showed it.
    const items = (yield* list({ days: 31 })).items;
    const item = items.find((i) => i.id === input.id);
    if (item === undefined) return yield* fail("That is no longer coming up.");
    const refused = refusal(item, input.op);
    if (refused !== null) return yield* fail(refused);
    const { home, commitments, tasks, rules, moves } = yield* owners;
    const now = yield* Clock.currentTimeMillis;
    const at =
      input.op !== "move"
        ? null
        : input.inMinutes !== undefined
          ? now + input.inMinutes * 60_000
          : (input.at ?? null);
    if (input.op === "move" && (at === null || at <= now))
      return yield* fail("Give a time in the future to move it to.");
    const key = input.id.slice(input.id.indexOf(":") + 1);

    switch (item.id.slice(0, item.id.indexOf(":"))) {
      case "house": {
        if (Option.isNone(home)) return yield* fail("The house is not connected here.");
        const outcome = yield* (
          input.op === "move"
            ? home.value.moveAutomation(
                { id: key, runInMinutes: Math.max(1, Math.round((at! - now) / 60_000)) },
                by,
              )
            : home.value.setAutomation(
                { id: key, op: input.op === "cancel" ? "delete" : input.op },
                by,
              )
        ).pipe(Effect.mapError(asReason));
        return { done: outcome.status === "done", line: outcome.line };
      }
      case "reminder": {
        if (Option.isNone(commitments)) return yield* fail("Reminders are not kept here.");
        const current = (yield* commitments.value.list).find((c) => c.id === key);
        if (current === undefined) return yield* fail("That reminder is gone.");
        yield* commitments.value
          .upsert([
            input.op === "cancel"
              ? { ...current, status: "dropped", closedAt: now, updatedAt: now }
              : { ...current, due: at, updatedAt: now },
          ])
          .pipe(Effect.mapError(asReason));
        return done(input.op === "cancel" ? `Dropped "${item.title}".` : `Moved "${item.title}".`);
      }
      case "task": {
        if (Option.isNone(tasks)) return yield* fail("Scheduled tasks are not available here.");
        const all = (yield* tasks.value.list().pipe(Effect.mapError(asReason))).tasks;
        const task = all.find((t) => t.id === key);
        if (task === undefined) return yield* fail("That scheduled task is gone.");
        if (input.op === "cancel") {
          yield* tasks.value.delete({ id: task.id }).pipe(Effect.mapError(asReason));
          return done(`Deleted the scheduled task "${task.title}".`);
        }
        if (input.op === "pause" || input.op === "resume") {
          yield* tasks.value
            .setEnabled({ id: task.id, enabled: input.op === "resume" })
            .pipe(Effect.mapError(asReason));
          return done(`${input.op === "pause" ? "Paused" : "Resumed"} "${task.title}".`);
        }
        yield* tasks.value
          .upsert({
            id: task.id,
            requireExisting: true,
            title: task.title,
            prompt: task.prompt,
            enabled: task.enabled,
            schedule: { type: "once", runAt: DateTime.formatIso(DateTime.makeUnsafe(at!)) },
            projectId: task.projectId,
            threadId: task.threadId,
            ...(task.threadMode === undefined ? {} : { threadMode: task.threadMode }),
            workspaceStrategy: task.workspaceStrategy,
            modelSelection: task.modelSelection,
            runtimeMode: task.runtimeMode,
            interactionMode: task.interactionMode,
          })
          .pipe(Effect.mapError(asReason));
        return done(`Moved "${task.title}".`);
      }
      case "rule": {
        if (Option.isNone(rules)) return yield* fail("Rules are not available here.");
        const found = (yield* rules.value
          .list({ includeDisabled: true })
          .pipe(Effect.mapError(asReason))).find(({ rule }) => rule.id === key);
        if (found === undefined) return yield* fail("That rule is gone.");
        yield* rules.value
          .setStatus({ id: found.rule.id, status: input.op === "pause" ? "disabled" : "enabled" })
          .pipe(Effect.mapError(asReason));
        return done(`${input.op === "pause" ? "Switched off" : "Switched on"} the rule.`);
      }
      case "move": {
        if (Option.isNone(moves)) return yield* fail("Moves are not available here.");
        const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
        const cancelled =
          kind === "thread" ? yield* moves.value.cancelMove(id) : yield* moves.value.cancelLive(id);
        return cancelled
          ? done("Cancelled the waiting change.")
          : yield* fail("It already went in.");
      }
      default:
        return yield* fail("That cannot be changed from here.");
    }
  });

  return TessayaUpcoming.of({ list, change });
});

export const layer = Layer.effect(TessayaUpcoming, make);
