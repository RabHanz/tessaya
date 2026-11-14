// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_STYLES } from "@t3tools/tessaya-shared/writingStyle";
import { describe, expect, it } from "vite-plus/test";

import { tabOf } from "../home/tabs.ts";
import { guideAnswer, GUIDE_BUTTONS, styleAction, styleControls } from "./styleRows.ts";
import { createStyleStore } from "./styleStore.ts";

describe("the Style area", () => {
  it("shows a style per kind of writing and the three cleanup levels, on the Style tab", () => {
    const rows = styleControls(DEFAULT_STYLES, "local");
    for (const r of rows) expect(tabOf(r.id)).toBe("style");
    expect(rows.find((r) => r.id === "st.level")).toMatchObject({ value: "light" });
    expect(rows.filter((r) => r.id.startsWith("st.cat:"))).toHaveLength(4);
  });
  it("turns a row into an action and refuses a value it does not offer", () => {
    expect(styleAction("st.cat:email", "formal")).toEqual({
      kind: "style",
      category: "email",
      style: "formal",
    });
    expect(styleAction("st.cat:email", "shouty")).toBeNull();
    expect(styleAction("st.level", "medium")).toEqual({ kind: "level", level: "medium" });
    expect(styleAction("st.guide", null)).toEqual({ kind: "guide" });
    expect(guideAnswer(1)).toBe("casual");
    expect(guideAnswer(GUIDE_BUTTONS.length - 1)).toBeNull();
  });
  it("keeps the choices on disk", () => {
    const store = createStyleStore(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "style-")));
    expect(store.read()).toEqual(DEFAULT_STYLES);
    store.set("work", "formal");
    expect(
      createStyleStore(NodePath.dirname(NodePath.join(NodeOS.tmpdir(), "x"))).read(),
    ).toBeDefined();
    expect(store.read().work).toBe("formal");
  });
});
