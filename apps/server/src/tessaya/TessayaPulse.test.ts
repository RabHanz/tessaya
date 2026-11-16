import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { BrainUsage } from "./BrainUsage.ts";
import { beat, react } from "./TessayaPulse.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaMemoryService } from "./TessayaMemoryService.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { TessayaPeople } from "./TessayaPeople.ts";
import { TessayaRecordService, layer as recordLayer } from "./TessayaRecordService.ts";

/** Which model each review asked ("haiku" first, undefined for the role's own), and what the fake answers. */
const asked: Array<string | undefined> = [];
const speak = {
  action: "speak",
  category: "sessions",
  member: null,
  text: "The build session has been waiting on you. Want me to look?",
  why: "it waits on him",
  about: ["wait:s1"],
  remindInMinutes: null,
};
const oneShot = Layer.succeed(TessayaOneShot, {
  run: ((input: { model?: string }) => {
    asked.push(input.model);
    return Effect.succeed(speak as never);
  }) as TessayaOneShot["Service"]["run"],
});
const base = recordLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const NOON = 12 * 3_600_000;
const DAY = 86_400_000;

const waiting = {
  kind: "notice",
  actor: "desktop",
  ref: "wait:s1",
  subject: "Build session",
  outcome: "session_waiting",
  detail: "Build session has been waiting for you 20 min.",
};

it.layer(base.pipe(Layer.provideMerge(oneShot)))("TessayaPulse", (it) => {
  it.effect(
    "spends no model call on routine events, reviews an urgent one, logs why, and learns from his reaction",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOON);
        const record = yield* TessayaRecordService;
        yield* beat();
        // Job news already said this one; a mood drift alone is too light: no review, no call.
        yield* TestClock.adjust("1 second");
        yield* record.append({
          kind: "job",
          actor: "w",
          ref: "j1",
          subject: "Docs",
          outcome: "done",
        });
        yield* TestClock.adjust("1 minute");
        assert.strictEqual((yield* beat()).decision, null);
        assert.deepStrictEqual(asked, []);

        yield* record.append(waiting);
        yield* TestClock.adjust("1 minute");
        const reviewed = yield* beat();
        // The cheap model first; a proposal to speak about something weighty is checked by the role's model.
        assert.deepStrictEqual(asked, ["haiku", undefined]);
        // No vessel to say it on here, so it is kept as a note, with the reason.
        assert.strictEqual(reviewed.decision?.action, "note");
        const [logged] = yield* record.query({ kind: "pulse", limit: 1 });
        assert.strictEqual(logged?.outcome, "note");
        assert.include(logged?.detail ?? "", "held:");

        // Reviewed once: the same event does not wake another review.
        yield* TestClock.adjust("30 minutes");
        assert.strictEqual((yield* beat()).decision, null);
        assert.strictEqual(asked.length, 2);
      }),
  );
});

const remembered: Array<{ text: string; sourceRef?: string | null }> = [];
const memory = Layer.succeed(TessayaMemoryService, {
  add: (draft: { text: string; sourceRef?: string | null }) => {
    remembered.push(draft);
    return Effect.succeed({} as never);
  },
  meta: () => Effect.succeed(null),
} as unknown as TessayaMemoryService["Service"]);
const people = Layer.succeed(TessayaPeople, {
  lastHeard: Effect.sync(() => [{ id: "p1", name: "Sara", lastAt: 5 * DAY, seen: 6 }]),
} as unknown as TessayaPeople["Service"]);

it.layer(base.pipe(Layer.provideMerge(memory), Layer.provideMerge(people)))(
  "TessayaPulse patterns",
  (it) => {
    it.effect("writes a confirmed pattern into the one memory once, with its provenance", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(20 * DAY);
        yield* beat();
        assert.strictEqual(remembered.length, 1);
        assert.include(remembered[0]?.text ?? "", "Sara has not been heard for 15 days");
        assert.include(remembered[0]?.text ?? "", "confidence 0.80");
        assert.strictEqual(remembered[0]?.sourceRef, "pulse:pattern:quiet:p1");
        // The next pattern pass still sees it, waiting to be raised or already raised: not written again.
        yield* TestClock.adjust("7 hours");
        yield* beat();
        assert.strictEqual(remembered.length, 1);
      }),
    );
  },
);

const budgetSpent = Layer.succeed(BrainUsage, {
  totals: () =>
    Effect.succeed([
      { feature: "pulse", calls: 48, input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 },
    ]),
} as unknown as BrainUsage["Service"]);

it.layer(base.pipe(Layer.provideMerge(oneShot), Layer.provideMerge(budgetSpent)))(
  "TessayaPulse budget",
  (it) => {
    it.effect(
      "goes rules-only near the daily cap: no model call, and only the urgent is kept",
      () =>
        Effect.gen(function* () {
          asked.length = 0;
          yield* TestClock.setTime(NOON);
          const record = yield* TessayaRecordService;
          yield* beat();
          yield* TestClock.adjust("1 second");
          yield* record.append(waiting);
          yield* TestClock.adjust("1 minute");
          const result = yield* beat();
          assert.deepStrictEqual(asked, []);
          assert.strictEqual(result.decision?.action, "nothing");
          assert.include(result.decision?.why ?? "", "budget");
          // His reaction reaches the gate through the Record.
          yield* record.append({
            kind: "pulse",
            actor: "Tessaya",
            ref: "pulse:1",
            subject: "x",
            outcome: "speak",
            detail: "category: sessions",
          });
          assert.include(yield* react("told_off"), "sessions");
          yield* TestClock.adjust("1 minute");
          assert.strictEqual((yield* beat()).state.learned.sessions, -0.4);
          // From Settings, a reaction names its row; a reaction row is never itself reacted to.
          const [decided] = (yield* record.query({ kind: "pulse", limit: 10 })).filter(
            (r) => r.outcome === "nothing",
          );
          assert.include(yield* react("liked", decided!.id), "keep raising");
          const [liked] = yield* record.query({ kind: "pulse", limit: 1 });
          assert.strictEqual(liked?.outcome, "liked");
          assert.include(liked?.detail ?? "", `row: ${decided!.id}`);
          assert.strictEqual(yield* react("stop", liked!.id), "I can't find that one.");
        }),
    );
  },
);
