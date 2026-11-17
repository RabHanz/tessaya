import { expect, it } from "vite-plus/test";

import {
  DEGRADE_MS,
  DWELL_MS,
  type HostLevel,
  type HostSample,
  type LevelState,
  placeRoom,
  RECOVER_MS,
  rateHost,
  UNRATED,
} from "./RoomPlacement.ts";

const starving: HostSample = { memAvailMb: 195, memPsiFull10: 30 };
const healthy: HostSample = { memAvailMb: 4_000, memPsiFull10: 0 };
const between: HostSample = { memAvailMb: 900, memPsiFull10: 10 };

/** Rates one host every 10 s through the samples, returning the level after each. */
const run = (start: LevelState, samples: ReadonlyArray<HostSample | null>, from = 0) => {
  let s = start;
  return samples.map((sample, i) => (s = rateHost(s, sample, from + i * 10_000)).level);
};
const ok0: LevelState = { level: "ok", pending: null };

it("rates a host degraded only after bad figures hold, and ok again only after good ones hold longer", () => {
  const bads = DEGRADE_MS / 10_000;
  const levels = run(ok0, Array(bads + 1).fill(starving));
  expect(levels.slice(0, bads)).toEqual(Array(bads).fill("ok"));
  expect(levels[bads]).toBe("degraded");

  const deg: LevelState = { level: "degraded", pending: null };
  const goods = RECOVER_MS / 10_000;
  const back = run(deg, Array(goods + 1).fill(healthy));
  expect(back[goods - 1]).toBe("degraded");
  expect(back[goods]).toBe("ok");
  // A host with no memory figures (not Linux) is never rated.
  const blind: HostSample = { memAvailMb: null, memPsiFull10: null };
  expect(run(UNRATED, Array(goods + 1).fill(blind)).every((l) => l === null)).toBe(true);
});

it("does not flap: a blip resets the hold, figures between the bands and missing ones keep the level", () => {
  const bads = DEGRADE_MS / 10_000;
  // Bad, one good reading, bad again: the hold starts over, so no degrade at the original deadline.
  const blip = run(ok0, [
    ...Array(bads - 1).fill(starving),
    healthy,
    ...Array(bads + 1).fill(starving),
  ]);
  expect(blip.slice(0, -1).every((l) => l === "ok")).toBe(true);
  expect(blip.at(-1)).toBe("degraded");
  expect(run(ok0, Array(50).fill(between)).every((l) => l === "ok")).toBe(true);
  const deg: LevelState = { level: "degraded", pending: null };
  expect(
    run(deg, [...Array(50).fill(between), ...Array(50).fill(null)]).every((l) => l === "degraded"),
  ).toBe(true);
  // PSI swinging between 15 and 30 (onnyx, 17 Nov) still degrades: a reading between the bands does not restart it.
  const swinging = run(
    ok0,
    Array(bads + 1)
      .fill(0)
      .map((_, i) => (i % 2 === 0 ? starving : between)),
  );
  expect(swinging.at(-1)).toBe("degraded");
});

it("leaves a server that just started unrated until its figures hold either way", () => {
  const unrated = UNRATED;
  const goods = RECOVER_MS / 10_000;
  const rising = run(unrated, Array(goods + 1).fill(healthy));
  expect(rising.slice(0, goods)).toEqual(Array(goods).fill(null));
  expect(rising[goods]).toBe("ok");
  expect(run(unrated, Array(DEGRADE_MS / 10_000 + 1).fill(starving)).at(-1)).toBe("degraded");
});

const order = ["onnyx", "hetzner", "laptop"];
const place = (
  current: string,
  levels: Record<string, HostLevel | undefined>,
  movedAt = -DWELL_MS,
  now = 0,
) => placeRoom({ order, current, levels, movedAt, now });

it("moves a device off a degraded hub to the first ok one in his order, and back once his first is ok", () => {
  expect(place("onnyx", { onnyx: "degraded", hetzner: "ok", laptop: "ok" })).toEqual({
    to: "hetzner",
    why: "degraded",
  });
  expect(place("onnyx", { onnyx: "degraded", hetzner: "degraded", laptop: "ok" })?.to).toBe(
    "laptop",
  );
  // Nowhere better, or nothing known about the others: it stays.
  expect(place("onnyx", { onnyx: "degraded", hetzner: "degraded" })).toBeNull();
  expect(place("onnyx", { onnyx: "degraded" })).toBeNull();
  // Healthy and first: it stays.
  expect(place("onnyx", { onnyx: "ok", hetzner: "ok" })).toBeNull();
  // On the standby: stays while his first is degraded or unknown, goes back once it is ok.
  expect(place("hetzner", { onnyx: "degraded", hetzner: "ok" })).toBeNull();
  expect(place("hetzner", { hetzner: "ok" })).toBeNull();
  expect(place("hetzner", { onnyx: "ok", hetzner: "ok" })).toEqual({
    to: "onnyx",
    why: "recovered",
  });
  // Off a degraded standby to his first when that one is ok, rather than further down.
  expect(place("hetzner", { onnyx: "ok", hetzner: "degraded", laptop: "ok" })?.to).toBe("onnyx");
});

it("waits out the dwell after any move, on whichever server made it", () => {
  const levels = { onnyx: "ok", hetzner: "ok" } as const;
  expect(place("hetzner", levels, 0, DWELL_MS - 1)).toBeNull();
  expect(place("hetzner", levels, 0, DWELL_MS)?.to).toBe("onnyx");
});
