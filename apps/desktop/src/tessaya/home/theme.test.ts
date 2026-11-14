import { describe, expect, it } from "vite-plus/test";

import { parseAppearance, resolveTheme, THEME_GROUND, themeSourceFor } from "./theme.ts";

describe("the window's theme", () => {
  it("follows the system unless he chose, and treats anything odd as the system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect([undefined, null, "Dark", 3].map(parseAppearance)).toEqual([
      "system",
      "system",
      "system",
      "system",
    ]);
    expect([parseAppearance("dark"), parseAppearance("light")]).toEqual(["dark", "light"]);
  });
  it("tells the system the theme he chose, so Light on a dark Windows gets a light Acrylic tint", () => {
    expect(themeSourceFor("light")).toBe("light");
    expect(themeSourceFor("dark")).toBe("dark");
    expect(themeSourceFor("system")).toBe("system");
  });
  it("paints the window's own colour in each theme before the page does", () => {
    expect(THEME_GROUND).toEqual({ light: "#f3f0e8", dark: "#121110" });
  });
});
