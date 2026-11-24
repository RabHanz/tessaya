import { describe, expect, it } from "vite-plus/test";

import { createMicWatch, segmentAudioFault } from "./micWatch.ts";

const stage2 = { outcome: "no fire", woke: false, best: {} };
// A voice-like segment: a 220 Hz tone with a little noise, peak ~900 (his far-field level, 23 Nov).
const voiced = () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 60;
  return Int16Array.from({ length: 32_000 }, (_, i) =>
    Math.round(850 * Math.sin((2 * Math.PI * 220 * i) / 16000) + rnd()),
  );
};
const hiss = () => {
  let seed = 7;
  return Int16Array.from(
    { length: 32_000 },
    () => ((seed = (seed * 16807) % 2147483647) % 1600) - 800,
  );
};
const silent = () => new Int16Array(32_000).fill(3);

describe("the mic watch", () => {
  it("tells silence and hiss from a voice", () => {
    expect(segmentAudioFault(voiced())).toBeNull();
    expect(segmentAudioFault(silent())).toBe("silent");
    expect(segmentAudioFault(hiss())).toBe("hiss");
  });

  it("restarts her listening once per streak of bad segments, and a voice starts the count over", () => {
    const restarts: string[] = [];
    const lines: string[] = [];
    const watch = createMicWatch({
      runs: 3,
      restart: (id) => restarts.push(id),
      log: (l) => lines.push(l),
    });
    const feed = (pcm: Int16Array) => watch.segment("r1-a", undefined, pcm, stage2);
    feed(silent());
    feed(silent());
    feed(voiced());
    feed(silent());
    feed(hiss());
    expect(restarts).toEqual([]);
    feed(silent());
    feed(silent());
    feed(silent());
    expect(restarts).toEqual(["r1-a"]);
    watch.segment("r1-b", undefined, silent(), stage2);
    expect(restarts).toEqual(["r1-a"]);
    feed(voiced());
    expect(lines.at(-1)).toContain("voice again");
  });
});
