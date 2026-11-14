import { describe, expect, it, vi } from "vite-plus/test";

import { createEscapeKey } from "./escapeKey.ts";

describe("the shared Esc key", () => {
  it("goes to the newest of equals and frees the key when the last lets go", () => {
    const calls: string[] = [];
    let press: (() => void) | null = null;
    const hold = createEscapeKey({
      register: (_, callback) => {
        calls.push("register");
        press = callback;
      },
      unregister: () => calls.push("unregister"),
    });
    const heard: string[] = [];
    const first = hold(() => heard.push("first"));
    const second = hold(() => heard.push("second"));
    press!();
    second();
    press!();
    first();
    first();
    expect(heard).toEqual(["second", "first"]);
    expect(calls).toEqual(["register", "unregister"]);
  });

  it("lets an Esc that Tessaya sends itself reach the app, and holds the key again after", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const calls: string[] = [];
    const hold = createEscapeKey({
      register: () => calls.push("register"),
      unregister: () => calls.push("unregister"),
    });
    const release = hold(() => undefined, "drive");
    const sent = hold.own(async () => {
      calls.push("send");
      return 7;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await sent).toBe(7);
    expect(calls).toEqual(["register", "unregister", "send", "register"]);
    release();
    await hold.own(async () => void calls.push("send"));
    expect(calls).toEqual(["register", "unregister", "send", "register", "unregister", "send"]);
  });

  it("takes the drive first, then the recording, then the card, past one that throws", () => {
    let press: (() => void) | null = null;
    const hold = createEscapeKey({
      register: (_, callback) => (press = callback),
      unregister: () => {},
    });
    const heard: string[] = [];
    const recording = hold(() => heard.push("recording"), "recording");
    const card = hold(() => heard.push("card"));
    const drive = hold(() => {
      throw new Error("broken");
    }, "drive");
    press!();
    expect(heard).toEqual(["recording"]);
    drive();
    recording();
    press!();
    card();
    expect(heard).toEqual(["recording", "card"]);
  });
});
