import type { TessayaCommitment } from "@t3tools/tessaya-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { HomeDevices } from "../home/HomeDevices.ts";
import { TessayaAlarms, make } from "./TessayaAlarms.ts";
import { TessayaCommitmentService } from "./TessayaCommitmentService.ts";

const setup = () => {
  const rows = new Map<string, TessayaCommitment>();
  const sent: Array<string> = [];
  const commitments = Layer.mock(TessayaCommitmentService)({
    list: Effect.sync(() => [...rows.values()]),
    upsert: (items) =>
      Effect.sync(() => {
        for (const c of items) rows.set(c.id, c);
        return items.length;
      }),
  });
  const devices = Layer.mock(HomeDevices)({
    command: (id, c) =>
      Effect.sync(() => {
        sent.push(
          `${id} ${c.op === "volume" ? `volume ${String(c.to)}` : c.op === "say" ? `say ${c.text}` : c.op}`,
        );
        return { status: "done" as const, line: "" };
      }),
  });
  const home = Layer.mock(HomeAssistantService)({
    devices: Effect.succeed([{ deviceId: "r1-his" }] as never),
    timeZone: Effect.succeed("Asia/Karachi"),
  });
  const layer = Layer.effect(TessayaAlarms, make).pipe(
    Layer.provide(Layer.mergeAll(commitments, devices, home)),
  );
  return { rows, sent, layer };
};

it.effect(
  "wakes him at the time he said, softly then louder, on his Tessel, until he stops it (M-108, 20 Nov 07:27)",
  () => {
    const { rows, sent, layer } = setup();
    return Effect.gen(function* () {
      // 07:27 in Karachi: "wake me up around 8:45".
      yield* TestClock.setTime(Date.parse("2026-11-20T02:27:00Z"));
      const alarms = yield* TessayaAlarms;
      const set = yield* alarms.set({ clock: "08:45" });
      assert.strictEqual(set.line, "Waking you at 8:45 am, in about an hour.");
      // Durable and in Coming up: one of her open commitments, due at 8:45.
      assert.deepInclude([...rows.values()][0]!, {
        due: Date.parse("2026-11-20T03:45:00Z"),
        status: "open",
      });
      yield* alarms.tick;
      assert.deepStrictEqual(sent, []);
      yield* TestClock.adjust("78 minutes");
      yield* alarms.tick;
      assert.deepStrictEqual(sent, [
        "r1-his volume 25",
        "r1-his say Good morning. It's 8:45 am. Time to get up.",
      ]);
      yield* TestClock.adjust("1 minute");
      yield* alarms.tick;
      assert.include(sent, "r1-his volume 40");
      // "Snooze": quiet for nine minutes, then soft again.
      assert.strictEqual((yield* alarms.snooze()).line, "Snoozed for 9 minutes.");
      sent.length = 0;
      yield* TestClock.adjust("5 minutes");
      yield* alarms.tick;
      assert.deepStrictEqual(sent, []);
      yield* TestClock.adjust("4 minutes");
      yield* alarms.tick;
      assert.include(sent, "r1-his volume 25");
      // "I'm up": stopped, closed, and never rings again.
      assert.strictEqual((yield* alarms.stop).line, "Stopped your 8:55 am alarm.");
      assert.strictEqual([...rows.values()][0]!.status, "done");
      sent.length = 0;
      yield* TestClock.adjust("5 minutes");
      yield* alarms.tick;
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "one due while her brain was down rings late and says so, and hours late is missed",
  () => {
    const { rows, sent, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-20T02:27:00Z"));
      const alarms = yield* TessayaAlarms;
      yield* alarms.set({ inMinutes: 10 });
      yield* TestClock.adjust("16 minutes");
      yield* alarms.tick;
      assert.isTrue(sent.some((s) => s.includes("sorry I'm late")));
      yield* alarms.stop;
      yield* alarms.set({ inMinutes: 10 });
      sent.length = 0;
      yield* TestClock.adjust("3 hours");
      yield* alarms.tick;
      assert.deepStrictEqual(sent, []);
      assert.isTrue([...rows.values()].some((c) => c.status === "dropped"));
    }).pipe(Effect.provide(layer));
  },
);
