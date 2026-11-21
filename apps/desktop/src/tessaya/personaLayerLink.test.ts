import { describe, expect, it } from "vite-plus/test";

import {
  capturingApps,
  createLayerHello,
  createWindowCloseEnd,
  startPersonaLayerLink,
} from "./personaLayerLink.ts";

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

  it("carries her desk world with each report, and reports at once when asked", async () => {
    const posts: Array<{ world?: { fullscreen: boolean } }> = [];
    let fullscreen = false;
    const link = startPersonaLayerLink({
      post: async (body) => (posts.push(body), { open: false, page: null }),
      deviceKey: () => null,
      othersCapturing: async () => false,
      shield: () => undefined,
      world: () => ({ fullscreen }),
      everyMs: 60_000,
    });
    await link.ready;
    fullscreen = true;
    await link.report();
    expect(posts.at(-1)?.world).toEqual({ fullscreen: true });
    link.stop();
  });

  it("sends the key once a layer answers, shields while a session is open, and reports a call then", async () => {
    const posts: Array<{ key?: string; signals: ReadonlyArray<string> }> = [];
    const shield: Array<boolean> = [];
    let open = true;
    const link = startPersonaLayerLink({
      post: async (body) => (
        posts.push(body),
        { open, page: "/tessaya/layer/x", persona: "freya" }
      ),
      deviceKey: () => "k",
      othersCapturing: async () => true,
      shield: (on) => void shield.push(on),
      everyMs: 60_000,
    });
    await link.ready;
    expect(posts[0]).toEqual({ signals: [] });
    expect(posts[1]?.key).toBe("k");
    expect(shield).toEqual([true]);
    expect(link.page()).toBe("/tessaya/layer/x");
    // the companion it opened with, so only she takes the private form
    expect(link.persona()).toBe("freya");
    open = false;
    await link.signal("screenLocked");
    expect(posts.at(-1)?.signals).toEqual(expect.arrayContaining(["screenLocked", "call"]));
    expect(shield).toEqual([true, false]);
    expect(link.persona()).toBeNull();
    link.stop();
  });
});

describe("createWindowCloseEnd", () => {
  it("ends the private moment the moment his last private window closes", () => {
    let ended = 0;
    const shown: Array<boolean> = [];
    const w = createWindowCloseEnd({ end: () => void ended++, shown: (on) => void shown.push(on) });
    w.opened();
    w.opened();
    // one of two closed: the other still holds it
    w.closed();
    expect([ended, shown]).toEqual([0, [true]]);
    // the last one closed: her private form leaves and the moment ends on that call, once
    w.closed();
    expect([ended, shown]).toEqual([1, [true, false]]);
    w.closed();
    expect(ended).toBe(1);
  });
});

describe("createLayerHello", () => {
  const make = (result: "verified" | "declined" | "unavailable") => {
    const posts: Array<[string, unknown]> = [];
    const ask = createLayerHello({
      hello: async () => result,
      post: async (op, body) => (
        posts.push([op, body]),
        op === "window" ? { vessel: "pw-s1" } : { open: true }
      ),
      account: "laptop\\him",
    });
    return { ask, posts };
  };

  it("sends the window's step-up with Hello itself once Windows verifies, and the lab's unlock for the lab", async () => {
    const t = make("verified");
    expect(await t.ask("chat")).toBe(true);
    expect(await t.ask("lab")).toBe(true);
    expect(t.posts).toEqual([
      ["window", { surface: "desktop" }],
      ["activate", { surface: "desktop", vessel: "pw-s1", stepUp: { hello: "laptop\\him" } }],
      ["unlock", { stepUp: { hello: "laptop\\him" } }],
    ]);
  });

  it("sends nothing when Hello is declined or unavailable, so the page keeps its PIN", async () => {
    for (const result of ["declined", "unavailable"] as const) {
      const t = make(result);
      expect(await t.ask("chat")).toBe(false);
      expect(t.posts).toEqual([]);
    }
  });
});
