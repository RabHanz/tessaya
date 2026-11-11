import { describe, expect, it } from "vite-plus/test";

import type { SpeakerIdentity } from "../speaker.ts";
import { UNVERIFIED } from "../speaker.ts";
import { toBytes } from "./audio.ts";
import {
  createRoomVoice,
  ROOM_CONFIG,
  splitSentences,
  type RoomDeps,
  type TurnMetrics,
} from "./roomVoice.ts";

const DEV = "r1-test";
const frame = (loud: boolean) => toBytes(new Int16Array(960).fill(loud ? 3000 : 0));

/** A fake room on a manual clock: sleeps advance it, nothing waits on wall time. */
const setup = (over: Partial<RoomDeps> = {}) => {
  let clock = 1_000;
  const published: Array<{ topic: string; payload: Uint8Array | string }> = [];
  const brainCalls: Array<Parameters<RoomDeps["brain"]>[0]> = [];
  let resolveMetrics: (m: TurnMetrics) => void = () => undefined;
  const metrics = new Promise<TurnMetrics>((r) => (resolveMetrics = r));
  const deps: RoomDeps = {
    publish: (topic, payload) => {
      published.push({ topic, payload });
      if (topic.endsWith("event/voice/metrics"))
        resolveMetrics(JSON.parse(String(payload)) as TurnMetrics);
    },
    vad: () => ({ score: async (w) => (w.some((v) => v !== 0) ? 0.9 : 0.05) }),
    smartTurn: async () => 0.9,
    recognise: () => ({
      feed: () => undefined,
      finish: async () => "turn on the study light",
      cancel: () => undefined,
    }),
    speaker: async () => UNVERIFIED(clock),
    brain: async function* (input) {
      brainCalls.push(input);
      yield "Done. The study ";
      yield "light is on.";
    },
    speak: async function* () {
      yield new Int16Array(3_200);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => undefined,
    ...over,
  };
  const room = createRoomVoice(deps);
  const feed = async (loud: boolean, n: number) => {
    for (let i = 0; i < n; i += 1) {
      room.message(`freya/r1/${DEV}/voice/up`, frame(loud));
      clock += 60;
      await room.session(DEV)!.drained();
    }
  };
  return { room, feed, published, brainCalls, metrics, deps };
};

describe("the room voice loop", () => {
  it("answers a finished sentence in her voice on the R1's downlink, with the speaker and the history", async () => {
    const t = setup();
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(false, 5);
    await t.feed(true, 20);
    await t.feed(false, 8);
    const m = await t.metrics;
    expect(m).toMatchObject({
      text: "turn on the study light",
      speaker: "unverified",
      reason: "complete",
    });
    expect(m.firstSoundMs).not.toBeNull();
    expect(t.brainCalls[0]!.messages).toEqual([
      { role: "user", content: "turn on the study light" },
    ]);
    expect(t.brainCalls[0]!.tessaya.speaker?.kind).toBe("unverified");
    const down = t.published.filter((p) => p.topic === `freya/r1/${DEV}/voice/down`);
    // Two sentences of 0.2 s each at 16 kHz, in 60 ms frames.
    expect(down.length).toBe(2 * Math.ceil(6_400 / 1_920));
  });

  it("does not answer a voice the gate keeps out", async () => {
    const guest: SpeakerIdentity = { ...UNVERIFIED(0), kind: "guest", confidence: 0.05 };
    const t = setup({ speaker: async () => guest });
    await t.feed(true, 20);
    await t.feed(false, 30);
    expect(t.brainCalls).toEqual([]);
  });

  it("stops talking and flushes the R1's buffer when he cuts in", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => (release = r));
    const t = setup({
      brain: async function* (_input, signal) {
        yield "One moment.";
        await hold;
        if (!signal.aborted) yield " More.";
      },
      speak: async function* () {
        yield new Int16Array(16_000);
      },
    });
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.feed(true, 10);
    release();
    expect(
      t.published.some(
        (p) => p.topic === `freya/r1/${DEV}/voice/ctl` && String(p.payload).includes("flush"),
      ),
    ).toBe(true);
    const m = await t.metrics;
    expect(m.text).toBe("turn on the study light");
  });
});

describe("splitting her reply into sentences as it streams", () => {
  it("releases a sentence only once what follows it has started", () => {
    expect(splitSentences("Done. The study")).toEqual({ done: ["Done."], rest: "The study" });
    expect(splitSentences("It is 3.5 degrees.")).toEqual({ done: [], rest: "It is 3.5 degrees." });
    expect(splitSentences("Yes! No? ")).toEqual({ done: ["Yes!", "No?"], rest: "" });
  });
});

describe("the per-device switch", () => {
  it("re-arms an in-house R1 every time it comes back online, and leaves the others alone", async () => {
    const published: string[] = [];
    const deps = {
      ...setup().deps,
      publish: (t: string) => published.push(t),
      sleep: async () => undefined,
    };
    const room = createRoomVoice(deps, { ...ROOM_CONFIG, inhouse: new Set(["r1-a"]) });
    room.message("freya/r1/r1-a/state/online", Buffer.from("1"));
    room.message("freya/r1/r1-b/state/online", Buffer.from("1"));
    room.message("freya/r1/r1-a/state/online", Buffer.from("0"));
    await Promise.resolve();
    await new Promise<void>((r) => queueMicrotask(r));
    expect(published.filter((t) => t === "freya/r1/r1-a/cmd/voice/mode").length).toBe(3);
    expect(published.some((t) => t.startsWith("freya/r1/r1-b/"))).toBe(false);
  });
});

describe("what Tessaya's Devices page can ask of the room", () => {
  it("says a line on the R1 when asked, and hears nothing while muted", async () => {
    const t = setup();
    t.room.message(
      `freya/r1/${DEV}/voice/say`,
      Buffer.from(JSON.stringify({ text: "Dinner is ready." })),
    );
    await new Promise<void>((r) => queueMicrotask(r));
    await Promise.resolve();
    expect(t.published.some((p) => p.topic === `freya/r1/${DEV}/voice/down`)).toBe(true);
    t.room.message(`freya/r1/${DEV}/voice/ctl`, Buffer.from(JSON.stringify({ ev: "mute" })));
    await t.feed(true, 20).catch(() => undefined);
    expect(t.room.session(DEV)).toBeUndefined();
    expect(t.brainCalls).toEqual([]);
  });
});
