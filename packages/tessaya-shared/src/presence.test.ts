import { describe, expect, it } from "vite-plus/test";

import {
  fusePresence,
  PRESENCE_BARS,
  routeProactive,
  type PresenceSignal,
  type ProactiveKind,
} from "./presence.ts";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const sig = (
  member: string | null,
  source: string,
  vessel: string | null,
  minutesAgo: number,
): PresenceSignal => ({ member, source, vessel, at: NOW - minutesAgo * MIN });
const of = (signals: ReadonlyArray<PresenceSignal>, member: string) =>
  fusePresence(signals, NOW).members.find((m) => m.member === member);

describe("fusePresence", () => {
  it("decays each signal by its half-life and forgets after a day", () => {
    const fresh = of([sig("omid", "voice", "kitchen", 0)], "omid");
    const half = of([sig("omid", "voice", "kitchen", 15)], "omid");
    expect(fresh?.confidence).toBeCloseTo(0.95);
    expect(half?.confidence).toBeCloseTo(0.475);
    // About ten minutes to the follow bar, about thirty to "around", as the old fixed windows were.
    expect(of([sig("omid", "voice", "k", 9)], "omid")!.confidence).toBeGreaterThan(
      PRESENCE_BARS.present,
    );
    expect(of([sig("omid", "voice", "k", 12)], "omid")!.confidence).toBeLessThan(
      PRESENCE_BARS.present,
    );
    expect(of([sig("omid", "voice", "k", 28)], "omid")!.confidence).toBeGreaterThan(
      PRESENCE_BARS.around,
    );
    expect(of([sig("omid", "voice", "k", 31)], "omid")!.confidence).toBeLessThan(
      PRESENCE_BARS.around,
    );
    expect(of([sig("omid", "voice", "k", 25 * 60)], "omid")).toBeUndefined();
  });

  it("fuses independent signals and places them at the strongest vessel", () => {
    const p = of(
      [
        sig("omid", "voice", "kitchen", 20),
        sig("omid", "device", null, 0),
        sig("omid", "typed", "desk", 1),
      ],
      "omid",
    )!;
    // More than any one signal alone.
    expect(p.confidence).toBeGreaterThan(0.95);
    expect(p.nearest?.vessel).toBe("desk");
    expect(p.lastSeen).toEqual({ at: NOW, source: "device", vessel: null });
    expect(p.evidence.map((e) => e.source)).toEqual(["typed", "device", "voice"]);
  });

  it("keeps many members apart, and an unknown someone only marks the vessel occupied", () => {
    const e = fusePresence(
      [
        sig("omid", "voice", "kitchen", 1),
        sig("sara", "voice", "study", 2),
        sig(null, "handled", "lounge", 0),
      ],
      NOW,
    );
    expect(e.members.map((m) => [m.member, m.nearest?.vessel])).toEqual([
      ["omid", "kitchen"],
      ["sara", "study"],
    ]);
    expect(e.occupied.get("lounge")).toBeCloseTo(0.6);
    expect(e.members.some((m) => m.nearest?.vessel === "lounge")).toBe(false);
  });

  it("a locked desktop cancels the typing before it, not after, nor their voice", () => {
    const away = [sig("omid", "typed", "desk", 3), sig("omid", "deskAway", null, 1)];
    expect(of(away, "omid")?.nearest).toBeNull();
    expect(of([...away, sig("omid", "typed", "desk", 0)], "omid")?.nearest?.vessel).toBe("desk");
    expect(of([...away, sig("omid", "voice", "kitchen", 0)], "omid")?.nearest?.vessel).toBe(
      "kitchen",
    );
  });

  it("a new source is a row of data", () => {
    const e = fusePresence([sig("omid", "headphones", null, 0)], NOW, {
      headphones: { weight: 0.5, halfLifeMinutes: 5, says: "your headphones are on" },
    });
    expect(e.members[0]?.confidence).toBeCloseTo(0.5);
    // An unknown source counts for nothing.
    expect(of([sig("omid", "nonsense", "k", 0)], "omid")?.confidence).toBe(0);
  });
});

describe("routeProactive", () => {
  const speakers = new Set(["kitchen", "study", "desk"]);
  const route = (
    kind: ProactiveKind,
    signals: ReadonlyArray<PresenceSignal>,
    origin: string | null = "study",
    follow = true,
  ) =>
    routeProactive({
      kind,
      member: "omid",
      origin,
      estimate: fusePresence(signals, NOW),
      speakers,
      follow,
    });
  const here = [sig("omid", "voice", "kitchen", 1)];

  it("her own line follows him to the vessel he is nearest", () => {
    expect(route("personal", here)).toMatchObject({ action: "speak", vessel: "kitchen" });
  });

  it("stays quiet when he is not there, or only someone else is", () => {
    expect(route("personal", [])).toMatchObject({ action: "quiet", why: "they are not around" });
    expect(route("personal", [sig("sara", "voice", "study", 0)])).toMatchObject({
      action: "quiet",
    });
    // Around (his phone) but not placed: still not out loud.
    expect(route("personal", [sig("omid", "device", null, 0)])).toMatchObject({
      action: "quiet",
      why: "they can't be placed at a vessel",
    });
    // Placed, but nowhere that can speak.
    expect(route("personal", [sig("omid", "voice", "phone", 0)])).toMatchObject({
      action: "quiet",
    });
  });

  it("with follow off, speaks only where it started", () => {
    expect(route("personal", here, "study", false)).toMatchObject({ action: "quiet" });
    expect(route("personal", [sig("omid", "voice", "study", 1)], "study", false)).toMatchObject({
      action: "speak",
      vessel: "study",
    });
  });

  it("reminders, broadcasts and planned items follow him when they can, else land where they were set", () => {
    for (const kind of ["reminder", "broadcast", "planned"] as const) {
      expect(route(kind, here)).toMatchObject({ action: "speak", vessel: "kitchen" });
      expect(route(kind, [])).toMatchObject({ action: "speak", vessel: "study" });
      expect(route(kind, here, "study", false)).toMatchObject({ action: "speak", vessel: "study" });
      expect(route(kind, [], null)).toMatchObject({ action: "quiet" });
    }
  });
});
