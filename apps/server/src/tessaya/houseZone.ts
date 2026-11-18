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

/** A time as ISO with the zone's own offset ("2026-11-13T08:26:31+05:00"). */
export const isoIn = (ms: number, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  const offset = String(parts["timeZoneName"]).replace("GMT", "") || "+00:00";
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}${offset}`;
};

/** An ISO instant in UTC ("2026-11-18T21:48:43.687Z"), as storage and tool rows write it. */
const UTC_INSTANT = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)Z\b/g;

/**
 * A tool's answer with every UTC instant put on the house's clock, before a model reads it: a "Z" time read aloud
 * came out as "9:48 p.m. UTC" (19 Nov), and he never wants UTC.
 */
export const onHouseClockText = (text: string, timeZone: string): string =>
  text.replace(UTC_INSTANT, (found) => {
    const ms = Date.parse(found);
    return Number.isNaN(ms) ? found : isoIn(ms, timeZone);
  });
