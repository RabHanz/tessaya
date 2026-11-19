import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { makePoolReader } from "./AccountPoolService.ts";

describe("the account pool on a machine without cswap", () => {
  it.effect("tries the spawn again only after five minutes, not on every fleet poll", () =>
    Effect.gen(function* () {
      let spawns = 0;
      const read = makePoolReader(
        ChildProcessSpawner.make(() => {
          spawns += 1;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "cswap missing",
            }),
          );
        }),
      );
      const claude = ProviderDriverKind.make("claudeAgent");
      const detail = () =>
        read(claude).pipe(
          Effect.flip,
          Effect.map((error) => (error as { detail?: string }).detail),
        );
      expect(yield* detail()).toBe("no account switcher is installed here (cswap)");
      expect(yield* detail()).toBe("no account switcher is installed here (cswap)");
      expect(spawns).toBe(1);
      yield* TestClock.adjust("5 minutes");
      yield* detail();
      expect(spawns).toBe(2);
    }),
  );
});
