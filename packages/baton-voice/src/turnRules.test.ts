import { describe, expect, it } from "vite-plus/test";

import {
  addressedAtDesk,
  addressedInRoom,
  beganOverHer,
  echoVerdict,
  type Playback,
} from "./turnRules.ts";

const p: Playback = { playUntil: 10_000, downDelayMs: 200, echoTailMs: 800, upDelayMs: 100 };
const facts = (over: Partial<Parameters<typeof echoVerdict>[0]> = {}) => ({
  startedAt: 9_000,
  lastVoice: 9_500,
  called: false,
  own: false,
  likeness: () => 0.6,
  ...over,
});

describe("turn rules every vessel shares", () => {
  it("a line that began while her voice could still be heard is tainted, and one after its tail is not", () => {
    expect(beganOverHer(10_200 + 800, p)).toBe(true);
    expect(beganOverHer(10_200 + 801, p)).toBe(false);
  });

  it("decides her echo as the room has since 13 Nov", () => {
    // During her playback, her own words or a fair likeness are her.
    expect(echoVerdict(facts({ own: true, likeness: () => 0 }), p).hers).toBe(true);
    expect(echoVerdict(facts({ likeness: () => 0.5 }), p).hers).toBe(true);
    // Two voices following each other by chance (0.4 to 0.6) are his.
    expect(echoVerdict(facts({ likeness: () => 0.45 }), p)).toMatchObject({
      hers: false,
      compared: true,
    });
    // In the tail only a near match is her.
    const tail = { startedAt: 10_600, lastVoice: 10_700 };
    expect(echoVerdict(facts({ ...tail, likeness: () => 0.7 }), p).hers).toBe(false);
    expect(echoVerdict(facts({ ...tail, likeness: () => 0.8 }), p).hers).toBe(true);
    expect(echoVerdict(facts({ ...tail, own: true, likeness: () => 0.6 }), p).hers).toBe(true);
    // After her tail, or a name he called that is not inside her own words: him, with no comparison.
    expect(echoVerdict(facts({ startedAt: 11_100 }), p)).toMatchObject({
      hers: false,
      compared: false,
    });
    expect(echoVerdict(facts({ called: true }), p)).toMatchObject({ hers: false, compared: false });
    // "Freya here" in her own reply, during it, is her.
    expect(echoVerdict(facts({ called: true, own: true }), p).hers).toBe(true);
  });

  it("a room takes anything in its window but a stray yeah; a desk takes only what reads as meant for her", () => {
    const w = { firstUntil: 1_000, openUntil: 5_000, invited: false };
    expect(addressedInRoom("turn it off", false, 3_000, w)).toBe(true);
    expect(addressedInRoom("yeah", false, 3_000, w)).toBe(false);
    expect(addressedInRoom("yeah", false, 3_000, { ...w, invited: true })).toBe(true);
    expect(addressedInRoom("yeah", false, 500, w)).toBe(true);
    expect(addressedInRoom("turn it off", false, 6_000, w)).toBe(false);
    expect(addressedInRoom("anything", true, 60_000, w)).toBe(true);
    expect(addressedAtDesk("the weather was nice today", false)).toBe(false);
    expect(addressedAtDesk("what's the weather", false)).toBe(true);
    expect(addressedAtDesk("the weather was nice today", true)).toBe(true);
  });
});
