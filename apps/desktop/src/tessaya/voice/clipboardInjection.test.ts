import { describe, expect, it } from "vite-plus/test";

import { makeClipboardInjection, pasteCommand } from "./clipboardInjection.ts";

describe("clipboard dictation", () => {
  it("pastes with SendKeys on Windows only", () => {
    expect(pasteCommand("win32")?.file).toBe("powershell.exe");
    expect(pasteCommand("linux")).toBeNull();
    expect(pasteCommand("darwin")).toBeNull();
  });

  it("refuses by name elsewhere, without touching the clipboard", async () => {
    let writes = 0;
    const adapter = makeClipboardInjection({
      platform: "linux",
      clipboard: { readText: () => "mine", writeText: () => void writes++ },
    });
    const target = {
      producer: "desktop",
      kind: "editable",
      label: "the focused field",
      injectable: true,
      origin: null,
    } as const;
    expect(adapter.canInject(target)).toBe(false);
    await expect(adapter.insertText({ target, text: "hello" })).rejects.toThrow(/paste/);
    expect(writes).toBe(0);
  });
});
