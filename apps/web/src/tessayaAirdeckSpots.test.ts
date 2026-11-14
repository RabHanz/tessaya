// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const web = NodePath.resolve(import.meta.dirname, "..");
const read = (path: string) => NodeFS.readFileSync(NodePath.join(web, path), "utf8");
const spots = JSON.parse(read("public/baton/airdeck-spots.json")) as {
  spots: Array<Record<string, unknown>>;
};
const bar = NodeFS.readFileSync(
  NodePath.join(web, "src/components/sidebar/TessayaIntentBar.tsx"),
  "utf8",
);
const title = NodeFS.readFileSync(NodePath.join(web, "index.html"), "utf8");

describe("the input spots Tessaya publishes for Airdeck (D64)", () => {
  it("serves the same file at the legacy /fabric/ path spots were imported from (D71)", () => {
    expect(read("public/fabric/airdeck-spots.json")).toBe(read("public/baton/airdeck-spots.json"));
  });

  it("point at the intent bar by the id and name it really carries", () => {
    for (const spot of spots.spots) {
      expect(bar).toContain(`id="${String(spot["automationId"])}"`);
      expect(bar).toContain(`aria-label="${String(spot["elementName"])}"`);
      expect(title).toContain(String(spot["titleContains"]));
      expect(spot["method"]).toBe("element");
    }
  });

  it("carry every field Airdeck's InputSpot reads", () => {
    const fields = [
      "label",
      "process",
      "titleContains",
      "browser",
      "elementName",
      "automationId",
      "className",
      "controlType",
      "offsetX",
      "offsetY",
      "fracX",
      "fracY",
      "afterKeys",
      "method",
    ];
    for (const spot of spots.spots) expect(Object.keys(spot).toSorted()).toEqual(fields.toSorted());
  });
});
