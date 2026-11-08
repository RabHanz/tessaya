import { describe, expect, it } from "vite-plus/test";

import { createCommandClips } from "./keyCommands.ts";

const frame = (loud: boolean) => ({ level: loud ? 0.4 : 0.02, pcm: new Int16Array(512) });
const feed = (
  clips: ReturnType<typeof createCommandClips>,
  pattern: ReadonlyArray<[boolean, number]>,
) => {
  const out: number[] = [];
  for (const [loud, n] of pattern)
    for (let i = 0; i < n; i += 1) {
      const clip = clips.feed(frame(loud));
      if (clip !== null) out.push(clip.length);
    }
  return out;
};

describe("the clips a spoken command is heard in while a key dictation records", () => {
  it("cuts a short utterance with a pause after it, with a little quiet before it for a soft first sound", () => {
    // 32 ms frames: quiet, 10 loud frames, then a 15-frame pause is one clip, with 3 frames of pre-roll.
    const clips = createCommandClips();
    expect(
      feed(clips, [
        [false, 5],
        [true, 10],
        [false, 15],
      ]),
    ).toEqual([(3 + 10 + 12) * 512]);
  });

  it("lets long speech run on, and drops a sound too short to be a command", () => {
    expect(
      feed(createCommandClips(), [
        [true, 125],
        [false, 15],
      ]),
    ).toEqual([]);
    expect(
      feed(createCommandClips(), [
        [true, 3],
        [false, 15],
      ]),
    ).toEqual([]);
  });
});
