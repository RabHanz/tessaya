// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { PLAN_FILE, REPORT_FILE, runFreyaImport, type FreyaPlanItem } from "./freyaImport.ts";

const item = (over: Partial<FreyaPlanItem>): FreyaPlanItem => ({
  id: "i",
  kind: "fact",
  text: "x",
  sourceRef: "freya:park/fact/1",
  scopeRef: null,
  confidence: 0.5,
  proposed: false,
  createdAt: "2026-06-14T03:05:56.000Z",
  updatedAt: "2026-06-14T03:05:56.000Z",
  store: "owner-general",
  ...over,
});

const plan = [
  item({ id: "g1", text: "Likes the office fan low at night", sourceRef: "freya:park/fact/57" }),
  item({ id: "g2", text: "Prefers tea", sourceRef: "freya:park/memory/9" }),
  item({ id: "g3", text: "Already here", sourceRef: "freya:park/fact/3" }),
  item({
    id: "p1",
    text: "Keeps the evening prayers",
    store: "owner-private",
    sourceRef: "freya:park/fact/42",
  }),
  item({
    id: "p2",
    text: "A daughter's birthday",
    store: "owner-private-about-person",
    scopeRef: "Kim",
  }),
  item({ id: "h1", text: "A doubtful claim", store: "owner-private", proposed: true }),
];

describe("importing Freya's memories", () => {
  it("sends everyday ones through memory's door, the rest into his private store, once, and deletes the plan", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "freya-"));
    NodeFS.mkdirSync(NodePath.join(dir, "import"));
    NodeFS.writeFileSync(NodePath.join(dir, PLAN_FILE), JSON.stringify({ items: plan }));
    const added: Array<Record<string, unknown>> = [];
    const deposits: Array<Record<string, unknown>> = [];
    let hasStore = false;
    const deps = {
      memory: async (op: string, args: Record<string, unknown>) => {
        if (op === "list") return { items: [{ sourceRef: "freya:park/fact/3" }] };
        added.push(args);
        // His own "tea" note was already there: the door strengthens it and returns his.
        return { item: { sourceRef: args["text"] === "Prefers tea" ? null : args["sourceRef"] } };
      },
      private: async (op: string, args: Record<string, unknown> = {}) => {
        if (!hasStore) throw new Error("There is no private store for this person yet.");
        deposits.push({ op, ...args });
        return { added: 3, skipped: 0 };
      },
    };
    // No private store yet: everyday memories go in, and the plan waits.
    await expect(runFreyaImport(dir, deps)).rejects.toThrow("no private store");
    expect(NodeFS.existsSync(NodePath.join(dir, PLAN_FILE))).toBe(true);
    expect(added.map((a) => [a["source"], a["createdAt"]])).toEqual([
      ["import", "2026-06-14T03:05:56.000Z"],
      ["import", "2026-06-14T03:05:56.000Z"],
    ]);
    hasStore = true;
    const counts = await runFreyaImport(dir, deps);
    expect(counts?.private).toEqual({ added: 3, already: 0, waiting: 1 });
    const items = (
      deposits[0]!["items"] as Array<{ id: string; draft: Record<string, unknown> }>
    ).map((i) => [i.id, i.draft["about"], i.draft["proposed"]]);
    expect(items).toEqual([
      ["p1", null, false],
      ["p2", "Kim", false],
      ["h1", null, true],
    ]);
    // Its words are gone from disk; only counts stay.
    expect(NodeFS.existsSync(NodePath.join(dir, PLAN_FILE))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(dir, REPORT_FILE), "utf8")).not.toContain("prayers");
    expect(await runFreyaImport(dir, deps)).toBeNull();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
