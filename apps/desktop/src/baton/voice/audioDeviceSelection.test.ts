import { describe, expect, it } from "vite-plus/test";

import {
  backupMics,
  setMicAt,
  micChannel,
  normalizeDeviceName,
  reconcileDeviceChange,
  selectInputDevice,
} from "./audioDeviceSelection.ts";

// What Chromium reports on Windows with a DJI receiver plugged in.
const withDji = [
  { deviceId: "default", label: "Default - Microphone (Realtek(R) Audio)" },
  { deviceId: "communications", label: "Communications - Microphone (Realtek(R) Audio)" },
  { deviceId: "a1", label: "Microphone (Realtek(R) Audio)" },
  { deviceId: "d1", label: "Microphone (2- DJI MIC MINI)" },
];
const withoutDji = withDji.slice(0, 3);
const pinned = { pinnedLabel: "Microphone (2- DJI MIC MINI)" };

describe("normalizeDeviceName", () => {
  it("strips Windows' replug counter and Chromium's role prefix", () => {
    expect(normalizeDeviceName("Microphone (3- DJI MIC MINI)")).toBe("microphone (dji mic mini)");
    expect(normalizeDeviceName("Default - Microphone (DJI MIC MINI)")).toBe(
      "microphone (dji mic mini)",
    );
    expect(normalizeDeviceName("DJI MIC MINI Mono (2ca3:0026)")).toBe("dji mic mini mono");
  });
});

describe("selectInputDevice", () => {
  it("uses the OS default when nothing is pinned", () => {
    expect(selectInputDevice(withDji, { pinnedLabel: null })).toMatchObject({
      kind: "default",
      deviceId: "default",
    });
  });

  it("finds the pinned receiver again after Windows renumbers it", () => {
    const replugged = [...withoutDji, { deviceId: "d2", label: "Microphone (3- DJI MIC MINI)" }];
    const choice = selectInputDevice(replugged, pinned);
    expect(choice.kind).toBe("pinned");
    if (choice.kind === "pinned") expect(choice.device.deviceId).toBe("d2");
  });

  it("never pins Chromium's pseudo-devices, even when their label matches", () => {
    const choice = selectInputDevice(withoutDji, { pinnedLabel: "Microphone (Realtek(R) Audio)" });
    expect(choice.kind === "pinned" && choice.device.deviceId).toBe("a1");
  });

  it("falls back to the OS default, and says which mic is missing", () => {
    const choice = selectInputDevice(withoutDji, pinned);
    expect(choice).toMatchObject({ kind: "default", deviceId: "default" });
    if (choice.kind === "default") expect(choice.reason).toContain("DJI MIC MINI");
  });

  it("asks getUserMedia for its default when the list is empty (no permission yet)", () => {
    expect(selectInputDevice([], pinned)).toMatchObject({ kind: "default", deviceId: null });
  });
});

describe("micChannel", () => {
  const order = [{ name: "Scarlett Solo", channel: 0 }];
  it("reads one input only of a device that has several", () => {
    expect(micChannel("Microphone (Scarlett Solo USB)", 2, order)).toBe(0);
    expect(micChannel("Microphone (Scarlett Solo USB)", 1, order)).toBe(null);
    expect(micChannel("Microphone (Realtek)", 2, order)).toBe(null);
  });
});

describe("the microphone order", () => {
  const scarlett = {
    deviceId: "Microphone (Scarlett Solo USB)",
    label: "Microphone (Scarlett Solo USB)",
  };
  const dji = { deviceId: "Microphone (Wireless Mic Rx)", label: "Microphone (Wireless Mic Rx)" };
  const remote = { deviceId: "Microphone (USBAudio2.0)", label: "Microphone (USBAudio2.0)" };
  const order = { pinnedLabel: null, micOrder: ["Scarlett Solo", "Wireless Mic Rx"] };

  it("takes the AT2020's interface first, the DJI next, by part of the name", () => {
    expect(selectInputDevice([remote, dji, scarlett], order)).toMatchObject({
      device: scarlett,
      by: "order",
    });
    expect(selectInputDevice([remote, dji], order)).toMatchObject({ device: dji });
  });

  it("falls back to the system microphone when neither is there", () => {
    expect(selectInputDevice([remote], order)).toMatchObject({ kind: "default" });
  });

  it("moves when the first mic vanishes, and back when it returns", () => {
    const current = selectInputDevice([scarlett, dji], order);
    const gone = reconcileDeviceChange({ current, devices: [dji], preference: order });
    expect(gone).toMatchObject({ device: dji });
    const back = reconcileDeviceChange({
      current: gone!,
      devices: [scarlett, dji],
      preference: order,
    });
    expect(back).toMatchObject({ device: scarlett });
  });

  it("listens beside his mic on the rest of his order, never a hands-free headset", () => {
    const headset = { deviceId: "h", label: "Headset (TAOTRONICS SoundSurge 46 Hands-Free)" };
    const devices = [remote, headset, dji, scarlett];
    // His case: the DJI receiver pinned, the Scarlett second in his order.
    const pin = { ...order, pinnedLabel: dji.label };
    expect(backupMics(devices, pin, dji.label)).toEqual([scarlett.label, remote.label]);
    expect(backupMics(devices, order, scarlett.label)).toEqual([dji.label, remote.label]);
    // With no order at all (his file after 0.1.99), every other plugged-in mic is a backup, his order's first.
    const mix = { deviceId: "m", label: "Stereo Mix (Realtek(R) Audio)" };
    expect(backupMics([...devices, mix], { pinnedLabel: dji.label }, dji.label)).toEqual([
      remote.label,
      scarlett.label,
    ]);
    expect(backupMics([remote, dji], pin, dji.label)).toEqual([remote.label]);
    expect(backupMics(devices, order, null)).toEqual([]);
    expect(
      backupMics(
        devices,
        { pinnedLabel: headset.label, micOrder: ["Hands-Free", "Scarlett"] },
        dji.label,
      ),
    ).toEqual([scarlett.label, remote.label]);
  });

  it("sets, swaps and clears a place in his order, keeping a mic's input", () => {
    const his = [
      { name: "Scarlett Solo", channel: 1 },
      { name: "Wireless Mic Rx", channel: null },
    ];
    expect(setMicAt(his, 0, dji.label)).toEqual([
      { name: dji.label, channel: null },
      { name: "Scarlett Solo", channel: 1 },
    ]);
    expect(setMicAt(his, 1, remote.label)).toEqual([his[0], { name: remote.label, channel: null }]);
    expect(setMicAt(his, 2, remote.label)).toEqual([...his, { name: remote.label, channel: null }]);
    expect(setMicAt(his, 0, null)).toEqual([his[1]]);
    expect(setMicAt(his, 0, scarlett.label)).toEqual([
      { name: scarlett.label, channel: 1 },
      his[1],
    ]);
  });

  it("lets an explicit pin outrank the order", () => {
    const pin = { ...order, pinnedLabel: dji.label };
    expect(selectInputDevice([scarlett, dji], pin)).toMatchObject({ device: dji, by: "pin" });
  });
});

describe("reconcileDeviceChange (hot-plug)", () => {
  const onDji = selectInputDevice(withDji, pinned);
  const onDefault = selectInputDevice(withoutDji, pinned);

  it("moves to the default when the pinned receiver is unplugged", () => {
    expect(
      reconcileDeviceChange({ current: onDji, devices: withoutDji, preference: pinned }),
    ).toMatchObject({ kind: "default" });
  });

  it("moves back when it is plugged in again", () => {
    const next = reconcileDeviceChange({
      current: onDefault,
      devices: withDji,
      preference: pinned,
    });
    expect(next?.kind === "pinned" && next.device.deviceId).toBe("d1");
  });

  it("stays put when an unrelated device comes or goes", () => {
    const more = [...withDji, { deviceId: "w1", label: "Headset (WH-1000XM4)" }];
    expect(reconcileDeviceChange({ current: onDji, devices: more, preference: pinned })).toBeNull();
  });
});

describe("a Bluetooth headset taking over the system default", () => {
  // What the sidecar lists on his laptop once the TaoTronics headset connects.
  const mic = (label: string, isDefault = false) => ({ deviceId: label, label, isDefault });
  const scarlett = mic("Microphone (Scarlett Solo USB)");
  const c920 = mic("Microphone (HD Pro Webcam C920)");
  const headset = mic("Headset (TAOTRONICS SoundSurge 46 Hands-Free)", true);
  const auto = { pinnedLabel: null, micOrder: [] };

  it("stays on the mic he was using while it is still connected", () => {
    expect(selectInputDevice([scarlett, c920, headset], auto, scarlett.label)).toMatchObject({
      kind: "pinned",
      by: "kept",
      device: scarlett,
    });
  });

  it("follows the headset when the previous mic is gone, or there was none", () => {
    expect(selectInputDevice([c920, headset], auto, scarlett.label)).toMatchObject({
      kind: "default",
      label: headset.label,
    });
    expect(selectInputDevice([scarlett, headset], auto, null)).toMatchObject({ kind: "default" });
  });

  it("follows a default that moves to another wired mic", () => {
    const current = selectInputDevice([{ ...scarlett, isDefault: true }, c920], auto, null);
    expect(current).toMatchObject({ kind: "default", label: scarlett.label });
    const moved = reconcileDeviceChange({
      current,
      devices: [scarlett, { ...c920, isDefault: true }],
      preference: auto,
      previous: scarlett.label,
    });
    expect(moved).toMatchObject({ kind: "default", label: c920.label });
  });

  it("lets a pin win, even a pin on the headset", () => {
    const pin = { pinnedLabel: headset.label };
    expect(selectInputDevice([scarlett, headset], pin, scarlett.label)).toMatchObject({
      device: headset,
      by: "pin",
    });
  });
});
