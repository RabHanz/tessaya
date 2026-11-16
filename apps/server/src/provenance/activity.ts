/** Activity / Why (B-046): the reads behind Settings → Activity, `tessaya_activity` and her voice. */
import type {
  TessayaActivityListInput,
  TessayaActivityListResult,
  TessayaActivityWhyInput,
  TessayaActivityWhyResult,
} from "@t3tools/tessaya-contracts";
import { whyLines } from "@t3tools/tessaya-shared/provenance";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { ActionLog } from "./ActionLog.ts";

export const activityList = Effect.fn("Activity.list")(function* (
  input: TessayaActivityListInput,
): Effect.fn.Return<TessayaActivityListResult, never, ActionLog> {
  const log = yield* ActionLog;
  const since = (yield* Clock.currentTimeMillis) - (input.sinceMinutes ?? 60) * 60_000;
  const events = yield* log.list({
    since,
    kindPrefix: input.kind,
    actorKind: input.actor,
    outcome: input.outcome,
    text: input.text,
    limit: input.limit ?? 100,
  });
  return { events, findings: yield* log.findings(since), dropped: yield* log.dropped };
});

export const activityWhy = Effect.fn("Activity.why")(function* (
  input: TessayaActivityWhyInput,
): Effect.fn.Return<TessayaActivityWhyResult, never, ActionLog> {
  const log = yield* ActionLog;
  const id =
    input.id ??
    (yield* log.list({
      since: 0,
      text: input.text,
      limit: 1,
    }))[0]?.id;
  if (id === undefined)
    return { chain: [], effects: [], lines: ["Nothing like that is in the log."] };
  const chain = yield* log.trace(id);
  return { chain, effects: yield* log.effectsOf(id, 20), lines: whyLines(chain) };
});
