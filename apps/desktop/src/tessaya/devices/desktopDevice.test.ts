import { describe, expect, it } from "vite-plus/test";

import {
  classifyPnp,
  desktopDeviceId,
  desktopManifest,
  desktopValues,
  settingOfWrite,
  startDesktopDevice,
  type DesktopFacts,
} from "./desktopDevice.ts";

const facts: DesktopFacts = {
  controls: [
    {
      id: "v.mic",
      section: "Wake and listening",
      label: "Microphone",
      kind: "choice",
      value: "",
      options: [
        { value: "", label: "Automatic" },
        { value: "Microphone (DJI MIC MINI)", label: "Microphone (DJI MIC MINI)" },
      ],
    },
    { id: "v.doubleTap", section: "Dictation", label: "Double-tap", kind: "toggle", on: true },
  ],
  screens: ["DELL U2720Q 3840x2160"],
  onBattery: false,
  locked: false,
  idleSeconds: 130,
  scan: classifyPnp(
    [
      { Class: "Camera", FriendlyName: "Integrated Camera", InstanceId: "USB\\VID_04F2" },
      { Class: "Camera", FriendlyName: "Integrated IR Camera", InstanceId: "USB\\VID_04F2&MI_02" },
      {
        Class: "Biometric",
        FriendlyName: "Synaptics FS7605 Touch Fingerprint Sensor",
        InstanceId: "USB\\VID_06CB",
      },
      { Class: "USB", FriendlyName: "USB Root Hub (USB 3.0)", InstanceId: "USB\\ROOT_HUB30" },
      { Class: "MEDIA", FriendlyName: "DJI MIC MINI", InstanceId: "USB\\VID_2CA3" },
      {
        Class: "Bluetooth",
        FriendlyName: "Intel(R) Wireless Bluetooth(R)",
        InstanceId: "USB\\VID_8087",
      },
      { Class: "Bluetooth", FriendlyName: "WH-1000XM4", InstanceId: "BTHENUM\\DEV_14C600000001" },
      {
        Class: "SmartCardReader",
        FriendlyName: "Realtek Card Reader",
        InstanceId: "PCI\\VEN_10EC",
      },
    ],
    { EstimatedChargeRemaining: 14, BatteryStatus: 1 },
  ),
};

describe("the desktop's manifest", () => {
  it("names his peripherals, leaves out the plumbing, and marks webcams and Windows Hello private", () => {
    const m = desktopManifest({
      deviceId: desktopDeviceId("Kitchen-PC"),
      name: "Laptop",
      appVersion: "0.1.120",
      facts,
    });
    expect(m.deviceId).toBe("desktop-kitchen-pc");
    expect(m.items.find((i) => i.id === "audio.input")).toMatchObject({
      type: "enum",
      access: "read,write",
      safety: "confirm",
      values: ["Automatic", "Microphone (DJI MIC MINI)"],
    });
    expect(m.items.find((i) => i.id === "camera.devices")?.privacy).toBe(true);
    const values = Object.fromEntries(desktopValues(facts).map((v) => [v.itemId, v.value]));
    expect(values).toMatchObject({
      "audio.input": "Automatic",
      "camera.devices": "Integrated Camera, Integrated IR Camera",
      "biometric.hello": true,
      "peripherals.usb": "DJI MIC MINI",
      "peripherals.bluetooth": "WH-1000XM4",
      "peripherals.cardreader": "Realtek Card Reader",
      "bt.paired": [{ name: "WH-1000XM4", mac: "14:C6:00:00:00:01" }],
      "power.battery_pct": 14,
      "power.charging": false,
      "presence.idle": 120,
    });
  });

  it("applies a write to a voice choice as that setting, and refuses one it does not take", () => {
    expect(settingOfWrite({ itemId: "audio.input", value: "Automatic" })).toEqual(["v.mic", ""]);
    expect(settingOfWrite({ itemId: "mic.awake", value: "off" })).toEqual(["v.micAwake", "off"]);
    expect(settingOfWrite({ itemId: "screen.list", value: "x" })).toBeNull();
  });
});

describe("the desktop as a vessel", () => {
  it("hands a write to its companion or an action to its handler and acks whether it could", async () => {
    const asked: Array<string> = [];
    const ran: Array<string> = [];
    const sent: Array<Record<string, unknown>> = [];
    let answered: (() => void) | null = null;
    const acked = new Promise<void>((resolve) => (answered = resolve));
    const device = startDesktopDevice({
      publish: (body) => {
        sent.push(body);
        if (sent.length === 1)
          return Promise.resolve({
            writes: [
              { id: "w1", itemId: "mascot.do", value: "wave" },
              { id: "w2", itemId: "mascot.do", value: "otherScreen" },
              { id: "w3", itemId: "mascot.do", value: "explode" },
              { id: "w4", itemId: "action.mute", value: null },
              { id: "w5", itemId: "action.hold", value: null },
            ],
          });
        answered?.();
        return new Promise(() => undefined);
      },
      deviceId: "desktop-test",
      name: "Test",
      appVersion: "0",
      platform: "linux",
      facts: () => ({ controls: [], screens: [], onBattery: false, locked: false, idleSeconds: 0 }),
      applySetting: () => undefined,
      onNote: () => undefined,
      onMascot: (act) => (asked.push(act), act === "wave"),
      onAction: (id) => (ran.push(id), true),
      onChange: () => () => undefined,
    });
    await acked;
    device.stop();
    expect(asked).toEqual(["wave", "otherScreen"]);
    expect(sent[1]?.["acks"]).toEqual([
      { id: "w1", ok: true },
      { id: "w2", ok: false, error: "She is not on the desktop right now." },
      { id: "w3", ok: false, error: "She is not on the desktop right now." },
      { id: "w4", ok: true },
      { id: "w5", ok: false, error: "This computer cannot do that now." },
    ]);
    expect(ran).toEqual(["mute"]);
    const manifest = sent[0]?.["manifest"] as { items: Array<{ id: string; values?: unknown }> };
    expect(manifest.items.find((i) => i.id === "mascot.do")?.values).toContain("signature");
  });
});
