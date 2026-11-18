import { describe, expect, it } from "vite-plus/test";

import {
  grantHolds,
  grantLabel,
  grantNamed,
  lookAsks,
  LOOK_GRANT,
  standingKey,
  stands,
  withGrant,
  withScopedGrant,
} from "./consent.ts";

describe("his scoped grants", () => {
  it("names the yes his words take back, and keeps one grant per key and scope", () => {
    const schedule = standingKey("job_schedule", "It runs by itself later.");
    const keys = [LOOK_GRANT, schedule];
    expect(grantNamed(keys, "stop letting you look at my screen")).toBe(LOOK_GRANT);
    expect(grantNamed(keys, "ask me again before scheduling jobs")).toBe(schedule);
    expect(grantNamed(keys, "the kettle")).toBeNull();
    const owner = { key: LOOK_GRANT, member: "owner" };
    const twice = withScopedGrant(withScopedGrant([], owner, true), owner, true);
    expect(twice).toEqual([owner]);
    const scoped = withScopedGrant(twice, { ...owner, device: "r1" }, true);
    expect(scoped).toHaveLength(2);
    expect(withScopedGrant(scoped, owner, false)).toEqual([]);
    expect(grantHolds(scoped, LOOK_GRANT, { member: "owner", assurance: 1 }, 0)).toBe(true);
    expect(grantHolds(scoped, LOOK_GRANT, { member: null, assurance: 2 }, 0)).toBe(false);
  });
});

describe("his standing yeses", () => {
  it("he allows a look at his screen once and is never asked again on any vessel, while a guest still is", () => {
    const before = { keys: [], allowedUntil: 0, now: 1 };
    // Asked the first time on his desktop; he answers Always allow and the one list on his server keeps it.
    expect(lookAsks({ ...before, deviceTurn: false, mayLook: false })).toBe(true);
    const keys = withGrant([], LOOK_GRANT, true);
    const after = { keys, allowedUntil: 0, now: 2 };
    // His desktop, his phone and the web run as his own turns; the Tessel's turn carries his voice, verified or held.
    expect(lookAsks({ ...after, deviceTurn: false, mayLook: false })).toBe(false);
    expect(lookAsks({ ...after, deviceTurn: true, mayLook: true })).toBe(false);
    // A guest's voice, or his own unverified, on the Tessel is still asked.
    expect(lookAsks({ ...after, deviceTurn: true, mayLook: false })).toBe(true);
    // Revoked in Settings: she asks him again.
    expect(
      lookAsks({
        ...after,
        keys: withGrant(keys, LOOK_GRANT, false),
        deviceTurn: false,
        mayLook: false,
      }),
    ).toBe(true);
    // An hour he allowed holds for his own turns only.
    expect(
      lookAsks({ keys: [], allowedUntil: 10, now: 5, deviceTurn: false, mayLook: false }),
    ).toBe(false);
  });

  it("counts a job yes only for him, keeps the newest fifty, and reads back in his words", () => {
    const key = standingKey("job_schedule", "It runs by itself later.");
    expect(stands([key], key, { his: true })).toBe(true);
    expect(stands([key], key, { his: false })).toBe(false);
    const many = Array.from({ length: 60 }, (_, i) => `k${i}`).reduce<string[]>(
      (all, k) => withGrant(all, k, true),
      [],
    );
    expect(many).toHaveLength(50);
    expect(withGrant(many, "k10", true).at(-1)).toBe("k10");
    expect(grantLabel(key)).toBe("Job schedule (It runs by itself later)");
    expect(grantLabel("press_keys|That may send what is typed.|Google Chrome")).toBe(
      "Press keys in Google Chrome (That may send what is typed)",
    );
  });
});
