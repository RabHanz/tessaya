import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as CurrentPersona from "./CurrentPersona.ts";

it.effect(
  "tells listeners only when a person's persona changes, and forgets it with the conversation",
  () =>
    Effect.gen(function* () {
      const current = yield* CurrentPersona.CurrentPersona;
      const heard: Array<string> = [];
      yield* current.listen((conversation, persona) =>
        Effect.sync(() => void heard.push(`${conversation}=${persona}`)),
      );
      yield* current.set("person:owner", "engineering");
      yield* current.set("person:owner", "engineering");
      yield* current.set("person:maya", "operations");
      yield* current.set("person:owner", "executive");
      expect(heard).toEqual([
        "person:owner=engineering",
        "person:maya=operations",
        "person:owner=executive",
      ]);
      expect(yield* current.of("person:owner")).toBe("executive");
      yield* TestClock.adjust("11 minutes");
      expect(yield* current.of("person:owner")).toBeNull();
      yield* current.set("person:owner", "executive");
      expect(heard.at(-1)).toBe("person:owner=executive");
    }).pipe(Effect.provide(CurrentPersona.layer)),
);
