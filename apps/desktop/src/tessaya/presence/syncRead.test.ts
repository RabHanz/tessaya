// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createSyncExtraCache, readLocalBehind, readSyncPr } from "./syncRead.ts";

const repo = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sync-"));
  NodeFS.mkdirSync(NodePath.join(dir, "vendor-patches", "t3code"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "vendor-patches", "t3code", "PIN"), "abc123\n");
  return dir;
};

describe("reading the sync state", () => {
  it("counts commits behind from the pin in the checkout, and says unknown without one", async () => {
    const seen: string[][] = [];
    const n = await readLocalBehind(repo(), async (_cwd, args) => (seen.push([...args]), "31\n"));
    expect(n).toBe(31);
    expect(seen[0]).toEqual(["rev-list", "--count", "abc123..upstream/main"]);
    expect(await readLocalBehind(undefined, async () => "1")).toBeNull();
    expect(await readLocalBehind("/no/such/checkout", async () => "1")).toBeNull();
    expect(
      await readLocalBehind(repo(), async () => {
        throw new Error("no upstream remote");
      }),
    ).toBeNull();
  });

  it("finds the open sync PR among the others and sums its checks", async () => {
    const rows = [
      { number: 1, title: "feat: x", url: "u1", headRefName: "baton/c-x", statusCheckRollup: [] },
      {
        number: 292,
        title: "sync: upstream to abc",
        url: "u2",
        headRefName: "baton/sync-abc",
        statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
      },
    ];
    expect(await readSyncPr("o/r", async () => JSON.stringify(rows))).toEqual({
      number: 292,
      url: "u2",
      title: "sync: upstream to abc",
      checks: "fail",
    });
    expect(await readSyncPr("o/r", async () => "[]")).toBeNull();
    expect(
      await readSyncPr("o/r", async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });

  it("asks at most every ten minutes", async () => {
    let calls = 0;
    let t = 0;
    const cache = createSyncExtraCache(
      "o/r",
      undefined,
      async () => (calls++, "[]"),
      undefined,
      () => t,
    );
    await cache();
    t = 5 * 60_000;
    await cache();
    expect(calls).toBe(1);
    t = 11 * 60_000;
    await cache();
    expect(calls).toBe(2);
  });
});
