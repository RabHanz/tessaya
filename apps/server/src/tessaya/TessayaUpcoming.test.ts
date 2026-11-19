// @effect-diagnostics globalDate:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { HomeAssistantService, HomeRefusedError } from "../home/HomeAssistantService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { OrchestrationRuleService } from "./OrchestrationRuleService.ts";
import { TessayaCommitmentService } from "./TessayaCommitmentService.ts";
import { ThreadAccountMoves } from "./ThreadAccountMoves.ts";
import * as TessayaUpcoming from "./TessayaUpcoming.ts";

const NOW = Date.parse("2026-11-19T17:00:00.000Z");
const MIN = 60_000;
const by = { who: "the Director", surface: "settings" } as const;

const setup = (homeOverride?: Layer.Layer<HomeAssistantService>) => {
  const calls: Array<string> = [];
  const automations = [
    {
      id: "tessaya_temporary_1",
      alias: "Pump off",
      kind: "temporary",
      mine: true,
      expiresAt: null,
      once: true,
      paused: false,
      status: "active",
      request: "pump off in twenty",
      entityId: "automation.pump_off",
      runsAt: new Date(NOW + 20 * MIN).toISOString(),
    },
    {
      id: "tessaya_device_2",
      alias: "Battery low",
      kind: "permanent",
      mine: true,
      expiresAt: null,
      once: false,
      paused: false,
      status: "active",
      request: null,
      entityId: null,
    },
  ];
  const home =
    homeOverride ??
    Layer.succeed(HomeAssistantService, {
      automations: () => Effect.succeed(automations),
      setAutomation: (input: { id: string; op: string }) =>
        Effect.sync(() => {
          calls.push(`house ${input.op} ${input.id}`);
          return { status: "done", line: `${input.op} ${input.id}` };
        }),
      moveAutomation: (input: { id: string; runInMinutes: number }) =>
        Effect.sync(() => {
          calls.push(`house move ${input.id} ${input.runInMinutes}`);
          return { status: "done", line: "moved" };
        }),
    } as never);
  const reminders = [
    {
      id: "r1",
      text: "Call the accountant",
      owner: "you",
      due: NOW + 95 * MIN,
      status: "open",
      source: "voice",
      createdAt: NOW - MIN,
    },
  ];
  const commitments = Layer.succeed(TessayaCommitmentService, {
    list: Effect.succeed(reminders),
    upsert: (items: ReadonlyArray<{ id: string; status: string; due: number | null }>) =>
      Effect.sync(() => {
        for (const i of items) calls.push(`reminder ${i.id} ${i.status} ${i.due}`);
        return items.length;
      }),
  } as never);
  const task = (id: string, schedule: object, nextRunAt: string | null) => ({
    id,
    title: id,
    prompt: "check",
    enabled: true,
    schedule,
    projectId: "p",
    threadId: null,
    workspaceStrategy: { type: "local" },
    modelSelection: {},
    runtimeMode: "full-access",
    interactionMode: "default",
    nextRunAt,
  });
  const tasks = Layer.succeed(ScheduledTaskService, {
    list: () =>
      Effect.succeed({
        tasks: [
          task(
            "ci",
            { type: "interval", everyMs: 4 * 60 * MIN },
            new Date(NOW + 170 * MIN).toISOString(),
          ),
          task(
            "once",
            { type: "once", runAt: new Date(NOW + 300 * MIN).toISOString() },
            new Date(NOW + 300 * MIN).toISOString(),
          ),
        ],
      }),
    delete: ({ id }: { id: string }) =>
      Effect.sync(() => (calls.push(`task delete ${id}`), { id })),
    setEnabled: (i: { id: string; enabled: boolean }) =>
      Effect.sync(() => (calls.push(`task enabled ${i.id} ${i.enabled}`), {})),
    upsert: (i: { id: string; schedule: { runAt: string } }) =>
      Effect.sync(
        () => (calls.push(`task once ${i.id} ${Date.parse(i.schedule.runAt) - NOW}`), {}),
      ),
  } as never);
  const rules = Layer.succeed(OrchestrationRuleService, {
    list: () =>
      Effect.succeed([
        {
          rule: {
            id: "rule-1",
            source: "ping me when a session waits 20 min",
            status: "enabled",
            firedCount: 1,
            maxFirings: 3,
          },
          firings: [],
        },
      ]),
    setStatus: (i: { id: string; status: string }) =>
      Effect.sync(() => (calls.push(`rule ${i.id} ${i.status}`), {})),
  } as never);
  const moves = Layer.succeed(ThreadAccountMoves, {
    waiting: Effect.succeed({
      threads: [{ threadId: "t1", instanceId: "claudeAgent-2" }],
      sessions: [],
    }),
    cancelMove: (id: string) => Effect.sync(() => (calls.push(`move cancel ${id}`), true)),
    cancelLive: () => Effect.succeed(false),
  } as never);
  const layer = TessayaUpcoming.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(home, commitments, tasks, rules, moves)),
  );
  return { calls, layer };
};

const upcoming = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  return yield* TessayaUpcoming.TessayaUpcoming;
});

it.effect("lists every source in one order, soonest first, then what waits on something", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const list = yield* (yield* upcoming).list({});
    assert.deepStrictEqual(
      list.items.map((i) => [i.id, i.at === null ? null : (i.at - NOW) / MIN]),
      [
        ["house:tessaya_temporary_1", 20],
        ["reminder:r1", 95],
        ["task:ci", 170],
        ["task:once", 300],
        ["move:thread:t1", null],
        ["house:tessaya_device_2", null],
        ["rule:rule-1", null],
      ],
    );
    assert.deepStrictEqual(list.unreadable, []);
  }).pipe(Effect.provide(layer));
});

it.effect("sends each change to the item's owner, and moves only what has one time", () => {
  const { calls, layer } = setup();
  return Effect.gen(function* () {
    const u = yield* upcoming;
    const change = (id: string, op: "cancel" | "pause" | "resume" | "move", inMinutes?: number) =>
      u.change({ id, op, ...(inMinutes === undefined ? {} : { inMinutes }) }, by);
    yield* change("house:tessaya_temporary_1", "move", 15);
    yield* change("house:tessaya_temporary_1", "cancel");
    yield* change("house:tessaya_device_2", "pause");
    yield* change("reminder:r1", "move", 30);
    yield* change("reminder:r1", "cancel");
    yield* change("task:once", "move", 60);
    yield* change("task:ci", "pause");
    yield* change("task:ci", "cancel");
    yield* change("rule:rule-1", "pause");
    yield* change("move:thread:t1", "cancel");
    assert.deepStrictEqual(calls, [
      "house move tessaya_temporary_1 15",
      "house delete tessaya_temporary_1",
      "house pause tessaya_device_2",
      `reminder r1 open ${NOW + 30 * MIN}`,
      "reminder r1 dropped " + (NOW + 95 * MIN),
      `task once once ${60 * MIN}`,
      "task enabled ci false",
      "task delete ci",
      "rule rule-1 disabled",
      "move cancel t1",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses in a sentence what a source cannot do, and changes nothing", () => {
  const { calls, layer } = setup();
  return Effect.gen(function* () {
    const u = yield* upcoming;
    const refused = (id: string, op: "cancel" | "pause" | "resume" | "move") =>
      Effect.map(Effect.flip(u.change({ id, op, inMinutes: 10 }, by)), (e) => e.reason);
    assert.strictEqual(
      yield* refused("task:ci", "move"),
      "It repeats (every 4 h); change its schedule in Scheduled tasks.",
    );
    assert.strictEqual(
      yield* refused("rule:rule-1", "cancel"),
      "A rule can be switched off, not deleted.",
    );
    assert.strictEqual(
      yield* refused("house:tessaya_device_2", "move"),
      "It waits on something, not a time, so there is no time to move.",
    );
    assert.strictEqual(
      yield* refused("reminder:r1", "pause"),
      "A reminder cannot be paused; move it or cancel it.",
    );
    assert.strictEqual(yield* refused("rule:rule-1", "resume"), "It is not paused.");
    assert.strictEqual(yield* refused("house:gone", "cancel"), "That is no longer coming up.");
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("names a source it could not read and still lists the rest", () => {
  const { layer } = setup(
    Layer.succeed(HomeAssistantService, {
      automations: () =>
        Effect.fail(new HomeRefusedError({ why: "Home Assistant is unreachable." })),
    } as never),
  );
  return Effect.gen(function* () {
    const list = yield* (yield* upcoming).list({});
    assert.deepStrictEqual(list.unreadable, ["the house"]);
    assert.isTrue(list.items.some((i) => i.id === "reminder:r1"));
  }).pipe(Effect.provide(layer));
});
