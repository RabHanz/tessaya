import { describe, expect, it } from "vite-plus/test";

import { createCommandClips, keyCommandOf, withoutTrailingCommand } from "./keyCommands.ts";

const frame = (loud: boolean) => ({ level: loud ? 0.4 : 0.02, pcm: new Int16Array(512) });

describe("a spoken stop or cancel while a key dictation records", () => {
  it("hears only a whole command, never the words he dictates", () => {
    expect(keyCommandOf("Stop dictation.")).toBe("stop");
    expect(keyCommandOf("stop dictating")).toBe("stop");
    expect(keyCommandOf("Cancel.")).toBe("cancel");
    expect(keyCommandOf("scratch that")).toBe("cancel");
    // Dictated words that hold a command are words, not a command.
    expect(keyCommandOf("we should stop the build")).toBeNull();
    expect(keyCommandOf("please cancel the order tomorrow")).toBeNull();
    expect(keyCommandOf("")).toBeNull();
  });

  it("cuts a short utterance with a pause after it, and lets long speech run on", () => {
    // 32 ms frames at 16 kHz: 10 loud frames, then a 15-frame pause, is one short clip.
    const clips = createCommandClips();
    const seen: number[] = [];
    for (let i = 0; i < 10; i += 1) clips.feed(frame(true));
    for (let i = 0; i < 15; i += 1) {
      const clip = clips.feed(frame(false));
      if (clip !== null) seen.push(clip.length);
    }
    expect(seen).toHaveLength(1);
    // A long stretch of dictation (4 s) is not a command clip.
    const long = createCommandClips();
    let any = false;
    for (let i = 0; i < 125; i += 1) any = long.feed(frame(true)) !== null || any;
    for (let i = 0; i < 15; i += 1) any = long.feed(frame(false)) !== null || any;
    expect(any).toBe(false);
  });

  it("takes the command off the end of the dictation it ended", () => {
    expect(withoutTrailingCommand("Send the report today. Stop dictation.")).toBe(
      "Send the report today.",
    );
    expect(withoutTrailingCommand("Send the report today")).toBe("Send the report today");
  });
});
