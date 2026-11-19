import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { holdWhileHidden, type VisibilitySource } from "./holdWhileHidden.ts";

const page = (hidden: boolean) => {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: hidden ? "hidden" : "visible",
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
  } as unknown as VisibilitySource & { visibilityState: DocumentVisibilityState };
  const show = () => {
    doc.visibilityState = "visible";
    for (const listener of listeners) listener();
  };
  return { doc, show };
};

describe("holdWhileHidden", () => {
  it.effect("a hidden page gets the newest state once per period, and catches up when shown", () =>
    Effect.gen(function* () {
      const { doc, show } = page(true);
      const input = yield* Queue.unbounded<number>();
      const seen = yield* Ref.make<Array<number>>([]);
      const fiber = yield* Stream.fromQueue(input).pipe(
        holdWhileHidden(5_000, doc),
        Stream.runForEach((n) => Ref.update(seen, (all) => [...all, n])),
        Effect.forkChild,
      );
      yield* Queue.offer(input, 1);
      yield* TestClock.adjust("1 second");
      for (const n of [2, 3, 4]) yield* Queue.offer(input, n);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(seen)).toEqual([1]);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Ref.get(seen)).toEqual([1, 4]);
      yield* Queue.offer(input, 5);
      yield* TestClock.adjust("1 second");
      show();
      yield* TestClock.adjust("1 millis");
      expect(yield* Ref.get(seen)).toEqual([1, 4, 5]);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("a visible page gets each state as it comes", () =>
    Effect.gen(function* () {
      const { doc } = page(false);
      const input = yield* Queue.unbounded<number>();
      const seen = yield* Ref.make<Array<number>>([]);
      const fiber = yield* Stream.fromQueue(input).pipe(
        holdWhileHidden(5_000, doc),
        Stream.runForEach((n) => Ref.update(seen, (all) => [...all, n])),
        Effect.forkChild,
      );
      for (const n of [1, 2, 3]) {
        yield* Queue.offer(input, n);
        yield* TestClock.adjust("1 millis");
      }
      expect(yield* Ref.get(seen)).toEqual([1, 2, 3]);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
