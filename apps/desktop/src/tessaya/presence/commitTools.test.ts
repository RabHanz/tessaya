// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createCommitmentStore } from "./commitmentStore.ts";
import { dueFrom, runCommitOp } from "./commitTools.ts";

const now = Date.parse("2026-11-02T12:00:00Z");
const fresh = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "commit-"));
  let n = 0;
  return {
    dir,
    store: createCommitmentStore(
      dir,
      () => now,
      () => `id${++n}`,
    ),
  };
};

describe("commit tools", () => {
  it("adds, lists and closes through the store, and it survives a restart", () => {
    const { dir, store } = fresh();
    expect(
      runCommitOp(store, "commit_add", { text: "check the deploy", due_in_minutes: 30 }, now),
    ).toBe("Keeping track of it [id: id1].");
    const again = createCommitmentStore(dir, () => now);
    expect(runCommitOp(again, "commit_list", {}, now)).toContain(
      "check the deploy (mine, due in 30 min)",
    );
    runCommitOp(again, "commit_done", { id: "id1" }, now);
    expect(runCommitOp(again, "commit_list", {}, now)).toBe("No open commitments.");
  });

  it("keeps a damaged file aside instead of overwriting it", () => {
    const { dir, store } = fresh();
    NodeFS.writeFileSync(NodePath.join(dir, "commitments.json"), "{not json");
    expect(store.list()).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(dir, "commitments.json.bad"))).toBe(true);
  });

  it("rejects a bad due time", () => {
    expect(() => dueFrom({ due_in_minutes: -1 }, now)).toThrow();
    expect(() => dueFrom({ due_at: "soon" }, now)).toThrow();
    expect(dueFrom({}, now)).toBeNull();
  });
});
