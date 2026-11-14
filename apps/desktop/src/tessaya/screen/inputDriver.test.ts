import { describe, expect, it, vi } from "vite-plus/test";

import type { SidecarInput } from "../voice/dictationSidecar.ts";
import { createInputDriver, createPaster, isCopyChord } from "./inputDriver.ts";

const fakeTimers = () => {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => vi.useRealTimers() };
};

describe("typing by the clipboard", () => {
  it("does not put his clipboard back under the next step's paste", async () => {
    let clip = "his";
    const pasted: string[] = [];
    const paste = createPaster(
      { readText: () => clip, writeText: (text) => void (clip = text) },
      40,
    );
    await paste("one", async () => void pasted.push(clip));
    await paste("two", async () => void pasted.push(clip));
    await vi.waitFor(() => expect(clip).toBe("his"));
    expect(pasted).toEqual(["one", "two"]);
  });

  it("presses nothing when the clipboard cannot be written", async () => {
    let pressed = false;
    const paste = createPaster({ readText: () => "old password", writeText: () => undefined }, 40);
    await expect(paste("npm test", async () => void (pressed = true))).rejects.toThrow("clipboard");
    expect(pressed).toBe(false);
  });

  it("puts his clipboard back only while the clipboard is still what it pasted, so a copy made right after is kept", async () => {
    using _timers = fakeTimers();
    let clip = "his";
    const paste = createPaster(
      { readText: () => clip, writeText: (text) => void (clip = text) },
      40,
    );
    const pasted = paste("typed words", async () => undefined);
    await vi.advanceTimersByTimeAsync(160);
    await pasted;
    // Ctrl+C in the app lands before the restore.
    clip = "copied from the app";
    await vi.advanceTimersByTimeAsync(200);
    expect(clip).toBe("copied from the app");
  });

  it("puts nothing back once a copy chord is pressed, even when the copied text equals what was pasted", async () => {
    using _timers = fakeTimers();
    let clip = "his";
    const paste = createPaster(
      { readText: () => clip, writeText: (text) => void (clip = text) },
      40,
    );
    const pasted = paste("hello", async () => undefined);
    await vi.advanceTimersByTimeAsync(160);
    await pasted;
    expect(isCopyChord(["ctrl", "c"])).toBe(true);
    expect(isCopyChord(["ctrl", "v"])).toBe(false);
    // Copying "hello" from the app: the same text, so only the chord can tell.
    paste.cancelRestore();
    await vi.advanceTimersByTimeAsync(200);
    expect(clip).toBe("hello");
  });
});

describe("the Windows hands through the sidecar", () => {
  it("clicks, scrolls and presses through the sidecar in physical pixels, and types through its paste, never the clipboard", async () => {
    const sent: SidecarInput[] = [];
    const pasted: string[] = [];
    const driver = createInputDriver({
      platform: "win32",
      toPhysical: (p) => ({ x: p.x * 1.5, y: p.y * 1.5 }),
      clipboard: {
        readText: () => {
          throw new Error("the clipboard was touched");
        },
        writeText: () => undefined,
      },
      sidecar: () => ({
        input: async (command) => void sent.push(command),
        target: async () => 7,
        pasteInto: async (text, target) => (pasted.push(`${target}:${text}`), true),
        paste: async () => {
          throw new Error("pasted without a target");
        },
      }),
    });
    await driver.clickAt({ x: 10, y: 20 }, "left", 2);
    await driver.scrollAt(null, -1);
    await driver.press(["ctrl", "a"]);
    await driver.type("secret");
    expect(sent).toEqual([
      { op: "at", x: 15, y: 30, buttons: [2, 4, 2, 4] },
      { op: "at", buttons: [0x800], wheel: -120 },
      { op: "keys", vks: [0x11, 0x41] },
    ]);
    expect(pasted).toEqual(["7:secret"]);
  });

  it("when the window cannot be told apart, pastes plain text through the sidecar and refuses a secret, never using the clipboard", async () => {
    const pasted: string[] = [];
    const clipboard = {
      readText: () => {
        throw new Error("the clipboard was touched");
      },
      writeText: () => undefined,
    };
    const hands = {
      input: async () => undefined,
      target: async () => null,
      pasteInto: async () => true,
      paste: async (text: string) => void pasted.push(text),
    };
    const driver = createInputDriver({
      platform: "win32",
      toPhysical: (p) => p,
      clipboard,
      sidecar: () => hands,
    });
    await driver.type("hello");
    expect(pasted).toEqual(["hello"]);
    await expect(driver.type("vault value", true)).rejects.toThrow("secret was not typed");
    const noHelper = createInputDriver({
      platform: "win32",
      toPhysical: (p) => p,
      clipboard,
      sidecar: () => null,
    });
    await expect(noHelper.type("vault value", true)).rejects.toThrow(
      "never goes through the clipboard",
    );
    expect(pasted).toEqual(["hello"]);
  });
});
