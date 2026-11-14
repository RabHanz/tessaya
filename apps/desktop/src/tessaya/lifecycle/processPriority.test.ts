import * as NodeOS from "node:os";

import { describe, expect, it } from "vite-plus/test";

import { liftInheritedPriority } from "./processPriority.ts";

const { PRIORITY_ABOVE_NORMAL, PRIORITY_BELOW_NORMAL, PRIORITY_LOW, PRIORITY_NORMAL } =
  NodeOS.constants.priority;

describe("liftInheritedPriority", () => {
  it.each([
    { start: PRIORITY_BELOW_NORMAL, lifted: PRIORITY_BELOW_NORMAL, set: [PRIORITY_NORMAL] },
    { start: PRIORITY_LOW, lifted: PRIORITY_LOW, set: [PRIORITY_NORMAL] },
    { start: PRIORITY_NORMAL, lifted: null, set: [] },
    { start: PRIORITY_ABOVE_NORMAL, lifted: null, set: [] },
  ])("starting at $start lifts to normal only from below it", ({ start, lifted, set }) => {
    const calls: Array<number> = [];
    expect(
      liftInheritedPriority({
        getPriority: () => start,
        setPriority: (priority: number) => void calls.push(priority),
      } as Parameters<typeof liftInheritedPriority>[0]),
    ).toBe(lifted);
    expect(calls).toEqual(set);
  });

  it("never throws when the system refuses", () => {
    expect(
      liftInheritedPriority({
        getPriority: () => PRIORITY_BELOW_NORMAL,
        setPriority: () => {
          throw new Error("EACCES");
        },
      } as Parameters<typeof liftInheritedPriority>[0]),
    ).toBeNull();
  });
});
