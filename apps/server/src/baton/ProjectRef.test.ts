import { assert, it } from "@effect/vitest";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { folderProjectRef, projectRefWithin } from "./ProjectRef.ts";

const printer: RepositoryIdentity = {
  canonicalKey: "github.com/someone/printer",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/someone/printer.git",
  },
  rootPath: "/work/3D-Printer",
  name: "printer",
};

it.effect("names a slow repository by its folder, then by its name once git has answered", () =>
  Effect.gen(function* () {
    let known = false;
    // Like the resolver's cache: the lookup that started keeps going, and later calls get its answer.
    const resolver = RepositoryIdentityResolver.of({
      resolve: () =>
        known
          ? Effect.succeed(printer)
          : Effect.sleep("5 seconds").pipe(
              Effect.andThen(Effect.sync(() => (known = true))),
              Effect.as(printer),
            ),
    });
    const within = projectRefWithin("/work/3D-Printer", "2 seconds").pipe(
      Effect.provideService(RepositoryIdentityResolver, resolver),
    );
    const first = yield* Effect.forkChild(within);
    yield* TestClock.adjust("2 seconds");
    assert.deepStrictEqual(yield* Fiber.join(first), {
      key: "dir:3d-printer",
      label: "3D-Printer",
    });
    yield* TestClock.adjust("3 seconds");
    const next = yield* Effect.forkChild(within);
    yield* TestClock.adjust("2 seconds");
    assert.deepStrictEqual(yield* Fiber.join(next), {
      key: "github.com/someone/printer",
      label: "printer",
    });
  }),
);

it("names a Windows folder by its last segment", () => {
  assert.deepStrictEqual(folderProjectRef("D:\\Downloads\\Development\\3D-Printer"), {
    key: "dir:3d-printer",
    label: "3D-Printer",
  });
});
