import { R1_KEY_SLOTS, type R1KeySlot } from "@t3tools/baton-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  btDeviceLabel,
  keyBindingFrom,
  keyChoiceOf,
  keyChoices,
  outputLabels,
  scanLine,
} from "./deviceView.ts";

describe("an R1 button's choices", () => {
  it("make the binding each names, and read back as the same choice; a detail-less one makes none", () => {
    for (const slot of Object.keys(R1_KEY_SLOTS) as Array<R1KeySlot>)
      for (const [choice] of keyChoices(slot)) {
        const made = keyBindingFrom(choice, "light.desk", { id: "t1", title: "Release" });
        expect(made === null ? null : keyChoiceOf(made), `${slot} ${choice}`).toBe(choice);
      }
    expect(keyBindingFrom("prompt", "  ", null)).toBeNull();
    expect(keyBindingFrom("thread:stop", "", null)).toBeNull();
    // Device actions are offered only where the firmware lets a press be rebound.
    expect(keyChoices("s1.hold").some(([c]) => c === "device:sleep")).toBe(false);
  });
});

describe("the Bluetooth audio row", () => {
  it("names a device by its name or what it is, never its address, and says why a scan found nothing", () => {
    expect(btDeviceLabel({ name: "E8:07:BF:35:26:5C", kind: "headphones" })).toBe("Headphones");
    expect(btDeviceLabel({ name: "", kind: undefined })).toBe("Bluetooth device");
    const s = {
      state: "idle",
      saved: { mac: "E8:07:BF:35:26:5C", name: "Office speaker", kind: "speaker" },
      output: "auto",
      found: [],
      scannedAt: "2026-11-13T12:08:46.000Z",
    } as const;
    expect(outputLabels(s)).toEqual({
      auto: "Office speaker, else R1",
      bt: "Office speaker only",
      onboard: "R1 only",
    });
    expect(scanLine(s)).toContain("disconnect it from your phone or laptop");
  });
});
