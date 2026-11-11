import { describe, expect, it } from "vite-plus/test";

import { BUSY_FILE_FRESH_MS, busyFileOf, safeToReplace } from "./busyFile.ts";

const now = new Date("2026-11-11T13:07:00.000Z");
const idle = { voiceBusy: false, assistantBusy: false, inFlight: null };

describe("busyFileOf", () => {
  it.each([
    { name: "idle", busy: idle, serverAnswered: true, expected: false },
    {
      name: "a turn waiting on a web fetch",
      busy: { ...idle, inFlight: "A session is mid-turn: “3D printer”." },
      serverAnswered: true,
      expected: true,
    },
    {
      name: "voice busy",
      busy: { ...idle, voiceBusy: true },
      serverAnswered: true,
      expected: true,
    },
    { name: "a server that did not answer", busy: idle, serverAnswered: false, expected: true },
  ])("$name is busy: $expected", ({ busy, serverAnswered, expected }) => {
    const file = busyFileOf({ busy, serverAnswered, now, pid: 42 });
    expect(file.busy).toBe(expected);
    expect(file.why === null).toBe(!expected);
  });
});

describe("safeToReplace", () => {
  const written = (busy: boolean, ageMs: number) => ({
    ...busyFileOf({ busy: idle, serverAnswered: true, now, pid: 42 }),
    busy,
    at: new Date(now.getTime() - ageMs).toISOString(),
  });
  it.each([
    { name: "a fresh idle file", file: written(false, 1_000), safe: true },
    { name: "a fresh busy file", file: written(true, 1_000), safe: false },
    { name: "a stale idle file", file: written(false, BUSY_FILE_FRESH_MS), safe: false },
    { name: "a file from the future", file: written(false, -60_000), safe: false },
    { name: "an unreadable file", file: "{", safe: false },
  ])("$name is safe: $safe", ({ file, safe }) => {
    expect(safeToReplace(file, now.getTime())).toBe(safe);
  });
});
