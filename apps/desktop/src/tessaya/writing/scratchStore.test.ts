// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { TessayaScratchpadAct } from "@t3tools/tessaya-contracts";
import type { ScratchNote } from "@t3tools/tessaya-shared/scratchpad";
import { describe, expect, it } from "vite-plus/test";

import { createScratchStore } from "./scratchStore.ts";

describe("createScratchStore", () => {
  it("sends what he wrote here to her brain's one Scratchpad, also what waited while it was away, and keeps its list", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scratch-"));
    // A file from before the brain kept the notes.
    NodeFS.writeFileSync(
      NodePath.join(dir, "scratchpad.json"),
      JSON.stringify({ notes: [{ id: "old", at: 1, text: "from before" }], hotkey: false }),
    );
    let brain: ScratchNote[] = [{ id: "tessel", at: 5, text: "noted on the Tessel" }];
    let up = false;
    const acts: TessayaScratchpadAct[] = [];
    const call = async (act: TessayaScratchpadAct) => {
      if (!up) throw new Error("unreachable");
      acts.push(act);
      if (act.op === "add")
        brain = [...brain, ...act.notes.filter((n) => !brain.some((b) => b.id === n.id))];
      if (act.op === "remove") brain = brain.filter((n) => !act.ids.includes(n.id));
      return { notes: act.op === "list" ? brain.toSorted((a, b) => b.at - a.at) : [] };
    };
    let id = 0;
    const store = createScratchStore(
      dir,
      () => 10,
      () => `n${++id}`,
      call,
    );
    store.add("while away");
    await store.sync();
    expect(store.notes().map((n) => n.id)).toEqual(["n1", "old"]);
    up = true;
    await store.sync();
    expect(store.notes().map((n) => n.id)).toEqual(["n1", "tessel", "old"]);
    expect(acts.filter((a) => a.op === "add")).toHaveLength(1);
    // Removed here: gone from her brain too, and sent once.
    store.remove("tessel");
    await store.sync();
    await store.sync();
    expect(brain.map((n) => n.id)).toEqual(["n1", "old"]);
    expect(acts.filter((a) => a.op === "remove")).toEqual([{ op: "remove", ids: ["tessel"] }]);
    // His file from before stays as it was beside the cache.
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "scratchpad.before-brain.json"), "utf8")),
    ).toEqual({ notes: [{ id: "old", at: 1, text: "from before" }], hotkey: false });
    NodeFS.rmSync(dir, { recursive: true });
  });

  it("never syncs over a file it cannot read: his notes in it stay for him to mend", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scratch-"));
    const file = NodePath.join(dir, "scratchpad.json");
    const damaged = JSON.stringify({ note: "invoice due Friday" });
    NodeFS.writeFileSync(file, damaged);
    const store = createScratchStore(
      dir,
      () => 1,
      () => "x",
      async () => ({
        notes: [{ id: "b", at: 2, text: "from the brain" }],
      }),
    );
    await store.sync();
    expect(NodeFS.readFileSync(file, "utf8")).toBe(damaged);
    NodeFS.rmSync(dir, { recursive: true });
  });
});
