import { R1_KEY_SLOTS, type R1KeySlot } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  btDeviceLabel,
  keyBindingFrom,
  keyChoiceOf,
  keyChoices,
  outputLabels,
  scanLine,
  playingLine,
  tesselHosts,
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
    // His own personas from her server, a custom one included.
    expect(
      keyChoices("s2.double", ["Tessaya", "Nova"]).filter(([c]) => c.startsWith("persona:")),
    ).toEqual([
      ["persona:", "Next persona, in her voice"],
      ["persona:Tessaya", "Switch to Tessaya"],
      ["persona:Nova", "Switch to Nova"],
    ]);
  });
});

describe("the Bluetooth audio row", () => {
  it("names a device by its name or what it is, never its address, and says why a scan found nothing", () => {
    expect(btDeviceLabel({ name: "E8:07:BF:35:26:5C", kind: "headphones" })).toBe("Headphones");
    expect(btDeviceLabel({ name: "" })).toBe("Bluetooth device");
    const s = {
      state: "idle",
      saved: { mac: "E8:07:BF:35:26:5C", name: "Office speaker", kind: "speaker" },
      output: "auto",
      found: [],
      scannedAt: "2026-11-13T12:08:46.000Z",
    } as const;
    expect(outputLabels(s)).toEqual({
      auto: "Office speaker, else Tessel",
      bt: "Office speaker only",
      onboard: "Tessel only",
    });
    expect(scanLine(s)).toContain("disconnect it from your phone or laptop");
  });
});

describe("where replies play (firmware 0.3.52)", () => {
  const speaker = {
    state: "idle" as const,
    saved: { mac: "14:C6:00:00:00:01", name: "Galaxy X", kind: "headphones" as const },
    output: "bt" as const,
    found: [],
    scannedAt: null,
  };
  it("says where they play now beside the route he chose, and why they differ", () => {
    expect(playingLine({ ...speaker, playing: "onboard" })).toBe(
      "Replies play on: Tessel speaker (wanted: Galaxy X, not connected).",
    );
    expect(playingLine({ ...speaker, state: "connected", playing: "bt" })).toBe(
      "Replies play on: Galaxy X.",
    );
    expect(playingLine({ ...speaker, output: "auto", playing: "onboard" })).toBe(
      "Replies play on: Tessel speaker.",
    );
    expect(playingLine(speaker)).toBeNull();
  });
});

describe("one Tessel heard by several servers", () => {
  const r1 = (online: boolean | null, configured: boolean) => ({
    id: "r1-a1b2c3",
    online,
    configured,
  });
  it("is one device on the server that holds it, with the others as where else it is reachable", () => {
    const hosts = tesselHosts([
      {
        host: "desk",
        devices: [r1(true, false), { id: "phone", online: true, configured: false }],
      },
      { host: "home", devices: [r1(true, true)] },
      { host: "office", devices: [r1(true, false)] },
    ]);
    expect(hosts.get("r1-a1b2c3")).toEqual({ primary: "home", reachable: ["desk", "office"] });
    expect(hosts.get("phone")).toEqual({ primary: "desk", reachable: [] });
  });
  it("moves when it goes quiet on its server and is heard on another", () => {
    const hosts = tesselHosts([
      { host: "home", devices: [r1(false, true)] },
      { host: "office", devices: [r1(true, false)] },
    ]);
    expect(hosts.get("r1-a1b2c3")).toEqual({ primary: "office", reachable: ["home"] });
  });
});
