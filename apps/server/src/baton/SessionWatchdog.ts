/**
 * The server's own watch clock, once a minute: resume what died mid-turn (the rules are in AutoResume.ts), and put
 * each new finding of the watch in the Record, so one seen with no desktop up is still reported (D1).
 */
import { freshFindings } from "@t3tools/baton-shared/attention";
import { findingRecord, watchFleet } from "@t3tools/baton-shared/watch";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BatonRecordService } from "./BatonRecordService.ts";
import { BatonSessionCatalogService } from "./BatonSessionCatalogService.ts";
import * as FleetQuery from "./FleetQuery.ts";

/** A finding already in the Record this recently is not written again after a restart. */
const SEEN_MS = 6 * 3_600_000;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* BatonSessionCatalogService;
    const record = yield* BatonRecordService;
    const since = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - SEEN_MS),
    );
    let noted: ReadonlySet<string> = new Set(
      (yield* record.query({ kind: "watch", since, limit: 500 })).map(
        (r) => `${r.ref}:${r.outcome}`,
      ),
    );
    const noteFindings = Effect.gen(function* () {
      const fleet = yield* FleetQuery.getFleet({});
      // A death is already in the Record as the watchdog's own row; a session waiting on him is not.
      const waiting = (yield* catalog.watchFindings).filter((f) => f.kind === "unanswered");
      const { fresh, next } = freshFindings(
        [...watchFleet(fleet.entries, yield* Clock.currentTimeMillis), ...waiting],
        noted,
      );
      noted = next;
      for (const f of fresh) yield* record.append(findingRecord(f));
    });
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep("60 seconds").pipe(
          Effect.andThen(catalog.watchdog({ action: "run" })),
          Effect.andThen(noteFindings),
          Effect.catchCause((cause) => Effect.logWarning("Tessaya watch clock failed", cause)),
        ),
      ),
    );
  }),
);
