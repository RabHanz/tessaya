// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { moveRoster } from "./rosterMove.ts";

const write = (file: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
};

describe("the 14 Nov roster on this computer", () => {
  it("moves each face's conversation, jobs and nameless pack edits by name, once", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "roster-"));
    const at = (...parts: string[]) => NodePath.join(dir, ...parts);
    write(at("operating-system", "roles", "engineering.md"), "---\nvoice: anna\n---\nAlfred's.");
    write(at("conversation", "engineering.ndjson"), "alfred\n");
    write(at("conversation", "operations.ndjson.1"), "freya\n");
    write(at("conversation", "executive.ndjson"), "tessaya\n");
    write(
      at("user-jobs.json"),
      JSON.stringify({ next: 3, jobs: [{ owner: "engineering" }, { owner: "executive" }] }),
    );
    expect(moveRoster(dir)).toHaveLength(4);
    expect(NodeFS.readFileSync(at("operating-system", "roles", "butler.md"), "utf8")).toContain(
      "Alfred's",
    );
    expect(NodeFS.readFileSync(at("conversation", "butler.ndjson"), "utf8")).toBe("alfred\n");
    expect(NodeFS.readFileSync(at("conversation", "companion.ndjson.1"), "utf8")).toBe("freya\n");
    expect(NodeFS.existsSync(at("conversation", "executive.ndjson"))).toBe(true);
    const saved = JSON.parse(NodeFS.readFileSync(at("user-jobs.json"), "utf8"));
    expect(saved.jobs.map((j: { owner: string }) => j.owner)).toEqual(["butler", "executive"]);
    // Onyx's new conversation on engineering is never moved again.
    write(at("conversation", "engineering.ndjson"), "onyx\n");
    expect(moveRoster(dir)).toEqual([]);
    expect(NodeFS.existsSync(at("conversation", "engineering.ndjson"))).toBe(true);
  });
});
