import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { houseZone } from "./houseZone.ts";
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
