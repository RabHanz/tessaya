// @effect-diagnostics globalConsole:off globalConsoleInEffect:off
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { DEFAULT_POOLS, makeWith, type TurnClass } from "./TurnPools.ts";

/** A spoken turn on the brain: first audio after FIRST_MS, done after TURN_MS (the R1's warm route, 13 Nov logs). */
const FIRST_MS = 700;
const TURN_MS = 1500;
/** One unit of consolidation or re-embedding. */
const BATCH_UNIT_MS = 500;
/** Time to first audio each vessel kind must keep (§2.0a). */
const BUDGET_MS = { device: 1500, phone: 1500, desktop: 2500 } as const;

interface Vessel {
  readonly id: string;
  readonly kind: keyof typeof BUDGET_MS;
  readonly startMs: number;
  readonly turns: number;
  /** Quiet between his turns on this vessel. */
  readonly gapMs: number;
}

const quantile = (xs: ReadonlyArray<number>, q: number) =>
  xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;

/** N vessels talking to one brain while consolidation runs; time to first audio per vessel. */
const loadTest = (vessels: ReadonlyArray<Vessel>, brain = DEFAULT_POOLS.brain!) =>
  Effect.gen(function* () {
    const pools = yield* makeWith({ brain });
    const ttfa = new Map<string, Array<number>>();
    const batchWaits: Array<number> = [];
    /** One spoken turn: queued for a brain slot, first audio after FIRST_MS, then his pause before the next. */
    const turn = (v: Vessel) =>
      Effect.gen(function* () {
        const asked = yield* Clock.currentTimeMillis;
        let heard = 0;
        yield* pools.run(
          "brain",
          { vessel: v.id, class: "interactive" },
          Effect.gen(function* () {
            yield* Effect.sleep(FIRST_MS);
            heard = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(TURN_MS - FIRST_MS);
          }),
        );
        ttfa.set(v.id, [...(ttfa.get(v.id) ?? []), heard - asked]);
        yield* Effect.sleep(v.gapMs);
      });
    const speak = (v: Vessel) =>
      Effect.sleep(v.startMs).pipe(
        Effect.andThen(
          Effect.forEach(Array.from({ length: v.turns }), () => turn(v), { discard: true }),
        ),
      );
    /** Consolidation, one unit after another for as long as the test runs. */
    const unit = Effect.gen(function* () {
      const queued = yield* Clock.currentTimeMillis;
      yield* pools.run(
        "brain",
        { vessel: "consolidation", class: "batch" as TurnClass },
        Effect.gen(function* () {
          batchWaits.push((yield* Clock.currentTimeMillis) - queued);
          yield* Effect.sleep(BATCH_UNIT_MS);
        }),
      );
    });
    const batch = Effect.forever(unit);
    const hog = yield* Effect.forkChild(batch);
    const talking = yield* Effect.forkChild(
      Effect.forEach(vessels, speak, { concurrency: "unbounded" }),
    );
    // In small steps: a slot handed over resumes its fiber on the next tick, and must sleep on the clock it sees then.
    for (let ms = 0; ms < 10 * 60_000; ms += 50) yield* TestClock.adjust(50);
    yield* Fiber.join(talking);
    yield* Fiber.interrupt(hog);
    return {
      perVessel: vessels.map((v) => {
        const xs = ttfa.get(v.id) ?? [];
        return { ...v, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), n: xs.length };
      }),
      batchUnits: batchWaits.length,
    };
  });

const house: ReadonlyArray<Vessel> = [
  { id: "kitchen", kind: "device", startMs: 0, turns: 8, gapMs: 3000 },
  { id: "study", kind: "device", startMs: 150, turns: 8, gapMs: 4000 },
  { id: "kids-room", kind: "device", startMs: 300, turns: 8, gapMs: 2500 },
  { id: "phone", kind: "phone", startMs: 450, turns: 8, gapMs: 5000 },
  { id: "desktop", kind: "desktop", startMs: 600, turns: 8, gapMs: 3500 },
];

it.effect(
  "five vessels talking at once all stay within their first-audio budget, with consolidation running",
  () =>
    Effect.gen(function* () {
      const { perVessel, batchUnits } = yield* loadTest(house);
      for (const v of perVessel)
        console.log(
          `load test ${v.id}: p50 ${v.p50} ms, p95 ${v.p95} ms to first audio over ${v.n}`,
        );
      for (const v of perVessel) {
        assert.strictEqual(v.n, v.turns);
        assert.isAtMost(v.p95, BUDGET_MS[v.kind], v.id);
      }
      // Fair: no vessel's p95 more than 1.5x another's.
      const p95s = perVessel.map((v) => v.p95);
      assert.isAtMost(Math.max(...p95s), 1.5 * Math.min(...p95s));
      // Consolidation still moved, in the slots the turns left.
      assert.isAbove(batchUnits, 0);
    }),
);

it.effect("a chatty vessel takes its turn and never starves the others", () =>
  Effect.gen(function* () {
    const { perVessel } = yield* loadTest(
      [
        // Back to back, no pause, on a pool of two slots, one kept for turns.
        { id: "chatty", kind: "device", startMs: 0, turns: 20, gapMs: 0 },
        { id: "quiet-1", kind: "device", startMs: 100, turns: 3, gapMs: 4000 },
        { id: "quiet-2", kind: "device", startMs: 200, turns: 3, gapMs: 4000 },
      ],
      { slots: 2, reserved: 1 },
    );
    const quiet = perVessel.filter((v) => v.id !== "chatty");
    // A quiet vessel waits at most for the one turn ahead of it, never behind the chatty one's queue.
    for (const v of quiet) assert.isAtMost(v.p95, FIRST_MS + TURN_MS, v.id);
  }),
);

it.effect(
  "an interactive turn waits for at most one batch unit, and batch never takes the reserved slot",
  () =>
    Effect.gen(function* () {
      const { perVessel } = yield* loadTest(
        [{ id: "kitchen", kind: "device", startMs: 250, turns: 5, gapMs: 1000 }],
        { slots: 1, reserved: 1 },
      );
      // One slot, reserved for turns: consolidation never runs ahead of him, so he never waits.
      assert.strictEqual(perVessel[0]!.p95, FIRST_MS);
    }),
);

it.effect(
  "personas take turns within a class, and one thread has one turn in flight while other threads go ahead (CS5)",
  () =>
    Effect.gen(function* () {
      const pools = yield* makeWith({ brain: { slots: 2, reserved: 0 } });
      const order: string[] = [];
      const holds = new Map<string, Deferred.Deferred<void>>();
      const turn = (id: string, vessel: string, persona: string, thread: string) =>
        Effect.gen(function* () {
          const hold = yield* Deferred.make<void>();
          holds.set(id, hold);
          return yield* Effect.forkChild(
            pools.run(
              "brain",
              { vessel, class: "interactive", persona, thread },
              Effect.sync(() => order.push(id)).pipe(Effect.andThen(Deferred.await(hold))),
            ),
          );
        });
      const done = (id: string) => Deferred.succeed(holds.get(id)!, undefined);
      const a = yield* turn("a", "kitchen", "freya", "kitchen|freya|sara");
      // His second sentence on the same thread waits for the first; another thread takes the free slot.
      const again = yield* turn("a2", "kitchen", "freya", "kitchen|freya|sara");
      const other = yield* turn("b", "study", "freya", "study|freya|owner");
      yield* Effect.yieldNow;
      assert.deepStrictEqual(order, ["a", "b"]);
      // Both slots busy: two more Freya turns queue, then an Alfred one.
      const f1 = yield* turn("f1", "phone", "freya", "phone|freya|omar");
      const f2 = yield* turn("f2", "hall", "freya", "hall|freya|maya");
      const al = yield* turn("al", "phone", "alfred", "phone|alfred|omar");
      yield* Effect.yieldNow;
      yield* done("b");
      yield* Effect.yieldNow;
      // Freya was served last: Alfred goes next, though he asked last.
      assert.deepStrictEqual(order, ["a", "b", "al"]);
      yield* done("a");
      yield* Effect.yieldNow;
      // The thread's own second turn now runs, ahead of nothing it was not already behind.
      assert.include(order.slice(3), "a2");
      for (const id of ["al", "a2", "f1", "f2"]) yield* done(id);
      for (const f of [a, again, other, f1, f2, al]) yield* Fiber.join(f);
      assert.sameMembers(order, ["a", "b", "al", "a2", "f1", "f2"]);
    }),
);
