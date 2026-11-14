// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { parseAppearance, resolveTheme, type Appearance } from "./theme.ts";

/** The setter saves `{ appearance: parseAppearance(value) }` into the settings file; this is that path. */
const saveChoice = (file: string, value: unknown) => {
  const saved = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>;
  NodeFS.writeFileSync(file, JSON.stringify({ ...saved, appearance: parseAppearance(value) }));
};
const loaded = (file: string): Appearance =>
  parseAppearance(
    (JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>)["appearance"],
  );

describe("the appearance choice", () => {
  it("round-trips light, dark, light, system through the settings file, and a bad value is system", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "appearance-"));
    const file = NodePath.join(dir, "fabric-voice.json");
    NodeFS.writeFileSync(file, "{}");
    const seen: string[] = [];
    for (const choice of ["light", "dark", "light", "system", "purple"]) {
      saveChoice(file, choice);
      seen.push(loaded(file));
    }
    expect(seen).toEqual(["light", "dark", "light", "system", "system"]);
  });

  it("shows light on a dark Windows once he chose light, and follows Windows on System", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("the setter", () => {
  it("saves the appearance control (the case that was missing)", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../voice/DesktopTessayaVoice.ts"),
      "utf8",
    );
    expect(source).toContain('id === "v.appearance"');
    expect(source).toContain("save({ appearance: parseAppearance(value) })");
  });
});
