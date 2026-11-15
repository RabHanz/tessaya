import { zoneOf } from "@t3tools/tessaya-shared/brain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { TessayaMemoryService } from "./TessayaMemoryService.ts";

/**
 * The household's zone for anything said or scheduled: Home Assistant's, else the one his own devices taught memory,
 * else the device's, else this machine's. Never UTC because Home Assistant is off.
 */
export const houseZone = Effect.fn("houseZone")(function* (deviceZone?: string) {
  const home = yield* Effect.serviceOption(HomeAssistantService);
  const memory = yield* Effect.serviceOption(TessayaMemoryService);
  return zoneOf(
    Option.isSome(home) ? yield* home.value.timeZone : null,
    Option.isSome(memory) ? yield* memory.value.meta("timeZone") : null,
    deviceZone,
  );
});
