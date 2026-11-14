import { describe, expect, it } from "vite-plus/test";

import { createRecogniserPriority } from "./recogniserPriority.ts";

const rig = (fullscreen = false) => {
  const set: string[] = [];
  const priority = createRecogniserPriority({
    set: (level) => set.push(level),
    fullscreen: () => fullscreen,
  });
  return { priority, set };
};

describe("the recogniser's priority", () => {
  it("is raised for a recognition and put back after the last one", () => {
    const r = rig();
    expect(r.priority.begin()).toBe("above");
    expect(r.priority.begin()).toBe("above");
    r.priority.end();
    expect(r.set).toEqual(["above"]);
    r.priority.end();
    expect(r.set).toEqual(["above", "normal"]);
  });

  it("stays normal while she speaks, and drops back when she starts", () => {
    const r = rig();
    r.priority.speaking(true);
    expect(r.priority.begin()).toBe("normal");
    r.priority.end();
    r.priority.speaking(false);
    expect(r.priority.begin()).toBe("above");
    r.priority.speaking(true);
    expect(r.set).toEqual(["above", "normal"]);
  });

  it("is never raised while a game or full-screen app is in front", () => {
    const r = rig(true);
    expect(r.priority.begin()).toBe("normal");
    r.priority.end();
    expect(r.set).toEqual([]);
  });
});
