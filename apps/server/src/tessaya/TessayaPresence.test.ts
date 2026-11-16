import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { TessayaPresence, layer } from "./TessayaPresence.ts";

it.effect("faces hear an arrival, a return after a while, and a forget, as they happen", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
    const presence = yield* TessayaPresence;
    // Listening before the step, so the step's change is the one heard.
    const next = presence.changes.pipe(
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped({ startImmediately: true }),
    );
    const arrived = yield* next;
    yield* presence.note({ member: "sara", source: "voice", vessel: "tessel-1" });
    yield* Fiber.join(arrived);
    yield* TestClock.adjust("3 minutes");
    const back = yield* next;
    yield* presence.note({ member: "sara", source: "voice", vessel: "tessel-1" });
    yield* Fiber.join(back);
    const forgotten = yield* next;
    yield* presence.forget("sara");
    yield* Fiber.join(forgotten);
    assert.deepStrictEqual((yield* presence.estimate()).members, []);
  }).pipe(Effect.provide(layer)),
);
