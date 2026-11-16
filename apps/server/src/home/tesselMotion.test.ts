import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_TESSAYA_HAPTICS } from "@t3tools/contracts";

import { freshSeen, hapticLevel, motionMoment, type HapticAsk } from "./tesselMotion.ts";

const motion = (kind: string, more: Record<string, unknown> = {}) => ({
  v: 1,
  kind,
  conf: 0.6,
  intensity: 10,
  in: { session: false, call: false, period: "day" },
  ...more,
});
const place = (placement: string) => ({ v: 1, placement, pconf: 0.9 });

describe("motionMoment", () => {
  it("turns the firmware's moves into her moments, a strong one cutting into a talk", () => {
    const seen = freshSeen();
    const talking = { in: { session: true, call: false } };
    expect(motionMoment("event/motion", motion("shake", talking), seen, 0)).toEqual({
      how: "shaken",
      strong: false,
      busy: true,
      live: true,
    });
    expect(
      motionMoment("event/motion", motion("shake", { ...talking, intensity: 80 }), seen, 0),
    ).toEqual({ how: "shaken", strong: true, busy: false, live: true });
    expect(motionMoment("event/motion", motion("drop", { conf: 1 }), seen, 0)?.how).toBe("dropped");
    // Free fall with no landing, face down (her do-not-disturb): nothing to say.
    expect(motionMoment("event/motion", motion("drop", { conf: 0.5 }), seen, 0)).toBeNull();
    expect(motionMoment("event/motion", motion("face_down"), seen, 0)).toBeNull();
  });

  it("hears a gentle pick-up in the placement alone, once per handling", () => {
    // 16 Nov 07:30: dock to carried with no lift event.
    const seen = freshSeen();
    expect(motionMoment("state/placement", place("dock"), seen, 0)).toBeNull();
    expect(motionMoment("state/placement", place("handheld"), seen, 1)?.how).toBe("lifted");
    expect(motionMoment("state/placement", place("carried"), seen, 2)?.how).toBe("carried");
    expect(motionMoment("state/placement", place("desk"), seen, 3)?.how).toBe("setdown");

    motionMoment("event/motion", motion("lift"), seen, 100_000);
    expect(motionMoment("state/placement", place("handheld"), seen, 101_000)).toBeNull();
  });

  it("knows a move is during a talk from the Tessel's own voice events, and older firmware's session events", () => {
    // SMP firmware says state/voice start/stop, never event/session/* (16 Nov 12:36Z: carried after a talk ended).
    for (const [start, stop] of [
      [
        ["state/voice", { ev: "start", transport: "inhouse" }],
        ["state/voice", { ev: "stop" }],
      ],
      [
        ["event/session/start", null],
        ["event/session/end", null],
      ],
    ] as const) {
      const seen = freshSeen();
      motionMoment("state/placement", place("desk"), seen, 0);
      motionMoment(start[0], start[1], seen, 0);
      expect(motionMoment("state/placement", place("handheld"), seen, 1)).toMatchObject({
        busy: true,
        live: true,
      });
      motionMoment(stop[0], stop[1], seen, 2);
      expect(motionMoment("state/placement", place("carried"), seen, 3)?.live).toBe(false);
      expect(motionMoment("event/motion", motion("lift"), seen, 4)?.live).toBe(false);
    }
  });
});

describe("hapticLevel", () => {
  const ask = (more: Partial<HapticAsk> = {}): HapticAsk => ({
    pattern: "giggle",
    category: "reactions",
    placement: "handheld",
    quiet: false,
    batteryPct: 80,
    charging: false,
    ...more,
  });
  const on = DEFAULT_TESSAYA_HAPTICS;

  it("follows his intensity and toggles, and stays still in quiet hours", () => {
    expect(hapticLevel(on, ask())).toBe(2);
    expect(hapticLevel({ ...on, intensity: "high" }, ask())).toBe(3);
    expect(hapticLevel({ ...on, intensity: "off" }, ask())).toBeNull();
    expect(hapticLevel({ ...on, reactions: false }, ask())).toBeNull();
    expect(hapticLevel(on, ask({ quiet: true }))).toBeNull();
  });

  it("is softer on a hard desk, silent where nobody feels it, and lets only a nudge through face down", () => {
    expect(hapticLevel(on, ask({ placement: "desk" }))).toBe(1);
    expect(hapticLevel({ ...on, intensity: "low" }, ask({ placement: "dock" }))).toBe(1);
    expect(hapticLevel(on, ask({ placement: "carried" }))).toBeNull();
    expect(hapticLevel(on, ask({ placement: "bedside" }))).toBeNull();
    expect(hapticLevel(on, ask({ placement: "face_down" }))).toBeNull();
    expect(
      hapticLevel(on, ask({ placement: "face_down", pattern: "nudge", category: "reminders" })),
    ).toBe(2);
    // A wake or reminder buzz is for a hand only.
    expect(hapticLevel(on, ask({ placement: "desk", category: "wake" }))).toBeNull();
    expect(hapticLevel(on, ask({ category: "wake", pattern: "double_tap" }))).toBe(2);
  });

  it("saves a low battery, unless it is charging", () => {
    expect(hapticLevel(on, ask({ batteryPct: 20 }))).toBe(1);
    expect(hapticLevel(on, ask({ batteryPct: 5 }))).toBeNull();
    expect(hapticLevel(on, ask({ batteryPct: 5, charging: true }))).toBe(2);
  });
});
