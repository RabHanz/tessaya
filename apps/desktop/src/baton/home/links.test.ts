import { tessayaPlaceOf } from "@t3tools/baton-contracts";
import { describe, expect, it } from "vite-plus/test";

import { placeInArgs } from "./links.ts";

describe("tessaya:// links", () => {
  it("names a place from a link, a path or a bare id, and nothing else", () => {
    expect(tessayaPlaceOf("tessaya://settings/hardware")).toBe("hardware");
    expect(tessayaPlaceOf("TESSAYA://homeassistant/")).toBe("homeassistant");
    expect(tessayaPlaceOf("settings/voice?x=1")).toBe("voice");
    expect(tessayaPlaceOf("tessaya://settings/nowhere")).toBeNull();
    expect(tessayaPlaceOf("https://example.com/settings/hardware")).toBeNull();
  });

  it("finds the link among a second launch's arguments", () => {
    expect(placeInArgs(["Tessaya.exe", "--flag", "tessaya://settings/apis"])).toBe("apis");
    expect(placeInArgs(["Tessaya.exe"])).toBeNull();
  });
});
