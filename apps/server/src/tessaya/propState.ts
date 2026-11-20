/**
 * What is going on now, as a body's prop reads it (expressionMap.ts PropState): what he pinned, an agent job building,
 * his private layer open on that vessel, and the household's hour. renderFor decides; this only gathers.
 */
import type { PropState } from "@t3tools/tessaya-shared/expressionMap";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSettingsService } from "../serverSettings.ts";
import { houseZone } from "./houseZone.ts";
import { PersonaLayers } from "./PersonaLayers.ts";
import { TessayaJobService } from "./TessayaJobService.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

export const propStateFor = Effect.fn("TessayaProps.stateFor")(function* (vessel: string) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const pinned = Option.isSome(settings)
    ? yield* Effect.orElseSucceed(
        Effect.map(settings.value.getSettings, (s) => s.tessayaProp),
        () => "",
      )
    : "";
  const jobs = yield* Effect.serviceOption(TessayaJobService);
  const sessions = yield* Effect.serviceOption(WorkSessionService);
  // a job's session still active: an agent is at work (the team board's "current jobs")
  const building =
    Option.isSome(jobs) && Option.isSome(sessions)
      ? yield* Effect.gen(function* () {
          const terms = new Set((yield* jobs.value.allTerms()).map((t) => t.workSessionId));
          if (terms.size === 0) return false;
          const all = yield* Effect.orElseSucceed(sessions.value.list({}), () => []);
          return all.some((s) => s.status === "active" && terms.has(s.id));
        })
      : false;
  const layers = yield* Effect.serviceOption(PersonaLayers);
  const privateOpen =
    Option.isSome(layers) && layers.value.all.some((l) => l.active?.(vessel) === true);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: yield* houseZone(),
      hour: "numeric",
      hourCycle: "h23",
    }).format(yield* Clock.currentTimeMillis),
  );
  return {
    ...(pinned === "" ? {} : { pinned }),
    building,
    privateOpen,
    hour,
  } satisfies PropState;
});

/** Her brows over her fringe as he set them (`tessayaBrows`), as a body's `brows` cue reads it: null is the model's own. */
export const browsFor = Effect.fn("TessayaProps.browsFor")(function* () {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const set = Option.isSome(settings)
    ? yield* Effect.orElseSucceed(
        Effect.map(settings.value.getSettings, (s) => s.tessayaBrows),
        () => "auto" as const,
      )
    : "auto";
  return set === "auto" ? null : set === "on";
});
