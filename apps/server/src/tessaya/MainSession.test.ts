import { describe, expect, it } from "vite-plus/test";

import { carriesMain, decideMainPin } from "./MainSession.ts";

describe("the main session's pin", () => {
  it("is put on once when a thread becomes main, and unpinning it clears the mark", () => {
    expect(decideMainPin({ main: "t1", seenMain: null, pinned: false, wasPinned: false })).toBe(
      "pin",
    );
    expect(decideMainPin({ main: "t1", seenMain: null, pinned: true, wasPinned: false })).toBe(
      "none",
    );
    // Already main since the last tick (or since the server started): never pinned again.
    expect(decideMainPin({ main: "t1", seenMain: "t1", pinned: false, wasPinned: false })).toBe(
      "none",
    );
    expect(decideMainPin({ main: "t1", seenMain: "t1", pinned: false, wasPinned: true })).toBe(
      "clear",
    );
    expect(decideMainPin({ main: null, seenMain: "t1", pinned: false, wasPinned: true })).toBe(
      "none",
    );
  });
});

describe("a main session restarted under a new id", () => {
  const base = {
    mainSessionId: "old",
    mainPane: "fab-t3code~w1:p1",
    liveSessionIds: new Set(["new"]),
    session: { sessionId: "new", herdrPane: "fab-t3code~w1:p1" },
  };
  it("stays on the main thread when it runs in the pane the old one ran in", () => {
    expect(carriesMain(base)).toBe(true);
  });
  it("is never guessed: another pane, the old one still running, or no pane known", () => {
    expect(carriesMain({ ...base, session: { sessionId: "new", herdrPane: "fab-x~w1:p2" } })).toBe(
      false,
    );
    expect(carriesMain({ ...base, liveSessionIds: new Set(["new", "old"]) })).toBe(false);
    expect(carriesMain({ ...base, mainPane: null })).toBe(false);
    expect(carriesMain({ ...base, session: { sessionId: "old", herdrPane: base.mainPane } })).toBe(
      false,
    );
  });
});
