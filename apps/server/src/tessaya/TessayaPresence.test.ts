import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { TessayaPresence, layer, peopleHere, whereToSay } from "./TessayaPresence.ts";

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

const device = (deviceId: string, kind: string) => ({
  deviceId,
  kind,
  name: deviceId,
  via: kind === "r1" ? "mqtt" : "client",
  online: true,
  values: [],
});
// Tumble in the lounge, his laptop and his phone; every one of them can speak.
const registry = DeviceRegistry.of({
  list: Effect.succeed([
    device("tumble", "r1"),
    device("laptop", "desktop"),
    device("phone-rab", "phone"),
  ]),
} as never);

describe("TessayaPresence across vessels (B-043)", () => {
  it.effect(
    "two members: each estimate apart, her lines to each one's vessel, nothing private before the other",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1000 minutes");
        const presence = yield* TessayaPresence;
        // He speaks to Tumble; Sara types on the laptop; his phone is in his pocket, then in his hand.
        yield* presence.note({ member: "owner", source: "voice", vessel: "tumble" });
        yield* presence.note({ member: "sara", source: "typed", vessel: "laptop" });
        const each = yield* presence.estimate();
        assert.deepStrictEqual(
          each.members.map((m) => [m.member, m.nearest?.vessel]),
          [
            ["owner", "tumble"],
            ["sara", "laptop"],
          ],
        );
        assert.strictEqual(yield* whereToSay("owner", null), "tumble");
        assert.strictEqual(yield* whereToSay("sara", null), "laptop");
        // Alone with him at Tumble: the private-output gate sees only him there.
        assert.deepStrictEqual(
          (yield* peopleHere("tumble")).map((p) => p.member),
          ["owner"],
        );
        // Twenty minutes on, he picks up his phone: her next line follows him there.
        yield* TestClock.adjust("20 minutes");
        yield* presence.note({ member: "owner", source: "phoneApp", vessel: "phone-rab" });
        assert.strictEqual(yield* whereToSay("owner", null), "phone-rab");
        // Sara walks to Tumble and speaks: it is no longer his alone, and her lines follow her there.
        yield* presence.note({ member: "sara", source: "voice", vessel: "tumble" });
        assert.deepStrictEqual(
          (yield* peopleHere("tumble")).map((p) => p.member),
          ["sara"],
        );
        assert.strictEqual(yield* whereToSay("sara", null), "tumble");
        // A meeting on her calendar: her own nudges go quiet, a reminder still lands where it was set.
        yield* presence.note({ member: "sara", source: "meeting", vessel: null });
        assert.isNull(yield* whereToSay("sara", null));
        assert.strictEqual(yield* whereToSay("sara", "laptop", "reminder"), "laptop");
      }).pipe(Effect.provide(layer), Effect.provideService(DeviceRegistry, registry)),
  );
});
