/**
 * The server's own watch clock, once a minute: resume what died mid-turn (the rules are in AutoResume.ts), and put
 * each new finding of the watch in the Record, so one seen with no desktop up is still reported (D1).
 */
import {
  findingRecord,
  watchFleet,
  watchRecordStart,
  watchRecordStep,
} from "@t3tools/tessaya-shared/watch";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { answerOpenRequest, takeOpenRequests } from "./TessayaSessionsFile.ts";

import { TessayaRecordService } from "./TessayaRecordService.ts";
import { TessayaSessionCatalogService } from "./TessayaSessionCatalogService.ts";
import * as FleetQuery from "./FleetQuery.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* TessayaSessionCatalogService;
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    // `tessaya resume --force` with the server up asks here; the turn is stopped through the orchestrator.
    if (Option.isSome(config)) {
      const stateDir = config.value.stateDir;
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep("2 seconds").pipe(
            Effect.andThen(
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                Effect.forEach(
                  takeOpenRequests(stateDir, now),
                  (request) =>
                    catalog.openInTerminal({ threadId: request.threadId, stopTurn: true }).pipe(
                      // Acted on first; only then the answer the CLI prints.
                      Effect.tap((result) =>
                        Effect.sync(() => answerOpenRequest(stateDir, request.id, result)),
                      ),
                      Effect.catchCause((cause) =>
                        Effect.sync(() =>
                          answerOpenRequest(stateDir, request.id, {
                            state: "refused",
                            detail: `Tessaya could not open it: ${String(cause).slice(0, 200)}`,
                          }),
                        ),
                      ),
                      Effect.ignoreCause,
                    ),
                  { discard: true },
                ),
              ),
            ),
          ),
        ),
      );
    }
    const record = yield* TessayaRecordService;
    let state = watchRecordStart(
      yield* record
        .query({ kind: "watch", limit: 500 })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.as(Effect.logWarning("Tessaya watch could not read the Record", cause), []),
          ),
        ),
    );
    const noteFindings = Effect.gen(function* () {
      const fleet = yield* FleetQuery.getFleet({});
      // A death is already in the Record as the watchdog's own row; a session waiting on him is not.
      const waiting = (yield* catalog.watchFindings).filter((f) => f.kind === "unanswered");
      const now = yield* Clock.currentTimeMillis;
      const step = watchRecordStep([...watchFleet(fleet.entries, now), ...waiting], state, now);
      for (const f of step.write) yield* record.append(findingRecord(f));
      state = step.next;
    });
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep("60 seconds").pipe(
          Effect.andThen(
            catalog
              .watchdog({ action: "run" })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Tessaya auto-resume watchdog failed", cause),
                ),
              ),
          ),
          Effect.andThen(
            noteFindings.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Tessaya watch findings were not recorded", cause),
              ),
            ),
          ),
        ),
      ),
    );
  }),
);
