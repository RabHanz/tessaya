import { describe, expect, it } from "vite-plus/test";

import { volumeAfter, volumeLine } from "./speakingVolume.ts";

describe("how loud she speaks after he asks", () => {
  it("steps, tops out, floors and goes back to the device's own default", () => {
    expect(volumeAfter(71, "up", 71)).toBe(86);
    expect(volumeAfter(86, "up", 71)).toBe(100);
    expect(volumeAfter(100, "up", 71)).toBe(100);
    expect(volumeAfter(71, "down", 71)).toBe(56);
    expect(volumeAfter(15, "down", 71)).toBe(10);
    expect(volumeAfter(40, "max", 71)).toBe(100);
    expect(volumeAfter(100, "default", 71)).toBe(71);
    expect(volumeAfter(50, 140, 71)).toBe(100);
    expect(volumeAfter(50, 0, 71)).toBe(10);
  });

  it("tells her what changed as data, and when there was nowhere to go", () => {
    expect(volumeLine(71, 86)).toContain("louder");
    expect(volumeLine(100, 100)).toBe("Already as loud as this device goes.");
    expect(volumeLine(10, 10)).toBe("Already as quiet as she goes by voice.");
  });
});
