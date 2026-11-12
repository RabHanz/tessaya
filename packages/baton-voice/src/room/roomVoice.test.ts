import { describe, expect, it } from "vite-plus/test";

import type { SpeakerIdentity } from "../speaker.ts";
import { UNVERIFIED } from "../speaker.ts";
import { PILL_SOUNDS, renderSound } from "../cueSounds.ts";
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
    // Her listening sound on S2, then two sentences of 0.2 s each at 16 kHz, in 60 ms frames.
    const cue = Math.ceil((renderSound(PILL_SOUNDS.wake, 16_000).length * 2) / 1_920);
    expect(down.length).toBe(cue + 2 * Math.ceil(6_400 / 1_920));
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

describe("answering only when he is talking to her", () => {
  /** His 12 Nov turns in order, each one heard in turn. */
  const said = (texts: ReadonlyArray<string>) => {
    let n = 0;
    return () => {
      const text = texts[n++] ?? "";
      return { feed: () => undefined, finish: async () => text, cancel: () => undefined };
    };
  };
  const turn = async (t: ReturnType<typeof setup>) => {
    await t.feed(true, 20);
    await t.feed(false, 60);
  };

  it("answers after S2 and in the window after her reply, then only her name, and not at all once dismissed", async () => {
    const t = setup({
      recognise: said([
        "Can you see my laptop?",
        "My laptop itself.",
        "This is a test of Tessa dictation.",
        "Casea, can you hear me?",
        "No, dismissed.",
        "Did you hear me?",
        "Say yeah.",
      ]),
    });
    await turn(t);
    await turn(t);
    await t.deps.sleep(10_000);
    t.room.sweep();
    await turn(t);
    await turn(t);
    await turn(t);
    await turn(t);
    await turn(t);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Can you see my laptop?",
      "My laptop itself.",
      "Casea, can you hear me?",
      "No, dismissed.",
      "Say yeah.",
    ]);
    // Asleep between them: sleepy eyes, and no attentive look or nod for speech that was not for her.
    expect(t.published.some((p) => String(p.payload).includes('"sleepy"'))).toBe(true);
  });

  it("answers a request he began inside the window, however long it runs or recognition takes", async () => {
    const t = setup({
      recognise: () => ({
        feed: () => undefined,
        // The recogniser can take seconds after he stops.
        finish: async () => {
          await t.deps.sleep(3_000);
          return "turn on the study lamp and tell me what is next on my list";
        },
        cancel: () => undefined,
      }),
    });
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.deps.sleep(6_000);
    // He starts at 6 s (inside the 8 s window) and talks for 6 s.
    await t.feed(true, 100);
    await t.feed(false, 60);
    expect(t.brainCalls.length).toBe(1);
  });

  it("hands a turn to the persona he calls, in its voice and eyes, until the window lapses", async () => {
    const voices: Array<string | undefined> = [];
    const t = setup({
      recognise: said(["Alfred, what broke?", "And the fix?", "Tessaya, what time is it?"]),
      speak: async function* (_text, _signal, voice) {
        voices.push(voice);
        yield new Int16Array(3_200);
      },
    });
    await turn(t);
    await turn(t);
    await t.deps.sleep(10_000);
    t.room.sweep();
    await turn(t);
    expect(t.brainCalls.map((c) => c.tessaya.persona)).toEqual([
      "engineering",
      "engineering",
      undefined,
    ]);
    expect(new Set(voices)).toEqual(new Set(["peter_yearsley", "eve"]));
    expect(voices.at(-1)).toBe("eve");
    expect(
      t.published.filter((p) => p.topic.endsWith("/cmd/eye/persona")).map((p) => String(p.payload)),
    ).toEqual(['{"name":"alfred"}', '{"name":"tessaya"}']);
  });
});

describe("waking by name with no session open", () => {
  it("hears the wake stream only between sessions, and opens one with the persona he called", async () => {
    const frames: string[] = [];
    const t = setup({
      wake: { frame: (id) => frames.push(id), end: () => undefined },
      recognise: () => ({
        feed: () => undefined,
        finish: async () => "what broke?",
        cancel: () => undefined,
      }),
    });
    t.room.message(`freya/r1/${DEV}/voice/wake`, new Uint8Array(1920));
    expect(frames).toEqual([DEV]);
    t.room.woken(DEV, "Alfred");
    const start = t.published.find((p) => p.topic === `freya/r1/${DEV}/cmd/voice/start`);
    expect(start).toBeDefined();
    // The R1's echo of its start opens the session.
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    t.room.message(`freya/r1/${DEV}/voice/wake`, new Uint8Array(1920));
    expect(frames).toEqual([DEV]);
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls[0]?.tessaya.persona).toBe("engineering");
  });
});

describe("the R1's own buttons (firmware 3.32)", () => {
  it("answers when he lets go of push-to-talk, then ends the session once the reply has played", async () => {
    const t = setup({ smartTurn: async () => 0 });
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    expect(t.brainCalls).toEqual([]);
    t.room.message(`freya/r1/${DEV}/state/voice`, Buffer.from(JSON.stringify({ ev: "ptt_end" })));
    await t.room.session(DEV)!.drained();
    const m = await t.metrics;
    expect(m.reason).toBe("released");
    expect(t.published.some((p) => p.topic === `freya/r1/${DEV}/cmd/voice/stop`)).toBe(true);
  });

  it("hears nothing while his R1 is muted, and a reboot does not undo the mute", async () => {
    const t = setup();
    const mic = (body: object) =>
      t.room.message(`freya/r1/${DEV}/state/mic`, Buffer.from(JSON.stringify(body)));
    mic({ muted: true, src: "button" });
    mic({ muted: false, src: "boot" });
    await t.feed(true, 20).catch(() => undefined);
    expect(t.room.session(DEV)).toBeUndefined();
    mic({ muted: false, src: "button" });
    await t.feed(true, 20);
    expect(t.room.session(DEV)).toBeDefined();
  });
});

describe("how her reply sounds and looks on the R1", () => {
  const downSamples = (published: Array<{ topic: string; payload: Uint8Array | string }>) =>
    published
      .filter((p) => p.topic === `freya/r1/${DEV}/voice/down`)
      .map((p) => new Int16Array(Uint8Array.from(p.payload as Uint8Array).buffer)[0]!);

  it("plays one reply at a time when a second turn ends while the first is still being heard", async () => {
    // He says two things quickly; the first one's text comes back only after the second has ended.
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    let turns = 0;
    const t = setup({
      recognise: () => {
        const n = (turns += 1);
        return {
          feed: () => undefined,
          finish: async () => {
            if (n === 1) await firstHeld;
            return n === 1 ? "first" : "second";
          },
          cancel: () => undefined,
        };
      },
      brain: async function* (input) {
        yield `${input.messages.at(-1)!.content}.`;
      },
      speak: async function* (text) {
        for (let i = 0; i < 30; i += 1)
          yield new Int16Array(3_200).fill(text.startsWith("first") ? 1 : 2);
      },
    });
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.feed(true, 20);
    await t.feed(false, 12);
    releaseFirst();
    await t.feed(false, 200);
    const order = downSamples(t.published).filter((v) => v !== 0);
    const switches = order.filter((v, i) => i > 0 && v !== order[i - 1]).length;
    expect(order.length).toBeGreaterThan(0);
    expect(switches).toBeLessThanOrEqual(1);
  });

  it("starts the next sentence's voice before the one before it has finished playing", async () => {
    let sentAtTwo = -1;
    const box: { published: Array<{ topic: string; payload: Uint8Array | string }> } = {
      published: [],
    };
    const t = setup({
      brain: async function* () {
        yield "One. Two.";
      },
      speak: async function* (text) {
        if (text === "Two.") sentAtTwo = downSamples(box.published).filter((v) => v === 1).length;
        for (let i = 0; i < 5; i += 1) yield new Int16Array(3_200).fill(text === "One." ? 1 : 2);
      },
    });
    box.published = t.published;
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.metrics;
    const oneFrames = downSamples(t.published).filter((v) => v === 1).length;
    expect(oneFrames).toBeGreaterThan(0);
    expect(sentAtTwo).toBeGreaterThanOrEqual(0);
    expect(sentAtTwo).toBeLessThan(oneFrames);
  });

  it("looks attentive while he talks, nods when he is done, and rests once she has finished", async () => {
    const t = setup();
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.metrics;
    await t.feed(false, 30);
    const face = t.published
      .filter((p) => p.topic.includes("/cmd/eye/"))
      .map((p) => `${p.topic.split("/cmd/eye/")[1]} ${String(p.payload)}`);
    expect(face).toEqual([
      'set {"mood":"attentive"}',
      'gesture {"name":"nodSmall"}',
      'set {"mood":"neutral"}',
    ]);
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

const abortedBy = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

describe("cutting in on her", () => {
  it("survives him cutting in while her voice and brain are mid-request", async () => {
    let clock = 1000;
    const deps: RoomDeps = {
      publish: () => undefined,
      vad: () => ({ score: async (w) => (w.some((v) => v !== 0) ? 0.9 : 0.05) }),
      smartTurn: async () => 0.9,
      recognise: () => ({
        feed: () => undefined,
        finish: async () => "hello",
        cancel: () => undefined,
      }),
      speaker: async () => UNVERIFIED(clock),
      brain: async function* (_i, signal) {
        yield "One. Two. Three.";
        await abortedBy(signal);
      },
      speak: async function* (_t, signal) {
        yield new Int16Array(3_200);
        await abortedBy(signal);
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: () => undefined,
    };
    const room = createRoomVoice(deps);
    const feed = async (loud: boolean, n: number) => {
      for (let i = 0; i < n; i += 1) {
        room.message(`freya/r1/${DEV}/voice/up`, frame(loud));
        clock += 60;
        await room.session(DEV)!.drained();
      }
    };
    await feed(true, 20);
    await feed(false, 8);
    await feed(true, 20);
    await feed(false, 8);
    await feed(true, 20);
    await feed(false, 30);
    // An abort nobody handles fails the run (vitest reports unhandled rejections); the room also stays open.
    expect(room.session(DEV)).toBeDefined();
  });
});

describe("her listening and closing sounds", () => {
  const order = (published: Array<{ topic: string }>) =>
    published
      .map((p) => p.topic.split(`${DEV}/`)[1]!)
      .filter((t) => t === "voice/down" || t === "cmd/voice/stop")
      .filter((t, i, all) => i === 0 || t !== all[i - 1]);

  it("sounds once when the R1 wakes, and closes softly before it is told to stop", async () => {
    const t = setup();
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    // The firmware's own session event right behind S2 is the same wake: one sound, not two.
    t.room.message(`freya/r1/${DEV}/event/session/start`, new Uint8Array());
    await t.deps.sleep(ROOM_CONFIG.idleStopMs + 1_000);
    t.room.sweep();
    await t.deps.sleep(2_000);
    expect(order(t.published)).toEqual(["voice/down", "cmd/voice/stop"]);
    const down = t.published.filter((p) => p.topic.endsWith("voice/down")).length;
    const frames = (name: "wake" | "end") =>
      Math.ceil((renderSound(PILL_SOUNDS[name], 16_000).length * 2) / 1_920);
    expect(down).toBe(frames("wake") + frames("end"));
  });

  it("closes softly when the R1 ends its own session, then lets the session go", async () => {
    const t = setup();
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.deps.sleep(2_000);
    const before = t.published.filter((p) => p.topic.endsWith("voice/down")).length;
    t.room.message(`freya/r1/${DEV}/state/voice`, Buffer.from(JSON.stringify({ ev: "stop" })));
    await t.deps.sleep(2_000);
    const after = t.published.filter((p) => p.topic.endsWith("voice/down")).length;
    expect(after - before).toBe(
      Math.ceil((renderSound(PILL_SOUNDS.end, 16_000).length * 2) / 1_920),
    );
    expect(t.room.session(DEV)).toBeUndefined();
  });

  it("stays silent on an R1 they are switched off for, and sounds again once switched back", async () => {
    const t = setup();
    const off = Buffer.from(JSON.stringify({ on: false }));
    t.room.message(`freya/r1/${DEV}/cmd/voice/earcons`, off);
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.deps.sleep(ROOM_CONFIG.idleStopMs + 1_000);
    t.room.sweep();
    await t.deps.sleep(2_000);
    expect(order(t.published)).toEqual(["cmd/voice/stop"]);
    t.room.message(`freya/r1/${DEV}/cmd/voice/earcons`, Buffer.from(JSON.stringify({ on: true })));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    expect(t.published.at(-1)!.topic).toBe(`freya/r1/${DEV}/voice/down`);
  });
});

describe("her brain starting on the recogniser's partial words", () => {
  const guessing = (partial: string, final: string, over: Partial<RoomDeps> = {}) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const asked: string[] = [];
    const aborted: string[] = [];
    let atRelease = -1;
    const t = setup({
      recognise: () => {
        let listener: ((text: string) => void) | null = null;
        return {
          feed: () => undefined,
          onPartial: (l) => {
            listener = l;
          },
          finish: async () => {
            listener?.(partial);
            await held;
            return final;
          },
          cancel: () => undefined,
        };
      },
      brain: async function* (input, signal) {
        const words = input.messages.at(-1)!.content;
        asked.push(words);
        signal.addEventListener("abort", () => aborted.push(words));
        yield "Done.";
      },
      ...over,
    });
    const run = async () => {
      await t.feed(true, 20);
      await t.feed(false, 8);
      await t.deps.sleep(300);
      atRelease = asked.length;
      release();
      return t.metrics;
    };
    return { t, asked, aborted, run, atRelease: () => atRelease };
  };

  it("keeps the guess when the final text says the same words, so the brain started early", async () => {
    const g = guessing("turn on the study light", "Turn on the study light.");
    const m = await g.run();
    expect(g.atRelease()).toBe(1);
    expect(g.asked).toEqual(["turn on the study light"]);
    expect(m.speculative).toBe(true);
    expect(g.t.published.some((p) => p.topic.endsWith("voice/down"))).toBe(true);
  });

  it("starts the guess without waiting for the mood reader, which is slower on the voice host", async () => {
    let moodDone: () => void = () => undefined;
    const mood = new Promise<void>((r) => (moodDone = r));
    const g = guessing("turn on the study light", "turn on the study light", {
      affect: async () => {
        await mood;
        return { emotion: "neutral" as const, events: [], language: "en", text: "" };
      },
    });
    const m = await g.run();
    // The brain had the guess before the final text came back, while the mood reader was still running.
    expect(g.atRelease()).toBe(1);
    expect(m.speculative).toBe(true);
    moodDone();
  });

  it("drops a guess that heard different words and answers the final text instead", async () => {
    const g = guessing("turn on the study", "turn on the study light");
    const m = await g.run();
    expect(g.asked).toEqual(["turn on the study", "turn on the study light"]);
    expect(g.aborted).toContain("turn on the study");
    expect(m.speculative).toBe(false);
  });
});
