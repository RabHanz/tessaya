// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createPlaybackWindows } from "./playbackWindow.ts";
import { createWakeCapture } from "./wakeCapture.ts";
import { createWakeTrace } from "./wakeTrace.ts";
import { createWakeStream, type WakeScorer } from "./wakeStream.ts";

const frame = (v: number) => new Uint8Array(new Int16Array(960).fill(v).buffer);
const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wake-capture-"));
const records = (dir: string) =>
  NodeFS.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
    .map((f) => JSON.parse(NodeFS.readFileSync(NodePath.join(dir, f), "utf8")));

describe("keeping wake segments for training", () => {
  it("saves each whole segment with both stages' verdicts and whether a session followed", async () => {
    const dir = NodePath.join(tmp(), "cap");
    let clock = 1_000_000;
    const capture = createWakeCapture({
      dir,
      capBytes: 1e9,
      now: () => clock,
      log: () => undefined,
    });
    const stream = createWakeStream({
      words: [{ word: "Tessaya", threshold: 0.99 }],
      scorer: async (): Promise<WakeScorer> => ({
        chunkSamples: 1280,
        reset: () => undefined,
        score: async (chunk) => [chunk.includes(7) ? 0.995 : 0],
      }),
      confirm: async () => ["Hey Tessaya."],
      onWake: () => undefined,
      log: () => undefined,
      capture,
    });
    const kws = { score: 0.91, pass: true, name: "tessaya", best: 0.91, ms: 12, n: 40 };
    // The R1's verdict first; the segment goes on after the fire and is kept whole.
    stream.kws("r1", { seg: 4, ...kws });
    for (let i = 0; i < 3; i += 1) stream.frame("r1", frame(7));
    for (let i = 0; i < 2; i += 1) stream.frame("r1", frame(1));
    stream.end("r1", 4);
    await stream.drained("r1");
    // Our end first, then the R1's verdict, then a session within the window.
    clock += 5_000;
    stream.frame("r1", frame(1));
    stream.end("r1", 5);
    await stream.drained("r1");
    stream.kws("r1", { seg: 5, ...kws, pass: false, score: 0.2 });
    clock += 3_000;
    capture.session("r1");
    await capture.drained();

    expect(NodeFS.statSync(dir).mode & 0o777).toBe(0o700);
    const files = NodeFS.readdirSync(dir).toSorted();
    expect(files).toHaveLength(4);
    for (const f of files) expect(NodeFS.statSync(NodePath.join(dir, f)).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(NodePath.join(dir, files[1]!)).size).toBe(5 * 960 * 2);
    const [woke, missed] = records(dir);
    expect(woke).toMatchObject({
      device: "r1",
      seg: 4,
      samples: 4800,
      kws: { score: 0.91, pass: true },
      stage2: { woke: true, best: { Tessaya: 0.995 } },
      session: false,
    });
    expect(woke.stage2.outcome).toMatch(/^woken by Tessaya/);
    expect(missed).toMatchObject({
      seg: 5,
      kws: { score: 0.2, pass: false },
      stage2: { woke: false, best: { Tessaya: 0 } },
      session: true,
    });
  });

  it("never puts a rebooted Tessel's verdict on an older segment with the same number", async () => {
    // 18 Nov: Tumble rebooted at 03:48 and numbered her segments from 1 again; their kws landed on 03:45's files.
    const dir = tmp();
    let clock = 0;
    const capture = createWakeCapture({
      dir,
      capBytes: 1e9,
      now: () => clock,
      log: () => undefined,
    });
    const stage2 = { outcome: "no fire", woke: false, best: {} };
    capture.segment("r1", 3, new Int16Array(500), stage2);
    clock += 200;
    capture.kws("r1", { seg: 3, score: 0.01, pass: false, name: "alfred", best: 0.01 });
    clock += 180_000;
    capture.kws("r1", { seg: 3, score: 0.9, pass: true, name: "alfred", best: 0.998 });
    await capture.drained();
    expect(records(dir).map((r) => r.kws)).toMatchObject([{ best: 0.01 }]);
  });

  it("drops the oldest segments past the cap, and a late session marks nothing", async () => {
    const dir = tmp();
    let clock = 0;
    const capture = createWakeCapture({
      dir,
      capBytes: 3_000,
      now: () => clock,
      log: () => undefined,
    });
    const stage2 = { outcome: "no fire", woke: false, best: {} };
    for (const seg of [1, 2, 3]) {
      clock += 1_000;
      capture.segment("r1", seg, new Int16Array(500), stage2);
    }
    // Written off the loop thread: nothing is on disk until the queue runs.
    expect(NodeFS.readdirSync(dir)).toHaveLength(0);
    await capture.drained();
    expect(records(dir).map((r) => r.seg)).toEqual([2, 3]);
    expect(NodeFS.readdirSync(dir).filter((f) => f.endsWith(".pcm"))).toHaveLength(2);
    clock += 20_000;
    capture.session("r1");
    await capture.drained();
    expect(records(dir).map((r) => r.session)).toEqual([false, false]);
  });

  it("marks segments inside a declared test playback or wakeinject window, and those missing frames", async () => {
    const dir = tmp();
    let clock = 0;
    const windows = createPlaybackWindows(() => clock);
    const capture = createWakeCapture({
      dir,
      capBytes: 1e9,
      playback: windows.run,
      now: () => clock,
      log: () => undefined,
    });
    const stage2 = { outcome: "no fire", woke: false, best: {} };
    const at = (ms: number, seg: number, sent?: number) => {
      clock = ms;
      capture.segment("r1", seg, new Int16Array(960 * 3), stage2, undefined, sent);
    };
    const topic = "freya/r1/r1/event/test/playback";
    at(1_000, 1, 3);
    expect(windows.message(topic, JSON.stringify({ open: true, run: "osp 0412" }))).toMatch(/open/);
    at(2_000, 2, 5);
    expect(windows.message(topic, JSON.stringify({ open: false }))).toMatch(/closed/);
    // A segment ending just after the close still holds the last clip.
    at(9_000, 3);
    at(30_000, 4);
    windows.message("freya/r1/r1/cmd/voice/wakeinject", '{"on":1}');
    at(31_000, 5);
    // A run that never closes lapses at its own `until`.
    windows.message("freya/r1/r1/cmd/voice/wakeinject", '{"on":0}');
    windows.message(topic, JSON.stringify({ open: true, run: "chain", until: 50_000 }));
    at(45_000, 6);
    at(70_000, 7);
    await capture.drained();
    expect(records(dir).map((r) => [r.seg, r.source, r.run ?? null, r.complete])).toEqual([
      [1, "live", null, true],
      [2, "playback", "osp_0412", false],
      [3, "playback", "osp_0412", null],
      [4, "live", null, null],
      [5, "playback", "wakeinject", null],
      [6, "playback", "chain", null],
      [7, "live", null, null],
    ]);
  });

  it("traces every segment, kws verdict and Tessel report without audio, in two files under the cap", async () => {
    const file = NodePath.join(tmp(), "wake-trace.ndjson");
    const trace = createWakeTrace({ file, capBytes: 4_000, log: () => undefined });
    const stream = createWakeStream({
      words: [{ word: "Tessaya", threshold: 0.99 }],
      scorer: async (): Promise<WakeScorer> => ({
        chunkSamples: 1280,
        reset: () => undefined,
        score: async () => [0.1],
      }),
      confirm: async () => [],
      onWake: () => undefined,
      log: () => undefined,
      capture: trace,
    });
    stream.frame("r1", frame(300));
    stream.end("r1", 9);
    await stream.drained("r1");
    stream.kws("r1", { seg: 9, score: 0.02, pass: false, best: 0.02 });
    trace.report("r1", "event/wake/stats", '{"opens":1,"shut":2,"rms_max":180}');
    await trace.drained();
    const lines = NodeFS.readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ k: "seg", dev: "r1", seg: 9, s: 0.06, rms: 300, peak: 300 });
    expect(lines[0].sha).toMatch(/^[0-9a-f]{16}$/);
    expect(lines[1]).toMatchObject({ k: "kws", seg: 9, best: 0.02 });
    expect(lines[2]).toMatchObject({ k: "event/wake/stats", opens: 1, shut: 2, rms_max: 180 });
    for (let i = 0; i < 40; i += 1) trace.report("r1", "voice/wake/end", `{"seg":${i},"gate":160}`);
    await trace.drained();
    const both = NodeFS.statSync(file).size + NodeFS.statSync(`${file}.1`).size;
    expect(both).toBeLessThanOrEqual(4_000);
    expect(NodeFS.readFileSync(file, "utf8")).toContain('"seg":39');
  });
});
