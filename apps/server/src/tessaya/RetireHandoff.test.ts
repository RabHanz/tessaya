import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { retireHandoff, retireToken, type RetirePorts } from "./RetireHandoff.ts";

const MAIN = "baton-live4:cc828d1b";
const TWIN = "baton-live4:a262f02b";

const fixture = (
  over: Partial<{
    mainInstance: string;
    running: boolean;
    switchWorks: boolean;
    twinRunning: boolean;
    twinArchived: boolean;
  }> = {},
) => {
  const calls: string[] = [];
  let instance = over.mainInstance ?? "claudeAgent";
  const ports: RetirePorts = {
    shell: (id) =>
      Effect.succeed(
        id === MAIN
          ? { instanceId: instance, running: over.running ?? false }
          : {
              instanceId: "baton-live",
              running: over.twinRunning ?? false,
              archived: over.twinArchived ?? false,
            },
      ),
    selectLive: (id) =>
      Effect.sync(() => {
        calls.push(`live:${id}`);
        if (over.switchWorks !== false) instance = "baton-live";
      }),
    activeInstance: () => Effect.succeed(instance),
    archive: (id) => Effect.sync(() => (calls.push(`archive:${id}`), true)),
    remove: (id) => Effect.sync(() => (calls.push(`delete:${id}`), true)),
    writeUndo: () => (calls.push("undo"), "/tmp/undo.json"),
  };
  return { ports, calls };
};
const run = (f: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) =>
  retireHandoff(f.ports, {
    threadId: MAIN,
    twinThreadId: TWIN,
    confirm: retireToken(MAIN),
    caughtUp: true,
    ...over,
  });

describe("retiring a handoff session", () => {
  it.effect("refuses without the token or the caught-up acknowledgement, and touches nothing", () =>
    Effect.gen(function* () {
      for (const over of [{ confirm: "yes" }, { caughtUp: false }]) {
        const f = fixture();
        expect((yield* run(f, over)).state).toBe("refused");
        expect(f.calls).toEqual([]);
      }
    }),
  );

  it.effect(
    "switches back to the live session, then writes the undo list, archives, then deletes the twin",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const result = yield* run(f);
        expect(result.state).toBe("retired");
        expect(f.calls).toEqual([`live:${MAIN}`, "undo", `archive:${TWIN}`, `delete:${TWIN}`]);
      }),
  );

  it.effect(
    "leaves the twin alone when the switch back did not take, or the thread is working or already live",
    () =>
      Effect.gen(function* () {
        const stuck = fixture({ switchWorks: false });
        expect((yield* run(stuck)).state).toBe("incomplete");
        expect(stuck.calls).toEqual([`live:${MAIN}`]);
        expect((yield* run(fixture({ running: true }))).state).toBe("refused");
        expect((yield* run(fixture({ mainInstance: "baton-live" }))).state).toBe("refused");
      }),
  );

  it.effect(
    "twinOnly removes just the twin's mirror thread when the main thread is already live",
    () =>
      Effect.gen(function* () {
        const f = fixture({ mainInstance: "baton-live" });
        const result = yield* run(f, { twinOnly: true });
        expect(result.state).toBe("retired");
        expect(f.calls).toEqual(["undo", `archive:${TWIN}`, `delete:${TWIN}`]);
        expect(
          (yield* run(fixture({ mainInstance: "claudeAgent" }), { twinOnly: true })).state,
        ).toBe("refused");
        expect(
          (yield* run(fixture({ mainInstance: "baton-live", twinRunning: true }), {
            twinOnly: true,
          })).state,
        ).toBe("refused");
        expect(
          (yield* run(fixture({ mainInstance: "baton-live" }), {
            twinOnly: true,
            twinThreadId: MAIN,
          })).state,
        ).toBe("refused");
      }),
  );

  it.effect("an already archived twin is not archived again, and the delete still runs", () =>
    Effect.gen(function* () {
      const f = fixture({ mainInstance: "baton-live", twinArchived: true });
      const result = yield* run(f, { twinOnly: true });
      expect(result).toMatchObject({ state: "retired", archived: "already", deleted: "done" });
      expect(f.calls).toEqual(["undo", `delete:${TWIN}`]);
    }),
  );
});
