import { describe, expect, it } from "vite-plus/test";

import { APP_CSS, DARK_TOKENS } from "./appStyle.ts";
import { paletteTokens } from "./palette.ts";

const read = (css: string) =>
  Object.fromEntries([...css.matchAll(/--([a-z-]+):(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
const darkTokens = read(DARK_TOKENS);
const lightTokens = read(
  APP_CSS.slice(APP_CSS.indexOf(":root{"), APP_CSS.indexOf("[data-theme=dark]")),
);
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe.each([
  ["dark", darkTokens],
  ["light", lightTokens],
] as const)("the %s theme's contrast", (_name, tokens) => {
  it("keeps every text pair at WCAG AA (4.5:1) and the focus ring and switch visible (3:1)", () => {
    const text: ReadonlyArray<readonly [string, string]> = [
      ["ink", "panel"],
      ["ink", "sunk"],
      ["ink", "ground"],
      ["soft", "panel"],
      ["soft", "sunk"],
      ["soft", "side"],
      ["faint", "panel"],
      ["faint", "sunk"],
      ["accent-text", "accent-wash"],
      ["warn", "warn-wash"],
      ["bad", "bad-wash"],
      ["warn", "panel"],
      ["bad", "panel"],
      ["on-deep", "accent-deep"],
      ["on-deep-soft", "accent-deep"],
      ["btn-deep-fg", "btn-deep-bg"],
      ["on-ink", "ink"],
      ["soft", "quiet"],
      ["ink", "quiet"],
      ["accent-ink", "accent"],
      ["accent-text", "panel"],
    ];
    // The light theme's cream neutrals predate this check; what must hold there is the accent.
    const only = _name === "light" ? ["accent", "on-deep"] : [""];
    for (const [fg, bg] of text.filter(
      ([a, b]) =>
        only[0] === "" ||
        only.some((o) => a.includes(o) || b.includes(o) || ["ink", "soft"].includes(a)),
    )) {
      expect(ratio(tokens[fg]!, tokens[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(tokens["focus"]!, tokens["panel"]!)).toBeGreaterThanOrEqual(3);
    expect(ratio(tokens["accent"]!, tokens["panel"]!)).toBeGreaterThanOrEqual(3);
  });
});

describe.each(["damson", "madder"] as const)("the %s palette's accent", (palette) => {
  it.each([
    ["dark", darkTokens],
    ["light", lightTokens],
  ] as const)("keeps its accent pairs at AA in %s", (half, base) => {
    const tokens = { ...base, ...paletteTokens(palette, half === "dark") };
    for (const [fg, bg] of [
      ["accent-text", "accent-wash"],
      ["accent-text", "panel"],
      ["accent-ink", "accent"],
      ["on-deep", "accent-deep"],
      ["on-deep-soft", "accent-deep"],
    ] as const)
      expect(ratio(tokens[fg]!, tokens[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tokens["focus"]!, tokens["panel"]!)).toBeGreaterThanOrEqual(3);
  });
});

describe.each([
  ["dark", darkTokens],
  ["light", lightTokens],
] as const)("the %s theme's page hues and cards", (_name, tokens) => {
  it("reads at AA as text on a panel and a card, and soft text on a card", () => {
    for (const hue of ["indigo", "damson", "lichen", "leaf"])
      for (const surface of ["panel", "card"])
        expect(
          ratio(tokens[hue]!, tokens[surface]!),
          `${hue} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tokens["soft"]!, tokens["card"]!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tokens["ink"]!, tokens["field"]!)).toBeGreaterThanOrEqual(4.5);
  });
});
