import { describe, expect, it, vi } from "vite-plus/test";

import { cleanupLevelNow } from "./cleanupLevel.ts";

const editor = { exe: "Code.exe", title: "notes.md" };

describe("the clean-up level at release", () => {
  it("asks which window is in front only when Claude could be stepped down", async () => {
    const foreground = vi.fn(async () => editor);
    expect(await cleanupLevelNow("local", editor, foreground, 500)).toBe("local");
    expect(await cleanupLevelNow<"claude" | "off">("off", editor, foreground, 500)).toBe("off");
    expect(foreground).not.toHaveBeenCalled();
    expect(await cleanupLevelNow<"claude">("claude", editor, foreground, 500)).toBe("claude");
    expect(foreground).toHaveBeenCalledOnce();
  });

  it("steps Claude down for a private window in front", async () => {
    const vault = { exe: "1Password.exe", title: "Vault" };
    expect(await cleanupLevelNow<"claude">("claude", editor, async () => vault, 500)).toBe("local");
  });
});
