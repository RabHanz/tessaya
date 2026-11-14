// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { draftPath, writeDraft } from "./skillDraftFile.ts";

describe("skill drafts", () => {
  it("keeps each draft in its own folder and never overwrites one", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drafts-"));
    const a = writeDraft(dir, "Rebuild the site", "one");
    NodeFS.writeFileSync(a, "edited by him");
    const b = writeDraft(dir, "Rebuild the site", "two");
    expect(NodePath.basename(NodePath.dirname(a))).toBe("rebuild-the-site");
    expect(NodePath.basename(NodePath.dirname(b))).toBe("rebuild-the-site-2");
    expect(NodeFS.readFileSync(a, "utf8")).toBe("edited by him");
  });
  it("reviews only a SKILL.md inside the drafts folder", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drafts-"));
    const file = writeDraft(dir, "x job", "t");
    expect(draftPath(dir, file)).toBe(NodePath.resolve(file));
    expect(draftPath(dir, NodePath.join(dir, "elsewhere", "SKILL.md"))).toBeNull();
    expect(draftPath(dir, NodePath.join(dir, "skill-drafts", "..", "secret.txt"))).toBeNull();
    expect(draftPath(dir, "https://x.io/SKILL.md")).toBeNull();
  });
});
