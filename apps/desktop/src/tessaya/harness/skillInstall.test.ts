// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  fetchSkillText,
  installSkill,
  nameFromUrl,
  skillExists,
  type Fetch,
} from "./skillInstall.ts";

const reply =
  (over: { ok?: boolean; status?: number; type?: string; length?: string; body?: string }): Fetch =>
  async () => ({
    ok: over.ok ?? true,
    status: over.status ?? 200,
    headers: {
      get: (n) =>
        n === "content-type"
          ? (over.type ?? "text/plain")
          : n === "content-length"
            ? (over.length ?? null)
            : null,
    },
    text: async () => over.body ?? "hello",
  });

describe("installing a skill", () => {
  it("fetches small text and refuses an error, a binary, or a large file", async () => {
    expect(await fetchSkillText("https://x.io/a.md", reply({ body: "# skill" }))).toBe("# skill");
    await expect(
      fetchSkillText("https://x.io/a.md", reply({ ok: false, status: 404 })),
    ).rejects.toThrow("404");
    await expect(
      fetchSkillText("https://x.io/a", reply({ type: "application/zip" })),
    ).rejects.toThrow("not a text file");
    await expect(fetchSkillText("https://x.io/a", reply({ length: "999999" }))).rejects.toThrow(
      "too large",
    );
    await expect(
      fetchSkillText("https://x.io/a", reply({ body: "x".repeat(200_000) })),
    ).rejects.toThrow("too large");
  });
  it("names it from the address and files it where Claude Code reads skills", () => {
    expect(nameFromUrl("https://raw.githubusercontent.com/o/r/main/skills/tidy/SKILL.md")).toBe(
      "tidy",
    );
    expect(nameFromUrl("https://x.io/notes/release-notes.md")).toBe("release-notes");
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-"));
    expect(skillExists(dir, "tidy")).toBe(false);
    const file = installSkill(dir, "tidy", "---\nname: tidy\n---\nbody");
    expect(file).toBe(NodePath.join(dir, "skills", "tidy", "SKILL.md"));
    expect(skillExists(dir, "tidy")).toBe(true);
    expect(NodeFS.readFileSync(file, "utf8").endsWith("body\n")).toBe(true);
  });
});
