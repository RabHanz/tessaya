import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { projectRefWithin } from "./ProjectRef.ts";

it.effect("names a folder by its leaf when its repository does not answer in time", () =>
  Effect.gen(function* () {
    // A git probe on a slow disk held the laptop's whole fleet for 27-40 s (2026-11-08).
    const fiber = yield* projectRefWithin("/work/3D-Printer", "2 seconds").pipe(
      Effect.provideService(RepositoryIdentityResolver, { resolve: () => Effect.never }),
      Effect.forkChild,
    );
    yield* TestClock.adjust("2 seconds");
    assert.deepStrictEqual(yield* Fiber.join(fiber), {
      key: "dir:3d-printer",
      label: "3D-Printer",
    });
  }),
);
