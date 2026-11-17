import { describe, expect, it } from "vite-plus/test";

import {
  diagnose,
  healthNotice,
  hostHealthOf,
  stageStatOf,
  type HealthSnapshot,
  type VesselHealth,
} from "./health.ts";

const NOW = 1_800_000_000_000;
const host = (over: Partial<ReturnType<typeof hostHealthOf>> = {}) => ({
  host: "onnyx",
  at: NOW,
  memTotalMb: 16_000,
  memAvailMb: 6_000,
  swapUsedMb: 0,
  memPsiSome10: 0.1,
  memPsiFull10: 0,
  memPsiFull60: 0,
  cpuPsiSome10: 2,
  load1: 1,
  cores: 8,
  ...over,
});
const tumble = (over: Partial<VesselHealth> = {}): VesselHealth => ({
  id: "t1",
  name: "Tumble",
  online: true,
  rssi: -55,
  route: "wifi",
  hub: "hetzner",
  stages: { asrMs: { p50: 400, p90: 600, n: 10 }, brainFirstMs: { p50: 1_500, p90: 2_000, n: 10 } },
  stalls: 0,
  voiceHost: {
    host: host(),
    services: [],
    wake: { attempts: 4, accepts: 4, since: NOW - 3_600_000 },
    replay: { line: "replay check loaded", degraded: false },
    brain: { rttMs: 80, failures: [] },
    at: NOW - 30_000,
  },
  ...over,
});
const snap = (over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  at: NOW,
  hosts: [host({ host: "hetzner" })],
  services: [],
  vessels: [tumble()],
  providers: [],
  roomLoop: null,
  notes: [],
  ...over,
});

describe("hostHealthOf", () => {
  it("reads meminfo, loadavg and pressure files, and leaves out what a kernel lacks", () => {
    const h = hostHealthOf({
      host: "onnyx",
      at: NOW,
      cores: 4,
      meminfo:
        "MemTotal:  8192000 kB\nMemAvailable:  204800 kB\nSwapTotal: 4096000 kB\nSwapFree: 1024000 kB\n",
      loadavg: "6.20 5.00 4.00 3/400 1234\n",
      psiMemory:
        "some avg10=41.50 avg60=35.00 avg300=20.00 total=1\nfull avg10=29.80 avg60=27.00 avg300=15.00 total=1\n",
      psiCpu: null,
    });
    expect(h).toMatchObject({
      memTotalMb: 8000,
      memAvailMb: 200,
      swapUsedMb: 3000,
      memPsiSome10: 41.5,
      memPsiFull10: 29.8,
      memPsiFull60: 27,
      cpuPsiSome10: null,
      load1: 6.2,
    });
  });
  it("takes the median and 90th percentile of the last turns", () => {
    expect(stageStatOf([9_000, 100, 200, 300, 400], 4)).toEqual({ p50: 300, p90: 400, n: 4 });
    expect(stageStatOf([])).toEqual({ p50: null, p90: null, n: 0 });
  });
});

describe("diagnose", () => {
  it("names onnyx's memory starvation as the cause of a slow, choppy Tumble, with the stage that waited (17 Nov)", () => {
    const starving = host({
      memAvailMb: 300,
      swapUsedMb: 5_200,
      memPsiSome10: 45,
      memPsiFull10: 30,
      memPsiFull60: 28,
    });
    const d = diagnose(
      snap({
        vessels: [
          tumble({
            stages: {
              asrMs: { p50: 1_800, p90: 2_600, n: 10 },
              ttsFirstMs: { p50: 1_400, p90: 2_000, n: 10 },
            },
            stalls: 3,
            voiceHost: { ...tumble().voiceHost!, host: starving },
          }),
        ],
        hosts: [host({ host: "hetzner" }), starving],
      }),
      "slow",
    );
    expect(d.severity).toBe("down");
    expect(d.findings[0]!.key).toBe("memory:onnyx");
    expect(d.summary).toMatch(/onnyx is out of memory and swapping/i);
    expect(d.summary).toMatch(/speech engine took 1\.8 s/);
    expect(d.findings.some((f) => f.key.startsWith("stage:"))).toBe(false);
  });
  it("says nothing heard her name while the voice loop was stopped, and the turns her server missed", () => {
    const stopped = diagnose(
      snap({ vessels: [tumble({ voiceHost: { ...tumble().voiceHost!, at: NOW - 10 * 60_000 } })] }),
      "wake",
    );
    expect(stopped.findings[0]!.key).toBe("loop:t1");
    expect(stopped.summary).toMatch(/stopped reporting/);
    const missed = diagnose(
      snap({
        vessels: [
          tumble({
            voiceHost: {
              ...tumble().voiceHost!,
              brain: { rttMs: 90, failures: [NOW - 4 * 60_000, NOW - 3 * 60_000] },
            },
          }),
        ],
      }),
      "wake",
    );
    expect(missed.summary).toMatch(/server did not answer 2 times lately, last 3 min ago/);
  });
  it("blames a weak hotspot link and a slow round trip for a laggy turn, not the brain", () => {
    const d = diagnose(
      snap({
        vessels: [
          tumble({
            rssi: -84,
            route: "hotspot",
            voiceHost: { ...tumble().voiceHost!, brain: { rttMs: 1_200, failures: [] } },
          }),
        ],
      }),
      "slow",
    );
    expect(d.findings.map((f) => f.key)).toEqual(expect.arrayContaining(["wifi:t1", "rtt:t1"]));
    expect(d.findings.map((f) => f.key)).not.toContain("provider:claude");
  });
  it("finds nothing on a healthy house, and says so instead of guessing", () => {
    const d = diagnose(snap(), "slow");
    expect(d).toMatchObject({ severity: "ok", findings: [] });
    expect(d.summary).toMatch(/Nothing in my health readings explains that/);
  });
});

describe("healthNotice", () => {
  it("raises a cause only once it has held three senses, once per episode, and forgets it when it clears", () => {
    const bad = diagnose(
      snap({
        hosts: [host({ host: "onnyx", memAvailMb: 200, swapUsedMb: 4_000, memPsiFull10: 30 })],
      }),
    );
    const first = healthNotice(null, bad, NOW);
    const second = healthNotice(first.episode, bad, NOW + 60_000);
    const third = healthNotice(second.episode, bad, NOW + 120_000);
    const fourth = healthNotice(third.episode, bad, NOW + 180_000);
    expect([first.notice, second.notice]).toEqual([null, null]);
    expect(third.notice).toMatchObject({ id: `health:memory:onnyx:${NOW}`, weight: 75 });
    expect(fourth.notice?.id).toBe(third.notice?.id);
    expect(healthNotice(fourth.episode, diagnose(snap()), NOW + 240_000)).toEqual({
      episode: null,
      notice: null,
    });
  });
});
