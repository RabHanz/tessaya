import { describe, expect, it } from "vite-plus/test";

import { createEchoGuard } from "./echoGuard.ts";
import { runEcho, speechLike } from "./echoSim.ts";

describe("the echo guard", () => {
  it("says nothing, and trusts nothing, until it has learned the room", () => {
    const guard = createEchoGuard();
    const loud = Int16Array.from({ length: 320 }, (_, i) => Math.round(8000 * Math.sin(i / 5)));
    expect(guard.process(loud, 20)).toMatchObject({ ready: false, nearEnd: false });
  });

  it("learns the delay and cuts the echo within a second or two of speech", () => {
    const run = runEcho({
      tts: speechLike(6, 7, 110),
      seed: 3,
      unknownDelayMs: 140,
      rt60Ms: 250,
      echoRms: 0.07,
      noiseRms: 0.002,
      interruptions: [],
    });
    expect(run.readyAtS).not.toBeNull();
    expect(run.readyAtS!).toBeLessThan(4);
  });

  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- CPU-bound 16 s audio simulation, not a hidden wait.
  it("hears a loud interruption over the echo, quickly", { timeout: 30_000 }, () => {
    const run = runEcho({
      tts: speechLike(16, 7, 110),
      seed: 3,
      unknownDelayMs: 140,
      rt60Ms: 250,
      echoRms: 0.07,
      noiseRms: 0.002,
      frames: 6,
      interruptions: [{ atS: 10, seconds: 2, overEchoDb: 12, pitchHz: 190 }],
    });
    const heard = run.detections.filter((t) => t >= 10);
    expect(heard[0]).toBeDefined();
    // Onset to detection: the 120 ms confirmation and a frame or two.
    expect(heard[0]! - 10).toBeLessThan(0.5);
  });

  it("tells her voice coming back from his, judged after the turn while she plays on", () => {
    const her = speechLike(10, 3, 210);
    const him = speechLike(3, 23, 120);
    const T0 = 1_763_000_000_000;
    // Her reply as the loop sends it: 60 ms frames at most 700 ms ahead, sounding 300 ms after sending.
    const played = (guard: ReturnType<typeof createEchoGuard>, untilMs: number) => {
      for (let k = 0; k * 960 < her.length && k * 60 - 700 <= untilMs; k += 1)
        guard.reference(
          Int16Array.from(her.subarray(k * 960, (k + 1) * 960), (v) => Math.round(v * 32767)),
          T0 + k * 60 + 300,
        );
    };
    // A turn heard from 1 s to 4 s, judged 1.5 s after it ended: her echo (240 ms of Bluetooth late), or him.
    const mic = (hers: boolean) =>
      Int16Array.from({ length: 48_000 }, (_, i) =>
        Math.round(32767 * (hers ? 0.3 * (her[i + 16_000 - 4_800 - 3_840] ?? 0) : 0.5 * him[i]!)),
      );
    for (const hers of [true, false]) {
      const guard = createEchoGuard();
      played(guard, 5_500);
      const like = guard.likeness!(mic(hers), T0 + 1_000);
      if (hers) expect(like).toBeGreaterThan(0.75);
      else expect(like).toBeLessThan(0.5);
    }
    // Stopping her keeps what already played, and forgets what was flushed before it sounded.
    const guard = createEchoGuard();
    played(guard, 5_500);
    guard.reset(T0 + 3_000);
    expect(guard.likeness!(mic(true).subarray(0, 24_000), T0 + 1_000)).toBeGreaterThan(0.75);
    expect(guard.likeness!(mic(true).subarray(32_000), T0 + 3_000)).toBe(0);
  });
});
