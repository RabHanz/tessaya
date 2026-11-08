import { describe, expect, it } from "vite-plus/test";

import { inFlightLine, turnsInFlight } from "./turnsInFlight.ts";

describe("turns in flight (SESS-SURVIVE)", () => {
  it("is every thread with an active run, archived and deleted ones aside, and every busy Claude process", () => {
    const found = turnsInFlight({
      threads: [
        { id: "t1", title: "Fix the build", activeRunId: "r1" },
        { id: "t2", title: "Idle one", activeRunId: null },
        { id: "t3", title: "Archived", activeRunId: "r3", archivedAt: "2026-11-08" },
        { id: "t4", title: "Deleted", activeRunId: "r4", deletedAt: "2026-11-08" },
      ],
      live: [
        { sessionId: "s1", name: "shop", cwd: "/home/user/shop", status: "busy" },
        { sessionId: "s2", name: null, cwd: "/home/user/app", status: "idle" },
      ],
    });
    expect(found).toEqual({
      threads: [{ threadId: "t1", title: "Fix the build" }],
      live: [{ sessionId: "s1", name: "shop", cwd: "/home/user/shop" }],
    });
    expect(inFlightLine(found)).toBe("2 sessions are mid-turn: “Fix the build”, “shop”.");
    expect(inFlightLine(turnsInFlight({ threads: [], live: [] }))).toBeNull();
  });
});
