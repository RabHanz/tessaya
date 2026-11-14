import { describe, expect, it } from "vite-plus/test";

import { createVoiceCore } from "./core.ts";
import { DEFAULT_TIMINGS } from "./modeMachine.ts";
import type { RouteOutcome } from "./router.ts";

const FRAME = 320;
const frames = (seconds: number) => Math.round((seconds * 16_000) / FRAME);

const rig = (line: string) => {
  let speech = false;
  const routed: string[] = [];
  const core = createVoiceCore({
    waitMs: () => 1_500,
    wake: { name: "fake", reset: () => {}, process: () => null },
    vad: { name: "fake", reset: () => {}, isSpeech: () => speech },
    stt: { name: "fake", transcribe: async () => line },
    router: {
      route: async (effect): Promise<RouteOutcome> => {
        if (effect.kind === "command") routed.push(effect.text);
        return { kind: "ran", reply: "ok", workSessionId: null, source: "test" };
      },
    },
  });
  const push = (seconds: number, loud: boolean) => {
    speech = loud;
    for (let i = 0; i < frames(seconds); i += 1) core.pushAudio(new Int16Array(FRAME));
  };
  const settle = async () => {
    // The core's work queue drains on the macrotask queue, so a microtask yield is not enough.
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a yield, not a wait
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { core, push, routed, settle };
};

describe("the wait after the wake word covers only the start of speech", () => {
  it("is eight seconds by default", () => {
    expect(DEFAULT_TIMINGS.commandWindowMs).toBe(8_000);
  });

  it("never cuts words that began before it ran out, however long they go on", async () => {
    const r = rig("Write me a long note about the quarterly plan.");
    r.core.activate("wake");
    await r.core.idle();
    r.push(6, false); // nothing yet; two seconds of the window are left
    r.push(7, true); // he starts at 6 s and talks through the 8 s mark and beyond
    r.push(1.8, false); // the end-of-speech silence
    await r.settle();
    r.push(2, false);
    await r.core.idle();
    expect(r.routed).toEqual(["Write me a long note about the quarterly plan."]);
  });

  it("still gives up when nothing is said in the whole window", async () => {
    const r = rig("too late");
    r.core.activate("wake");
    await r.core.idle();
    r.push(9, false); // the window is over
    r.push(1, true);
    r.push(1.8, false);
    await r.settle();
    r.push(2, false);
    await r.core.idle();
    expect(r.routed).toEqual([]);
  });
});
