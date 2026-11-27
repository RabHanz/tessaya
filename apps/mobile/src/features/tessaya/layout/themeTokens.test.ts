import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

// Uniwind drops a colour class it has no token for, silently: `bg-background` drew Talk and the Sleeve see-through.
const root = NodePath.join(import.meta.dirname, "../../..");
const tokens = new Set(
  [
    ...NodeFS.readFileSync(NodePath.join(root, "../generated-uniwind-themes.css"), "utf8").matchAll(
      /--color-([a-z0-9-]+)/g,
    ),
  ].map((m) => m[1]),
);
const NOT_COLOURS = new Set(
  "xs sm base lg xl center left right justify start end transparent white black current inherit t b l r x y s e continuous dashed solid dotted none hairline".split(
    " ",
  ),
);
const files = (dir: string): Array<string> =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(NodePath.join(dir, e.name))
      : e.name.endsWith(".tsx")
        ? [NodePath.join(dir, e.name)]
        : [],
  );

it("every colour class on Tessaya's phone screens names a theme token", () => {
  const unknown = [
    ...files(NodePath.join(root, "features/tessaya")),
    NodePath.join(root, "features/settings/SettingsHardwareRouteScreen.tsx"),
    NodePath.join(root, "features/settings/SettingsPersonasRouteScreen.tsx"),
  ].flatMap((f) =>
    [
      ...NodeFS.readFileSync(f, "utf8").matchAll(
        /\b(?:bg|text|border)-([a-z][a-z-]*[a-z])(?:\/\d+)?\b/g,
      ),
    ]
      .map((m) => m[1]!)
      .filter((t) => !NOT_COLOURS.has(t) && !tokens.has(t))
      .map((t) => `${f.slice(root.length + 1)}: ${t}`),
  );
  expect(unknown).toEqual([]);
});
