import { describe, expect, it } from "vite-plus/test";

import { capturingApps, startPersonaLayerLink } from "./personaLayerLink.ts";

const REG = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe
    LastUsedTimeStart    REG_QWORD    0x1db3f0a2c1d4e00
    LastUsedTimeStop    REG_QWORD    0x0

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#me#AppData#Local#Programs#Tessaya#resources#tessaya-voice.exe
    LastUsedTimeStart    REG_QWORD    0x1db3f0a2c1d4e00
    LastUsedTimeStop    REG_QWORD    0x0

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Tools#Recorder.exe
    LastUsedTimeStart    REG_QWORD    0x1db3f0a2c1d4e00
    LastUsedTimeStop    REG_QWORD    0x1db3f0a2c1d5000
`;

describe("capturingApps", () => {
  it("names apps holding the microphone now, never this app's own folder or one that stopped", () => {
    const busy = capturingApps(REG, "C:\\Users\\me\\AppData\\Local\\Programs\\Tessaya");
    expect(busy).toHaveLength(1);
    expect(busy[0]).toContain("Zoom.exe");
  });
});

describe("startPersonaLayerLink", () => {
  it("stops after one request on a server without a layer and never makes a key", async () => {
    const posts: Array<unknown> = [];
    let keys = 0;
    const link = startPersonaLayerLink({
      post: async (body) => (posts.push(body), null),
      deviceKey: () => (keys++, "k"),
      othersCapturing: async () => false,
      shield: () => undefined,
      everyMs: 60_000,
    });
    await link.ready;
    await link.signal("screenLocked");
    expect(posts).toHaveLength(1);
    expect(keys).toBe(0);
  });

  it("sends the key once a layer answers, shields while a session is open, and reports a call then", async () => {
    const posts: Array<{ key?: string; signals: ReadonlyArray<string> }> = [];
    const shield: Array<boolean> = [];
    let open = true;
    const link = startPersonaLayerLink({
      post: async (body) => (posts.push(body), { open }),
      deviceKey: () => "k",
      othersCapturing: async () => true,
      shield: (on) => void shield.push(on),
      everyMs: 60_000,
    });
    await link.ready;
    expect(posts[0]).toEqual({ signals: [] });
    expect(posts[1]?.key).toBe("k");
    expect(shield).toEqual([true]);
    open = false;
    await link.signal("screenLocked");
    expect(posts.at(-1)?.signals).toEqual(expect.arrayContaining(["screenLocked", "call"]));
    expect(shield).toEqual([true, false]);
    link.stop();
  });
});
