import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";

export const LIVENESS_INTERVAL = Duration.seconds(15);
export const LIVENESS_DEADLINE = Duration.seconds(5);
export const LIVENESS_MISSES = 4;

/**
 * Returns once a ready backend has missed LIVENESS_MISSES timed requests in a row. A wedged server
 * keeps its process alive and its port listening, so only a real round trip shows it stopped.
 * There is no sleep gate: a laptop sleep freezes this loop too, and costs at most one miss.
 */
export const awaitBackendUnresponsive = Effect.fn("desktop.backendLiveness.awaitUnresponsive")(
  function* (url: URL) {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    let misses = 0;
    while (misses < LIVENESS_MISSES) {
      yield* Effect.sleep(LIVENESS_INTERVAL);
      const answered = yield* client
        .get(url)
        .pipe(Effect.timeout(LIVENESS_DEADLINE), Effect.isSuccess);
      misses = answered ? 0 : misses + 1;
    }
  },
);
