import { it } from "@effect/vitest";
import type { ClaudeLiveSession } from "@t3tools/baton-contracts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect } from "vite-plus/test";

import type { BatonEngineShape } from "./BatonEngine.ts";
import { makeSessionHomes } from "./SessionHomes.ts";
import { readSessionsFile, writeSessionsFile, type SessionHome } from "./TessayaSessionsFile.ts";

const home: SessionHome = {
  threadId: "t1",
  title: "Pricing",
  sessionId: "s-1",
  cwd: "/work/app",
  configDir: "/cfg/work",
  instanceId: "claude-work",
  model: "claude-opus",
  inTerminal: false,
  openedAt: 0,
};

const session = {
  sessionId: "s-1",
  status: "idle",
  herdrPane: "fab-app~w1:p2",
} as ClaudeLiveSession;

describe("a Tessaya thread whose session runs in a terminal", () => {
  it.effect(
    "is put on that terminal session, found by session id, and remembered in the file",
    () =>
      Effect.gen(function* () {
        const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-homes-"));
        writeSessionsFile(NodePath.join(stateDir, "tessaya-sessions.json"), [home]);
        const written: Array<OrchestrationV2DomainEvent> = [];
        const engine = {
          threadShell: () => Effect.succeed({ activeRunId: null }),
          appThread: () => Effect.succeed({ id: "t1" }),
          writeEvents: (input: { events: ReadonlyArray<OrchestrationV2DomainEvent> }) =>
            Effect.sync(() => (written.push(...input.events), input.events.length)),
        } as unknown as BatonEngineShape;
        const homes = makeSessionHomes({
          engine,
          stateDir,
          instances: Effect.succeed({}),
          log: () => {},
          live: { driver: "acpRegistry", model: "live" },
        });
        expect(homes.ofSession("s-1")?.threadId).toBe("t1");
        yield* homes.link([session]);
        expect(written.map((event) => [event.type, event.providerInstanceId])).toEqual([
          ["provider-thread.updated", "baton-live"],
          ["thread.provider-switched", "baton-live"],
        ]);
        expect(readSessionsFile(homes.path)[0]?.inTerminal).toBe(true);
        // Still running next tick: nothing more is written.
        yield* homes.link([session]);
        expect(written).toHaveLength(2);
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }),
  );
});
