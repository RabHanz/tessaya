// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createWakeCapture } from "./wakeCapture.ts";
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
      confirm: async () => "Hey Tessaya.",
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

  it("drops the oldest segments past the cap, and a late session marks nothing", () => {
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
    expect(records(dir).map((r) => r.seg)).toEqual([2, 3]);
    expect(NodeFS.readdirSync(dir).filter((f) => f.endsWith(".pcm"))).toHaveLength(2);
    clock += 20_000;
    capture.session("r1");
    expect(records(dir).map((r) => r.session)).toEqual([false, false]);
  });
});
