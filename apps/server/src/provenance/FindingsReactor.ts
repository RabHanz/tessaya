/**
 * The gap detector's beat (B-046): every 15 minutes, the last day's log through `findGaps`. A finding not raised in the
 * last day becomes one Record `notice` (outcome "finding", ref = the event its trace starts from), which the pulse
 * weighs like any notice and agents read with `tessaya_activity findings` to file it. No model call.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { TessayaRecordService } from "../tessaya/TessayaRecordService.ts";
import { ActionLog } from "./ActionLog.ts";

const BEAT_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

const raiseFindings = Effect.fn("FindingsReactor.raise")(function* (raised: Map<string, number>) {
  const log = yield* ActionLog;
  const record = yield* TessayaRecordService;
  const now = yield* Clock.currentTimeMillis;
  for (const [key, at] of raised) if (now - at > DAY_MS) raised.delete(key);
  let count = 0;
  for (const f of yield* log.findings(now - DAY_MS)) {
    const key = `${f.rule}|${f.key}`;
    if (raised.has(key)) continue;
    raised.set(key, now);
    count++;
    yield* record.append({
      kind: "notice",
      actor: "provenance",
      ref: f.eventIds.at(-1) ?? null,
      subject: f.title,
      outcome: "finding",
      detail: `${f.rule}: ${f.count} time(s); trace: ${f.eventIds.join(", ")}`,
    });
  }
  return count;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const raised = new Map<string, number>();
    yield* raiseFindings(raised).pipe(
      Effect.catchCause((cause) => Effect.logWarning("provenance: findings failed", { cause })),
      Effect.repeat(Schedule.spaced(BEAT_MS)),
      Effect.delay("2 minutes"),
      Effect.forkScoped,
    );
  }),
);
