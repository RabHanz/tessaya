import { describe, expect, it, vi } from "vite-plus/test";

import { cleanupLevelNow } from "./cleanupLevel.ts";

const editor = { exe: "Code.exe", title: "notes.md" };

describe("the clean-up level at release", () => {
  it("asks which window is in front only when Claude could be stepped down", async () => {
    const foreground = vi.fn(async () => editor);
    expect(await cleanupLevelNow("local", editor, foreground, 500)).toEqual({
      level: "local",
      why: null,
    });
    expect((await cleanupLevelNow<"claude" | "off">("off", editor, foreground, 500)).level).toBe(
      "off",
    );
    expect(foreground).not.toHaveBeenCalled();
    expect(await cleanupLevelNow<"claude">("claude", editor, foreground, 500)).toEqual({
      level: "claude",
      why: null,
    });
    expect(foreground).toHaveBeenCalledOnce();
  });

  it("steps Claude down for a private window in front, and says why", async () => {
    const vault = { exe: "1Password.exe", title: "Vault" };
    expect(await cleanupLevelNow<"claude">("claude", editor, async () => vault, 500)).toEqual({
      level: "local",
      why: "private window: 1Password.exe",
    });
  });

  it("keeps Claude when the helper cannot say which window is in front", async () => {
    const chat = { exe: "Tessaya.exe", title: "Character Studio" };
    expect((await cleanupLevelNow<"claude">("claude", chat, async () => null, 500)).level).toBe(
      "claude",
    );
    vi.useFakeTimers();
    const slow = cleanupLevelNow<"claude">("claude", chat, () => new Promise(() => {}), 500);
    await vi.advanceTimersByTimeAsync(500);
    expect((await slow).level).toBe("claude");
    vi.useRealTimers();
  });
});
