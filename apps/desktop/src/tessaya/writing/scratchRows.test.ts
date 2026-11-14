// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { tabOf } from "../home/tabs.ts";
import { scratchAction, scratchControls } from "./scratchRows.ts";
import { createScratchStore } from "./scratchStore.ts";

const store = () => {
  let n = 0;
  return createScratchStore(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scratch-")),
    () => 1_700_000_000_000,
    () => `n${++n}`,
  );
};

describe("the Scratchpad area", () => {
  it("lists notes with Copy and Delete, filters by the search, and sits on the Scratchpad tab", () => {
    const s = store();
    s.add("buy milk");
    s.add("call Sam");
    const all = scratchControls(s.notes(), "", false);
    for (const r of all) expect(tabOf(r.id)).toBe("scratchpad");
    expect(all.filter((r) => r.id.startsWith("sc:"))).toHaveLength(2);
    const found = scratchControls(s.notes(), "milk", false).filter((r) => r.id.startsWith("sc:"));
    expect(found).toHaveLength(1);
    expect(scratchControls([], "", false).some((r) => r.id === "sc.empty")).toBe(true);
  });
  it("turns rows into actions and keeps notes across a restart", () => {
    expect(scratchAction("sc.new:add", "x")).toEqual({ kind: "add", text: "x" });
    expect(scratchAction("sc.search:rm", "x")).toEqual({ kind: "search", query: "" });
    expect(scratchAction("sc:n1", null)).toEqual({ kind: "copy", id: "n1" });
    expect(scratchAction("sc:n1:later", null)).toEqual({ kind: "delete", id: "n1" });
    expect(scratchAction("sc.hotkey", true)).toEqual({ kind: "hotkey", on: true });
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scratch-"));
    createScratchStore(dir).add("kept");
    expect(
      createScratchStore(dir)
        .notes()
        .map((n) => n.text),
    ).toEqual(["kept"]);
  });
});
