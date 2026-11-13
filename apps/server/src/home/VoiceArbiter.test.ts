import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as BatonDatabaseMemory } from "../baton/BatonDatabase.ts";
import { VoiceArbiter, layer as arbiterLayer } from "./VoiceArbiter.ts";

const layer = arbiterLayer.pipe(Layer.provideMerge(BatonDatabaseMemory));
const claim = (deviceId: string, loudnessDb: number, wakeScore = 0.9, answerHere = false) => ({
  deviceId,
  loudnessDb,
  wakeScore,
  answerHere,
});

/** Several pretend vessels claim at once; the window closes; each gets its verdict. */
const round = (claims: ReadonlyArray<ReturnType<typeof claim>>) =>
  Effect.gen(function* () {
    const arbiter = yield* VoiceArbiter;
    const fibers = yield* Effect.forEach(claims, (c) =>
      arbiter.claim(c).pipe(Effect.forkChild({ startImmediately: true })),
    );
    yield* TestClock.adjust("250 millis");
    return yield* Effect.forEach(fibers, Fiber.join);
  });

it.effect("two R1s and a desktop hear him at once: exactly one answers, the loudest", () =>
  Effect.gen(function* () {
    const verdicts = yield* round([
      claim("r1-kitchen", -38),
      claim("r1-office", -24),
      claim("desktop-laptop", -31),
    ]);
    assert.deepStrictEqual(
      verdicts.map((v) => v.answer),
      [false, true, false],
    );
    for (const v of verdicts) if (!v.answer) assert.strictEqual(v.winner, "r1-office");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "the others stay quiet while she answers and 2 s after, and the device he just used keeps the next turn",
  () =>
    Effect.gen(function* () {
      const arbiter = yield* VoiceArbiter;
      yield* round([claim("r1-kitchen", -40), claim("desktop-laptop", -20)]);
      const now = yield* Clock.currentTimeMillis;
      yield* arbiter.speaking("desktop-laptop", now + 5_000);
      // Her voice from the desktop wakes the R1: it yields at once, no round.
      const echo = yield* arbiter.claim(claim("r1-kitchen", -15, 1));
      assert.isFalse(echo.answer);
      yield* arbiter.ended("desktop-laptop");
      yield* TestClock.adjust("1 second");
      assert.isFalse((yield* arbiter.claim(claim("r1-kitchen", -15))).answer);
      yield* TestClock.adjust("1500 millis");
      // Quiet over; the desktop answered within 2 minutes, so it keeps him though the R1 is louder now.
      const next = yield* round([claim("r1-kitchen", -10), claim("desktop-laptop", -45)]);
      assert.deepStrictEqual(
        next.map((v) => v.answer),
        [false, true],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("his primary wins over loudness, and 'answer here' overrides once", () =>
  Effect.gen(function* () {
    const arbiter = yield* VoiceArbiter;
    yield* arbiter.setPrimary("r1-kitchen");
    const first = yield* round([claim("r1-kitchen", -50), claim("r1-office", -10)]);
    assert.deepStrictEqual(
      first.map((v) => v.answer),
      [true, false],
    );
    yield* arbiter.ended("r1-kitchen");
    yield* TestClock.adjust("3 seconds");
    const here = yield* round([claim("r1-kitchen", -50), claim("r1-office", -60, 0.5, true)]);
    assert.deepStrictEqual(
      here.map((v) => v.answer),
      [false, true],
    );
    assert.strictEqual((yield* arbiter.state).primary, "r1-kitchen");
  }).pipe(Effect.provide(layer)),
);
