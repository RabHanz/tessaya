import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export type VisibilitySource = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

const shown = (doc: VisibilitySource) =>
  Effect.callback<void>((resume) => {
    const onChange = () => {
      if (doc.visibilityState !== "hidden") resume(Effect.void);
    };
    doc.addEventListener("visibilitychange", onChange);
    return Effect.sync(() => doc.removeEventListener("visibilitychange", onChange));
  });

/**
 * For streams of whole states, where a consumer behind the producer only needs the newest. While the page is hidden it
 * gets at most one state per `everyMs`, and a page shown again catches up at once: a hidden window streaming a busy
 * thread re-rendered on every event (B-041).
 */
export const holdWhileHidden =
  (everyMs: number, doc: VisibilitySource | undefined = globalThis.document) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    doc === undefined
      ? self
      : self.pipe(
          Stream.buffer({ capacity: 1, strategy: "sliding" }),
          Stream.flatMap((state) =>
            Stream.concat(
              Stream.succeed(state),
              Stream.fromEffect(
                doc.visibilityState === "hidden"
                  ? Effect.race(Effect.sleep(everyMs), shown(doc))
                  : Effect.void,
              ).pipe(Stream.drain),
            ),
          ),
        );
