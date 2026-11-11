import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { awaitLauncherLoss } from "./launcherWatch.ts";

const launcherPid = 4100;
// Orphans are adopted by init or a subreaper, so the new parent is not always 1.
const subreaperPid = 1800;

const watch = (getParentPid: () => number, platform: NodeJS.Platform, startPid = launcherPid) =>
  awaitLauncherLoss({ launcherPid: startPid, getParentPid }).pipe(
    Effect.provideService(HostProcess.Platform, platform),
  );

it.effect("notices a launcher that was already gone when the watch began", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(watch(() => subreaperPid, "linux"));
    yield* Effect.yieldNow;
    yield* Fiber.join(fiber);
  }),
);

// Windows keeps the dead launcher's id as ppid, so only the launcher's liveness shows the loss.
it.effect("notices on Windows that the launcher died while its id stays the parent", () =>
  Effect.gen(function* () {
    let launcherAlive = true;
    const fiber = yield* Effect.forkChild(
      awaitLauncherLoss({
        launcherPid,
        getParentPid: () => launcherPid,
        isAlive: (pid) => pid === launcherPid && launcherAlive,
      }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );
    yield* TestClock.adjust(Duration.seconds(10));
    expect(fiber.pollUnsafe()).toBeUndefined();
    launcherAlive = false;
    yield* TestClock.adjust(Duration.seconds(2));
    expect(fiber.pollUnsafe()).toBeDefined();
  }),
);
