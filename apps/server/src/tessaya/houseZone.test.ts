import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { houseZone, onHouseClockText } from "./houseZone.ts";
import { TessayaMemoryService } from "./TessayaMemoryService.ts";

const memory = (zone: string | null) =>
  Layer.mock(TessayaMemoryService)({ origin: "test", meta: () => Effect.succeed(zone) });
const home = (zone: string | null) =>
  Layer.mock(HomeAssistantService)({ timeZone: Effect.succeed(zone) });

it.effect("says the time on his zone with Home Assistant off, never UTC", () =>
  Effect.gen(function* () {
    // 15 Nov: with Home Assistant off the Tessel said UTC; his devices had taught memory Karachi.
    expect(
      yield* houseZone("Etc/UTC").pipe(
        Effect.provide(Layer.merge(home(null), memory("Asia/Karachi"))),
      ),
    ).toBe("Asia/Karachi");
    expect(
      yield* houseZone().pipe(
        Effect.provide(Layer.merge(home("Europe/London"), memory("Asia/Karachi"))),
      ),
    ).toBe("Europe/London");
    // A zone a device sends is checked before any clock reads it.
    expect(
      yield* houseZone("Asia/Karachi").pipe(
        Effect.provide(Layer.merge(home(null), memory("Mars/Olympus"))),
      ),
    ).toBe("Asia/Karachi");
  }),
);

it("puts every UTC time in a tool's answer on his clock before she reads it", () => {
  // 19 Nov: device_registry's lastSeenAt "…21:48:43.687Z" came out of her as "9:48 p.m. UTC".
  expect(
    onHouseClockText(
      '{"online":true,"lastSeenAt":"2026-11-18T21:48:43.687Z","at":"2026-11-18T21:48Z","day":"2026-11-18"}',
      "Asia/Karachi",
    ),
  ).toBe(
    '{"online":true,"lastSeenAt":"2026-11-19T02:48:43+05:00","at":"2026-11-19T02:48:00+05:00","day":"2026-11-18"}',
  );
  // Already on a clock, or not a time: left alone.
  expect(onHouseClockText("2026-11-19T02:48:43+05:00 and v1.2Z", "Asia/Karachi")).toBe(
    "2026-11-19T02:48:43+05:00 and v1.2Z",
  );
});
