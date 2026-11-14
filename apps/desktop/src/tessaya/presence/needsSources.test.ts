import { describe, expect, it } from "vite-plus/test";

import { readLedger } from "./needsSources.ts";

describe("the ledger source", () => {
  it("reads both labels read-only, and names a repository it cannot read", async () => {
    const calls: string[][] = [];
    const run = async (_file: string, args: ReadonlyArray<string>) => {
      calls.push([...args]);
      if (args.includes("o/bad")) throw new Error("no access");
      return JSON.stringify([
        { number: 1, title: "t", labels: [{ name: "ledger:money-blocker" }], updatedAt: "x" },
      ]);
    };
    const { issues, unreadable } = await readLedger(["o/good", "o/bad", "not a repo"], run);
    expect(issues).toHaveLength(2);
    expect(unreadable).toEqual(["the ledger o/bad", "not a repo"]);
    expect(calls.every((c) => c[0] === "issue" && c[1] === "list")).toBe(true);
  });
});
