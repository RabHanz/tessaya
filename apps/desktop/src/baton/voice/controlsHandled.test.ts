// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * A control the window shows but the setter ignores does nothing when he uses it (the Appearance
 * choice shipped that way). Every `id: "v.…"` control must have a branch in the setter ladder.
 */
describe("every voice control has a handler", () => {
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "DesktopBatonVoice.ts"),
    "utf8",
  );
  const controls = [...source.matchAll(/^\s+id: "(v\.[A-Za-z]+)",/gm)].map((m) => m[1]!);

  it("finds the controls", () => {
    expect(controls.length).toBeGreaterThan(20);
  });

  // A list control (kind "list") sends `<id>:add` and `<id>:rm`, so its branch names those.
  it.each(controls)("%s is handled", (id) => {
    expect(source).toMatch(new RegExp(`id === "${id.replace(".", "\\.")}(?::(?:add|rm))?"`));
  });
});
