/**
 * Notices, from the thread's own events, that a job's worker has finished its plan (D145), so the
 * job moves to "waiting for your OK" (or starts, with his standing permission) without anyone asking.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { BatonEngine } from "./BatonEngine.ts";
import {
  autoRetry,
  enforceCaps,
  noteDayTurns,
  jobRecordSeed,
  noticePart,
  noticePlan,
  postReports,
  recordJobChanges,
} from "./BatonJobFlow.ts";
import * as FleetQuery from "./FleetQuery.ts";
import type * as ServerConfig from "../config.ts";
import type { AdoptedSessionService } from "./AdoptedSessionService.ts";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type { BatonJobService } from "./BatonJobService.ts";
import type { WorkSessionService } from "./WorkSessionService.ts";
import type { BatonMemoryService } from "./BatonMemoryService.ts";

export class BatonJobReactor extends Context.Service<
  BatonJobReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/baton/BatonJobReactor") {}

export const layer = Layer.effect(
  BatonJobReactor,
  Effect.gen(function* () {
    const engine = yield* BatonEngine;
    const context = yield* Effect.context<
      | BatonJobService
      | WorkSessionService
      | BatonEngine
      | ProviderRegistry.ProviderRegistry
      | AdoptedSessionService
      | ServerConfig.ServerConfig
      | BatonMemoryService
    >();
    return {
      start: Effect.fn("BatonJobReactor.start")(function* () {
        const seen = yield* jobRecordSeed().pipe(Effect.provideContext(context));
        // When a job's change was last said on an R1, for the hourly nudge budget.
        const said: Array<number> = [];
        // A worker that has used up its time or turns is stopped, even if it makes no more events.
        yield* forkParked(
          Effect.forever(
            Effect.sleep("45 seconds").pipe(
              Effect.andThen(
                FleetQuery.getFleet({}).pipe(
                  Effect.flatMap((fleet) =>
                    enforceCaps(fleet.entries).pipe(
                      Effect.andThen(noteDayTurns(fleet.entries)),
                      Effect.andThen(autoRetry(fleet.entries)),
                      Effect.andThen(postReports(fleet.entries)),
                      Effect.andThen(recordJobChanges(fleet.entries, seen, said)),
                    ),
                  ),
                ),
              ),
              Effect.provideContext(context),
              Effect.ignoreCause({ log: true }),
            ),
          ),
        );
        yield* forkParked(
          Stream.runForEach(engine.changedThreads, (threadId) =>
            noticePlan(threadId).pipe(
              Effect.andThen(noticePart(threadId)),
              Effect.provideContext(context),
              Effect.ignoreCause({ log: true }),
            ),
          ),
        );
      }),
    };
  }),
);
