import { describe, expect, it, vi } from "vite-plus/test";

import type { EnrolCard } from "@t3tools/baton-contracts";

import type { SpeakerIdentity } from "../speaker.ts";
import { UNVERIFIED } from "../speaker.ts";
import { PILL_SOUNDS, renderSound } from "../cueSounds.ts";
import { speechLike } from "../echoSim.ts";
import { toBytes } from "./audio.ts";
import { createWakeStream, type WakeScorer } from "./wakeStream.ts";
import {
  createRoomVoice,
  firstClause,
  ROOM_CONFIG,
  splitSentences,
  type RoomDeps,
  type TurnMetrics,
} from "./roomVoice.ts";

const DEV = "r1-test";
const frame = (loud: boolean) => toBytes(new Int16Array(960).fill(loud ? 3000 : 0));

/** A fake room on a manual clock: sleeps advance it, nothing waits on wall time. */
/** The room as configured, with her "I'm here" off (its own tests turn it on). */
const QUIET = { ...ROOM_CONFIG, acknowledge: "off" as const };
const setup = (over: Partial<RoomDeps> = {}, config: typeof ROOM_CONFIG = QUIET) => {
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
  const room = createRoomVoice(deps, config);
  const feed = async (loud: boolean, n: number) => {
    for (let i = 0; i < n; i += 1) {
      room.message(`freya/r1/${DEV}/voice/up`, frame(loud));
      clock += 60;
      await room.session(DEV)!.drained();
    }
  };
  /** He presses S2 (her listening sound off, so the downlink carries only her reply). */
  const s2 = () => {
    room.message(`freya/r1/${DEV}/cmd/voice/earcons`, Buffer.from('{"on":false}'));
    room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    room.message(`freya/r1/${DEV}/cmd/voice/earcons`, Buffer.from('{"on":true}'));
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { room, feed, s2, published, brainCalls, metrics, deps, advance };
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

  it("guides an enrolment with the card on his screen: never answered, made from his read, then summarised", async () => {
    const windows: number[] = [];
    const t = setup({
      recognise: () => ({
        feed: () => undefined,
        finish: async () => "hi tessaya its me",
        cancel: () => undefined,
        onPartial: (l) => l("hi tessaya its me and this"),
      }),
      embed: async () => Float32Array.from([1, 0, 0]),
      enrolOwner: async (w) => {
        windows.push(w.length);
        return { saved: true, said: "Thanks. I know your voice now." };
      },
    });
    t.room.message(`freya/r1/${DEV}/voice/enrol`, new TextEncoder().encode("{}"));
    const cards = () =>
      t.published
        .filter((p) => p.topic === `freya/r1/${DEV}/event/enrol`)
        .map((p) => JSON.parse(String(p.payload)) as EnrolCard);
    // The R1 is asked to open its mic first; a session opened only here hears nothing (13 Nov).
    expect(t.published.map((p) => p.topic)).toContain(`freya/r1/${DEV}/cmd/voice/start`);
    expect(cards()).toEqual([]);
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    expect(cards()[0]!.lines[0]!.text).toContain("it's me,");
    expect(cards()[0]!.lines.map((l) => l.state)).toEqual([
      "now",
      "todo",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
    await t.feed(false, 25);
    await t.feed(true, 15);
    // The recogniser's words move the highlight while he reads.
    expect(cards().at(-1)!.lines[0]!.heard).toBe(6);
    await t.feed(true, 50);
    await t.feed(false, 14);
    expect(
      cards()
        .at(-1)!
        .lines.map((l) => l.state)
        .slice(0, 2),
    ).toEqual(["done", "now"]);
    for (let i = 1; i < 6; i += 1) {
      await t.feed(true, 65);
      await t.feed(false, 14);
    }
    const last = cards().at(-1)!;
    expect(last.phase).toBe("done");
    expect(last.summary).toMatchObject({ quality: 3, headline: "Your voice profile is ready" });
    expect(last.summary!.rows).toContainEqual({
      label: "Microphone",
      value: "Agora R1 (room mic)",
    });
    expect(windows).toEqual([6]);
    expect(t.brainCalls).toEqual([]);
    // Its summary said, the enrolment ends the R1's session rather than turning into a conversation.
    await vi.waitFor(() =>
      expect(t.published.map((p) => p.topic)).toContain(`freya/r1/${DEV}/cmd/voice/stop`),
    );
  });

  it("ends an enrolment session on a cancel, and answers nothing he says before it closes", async () => {
    const t = setup({
      recognise: () => ({
        feed: () => undefined,
        finish: async () => "it still isn't working well",
        cancel: () => undefined,
        onPartial: () => undefined,
      }),
    });
    t.room.message(`freya/r1/${DEV}/voice/enrol`, new TextEncoder().encode("{}"));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    t.room.message(`freya/r1/${DEV}/voice/enrol`, Buffer.from('{"cancel":true}'));
    await t.feed(true, 30);
    await t.feed(false, 30);
    expect(t.brainCalls).toEqual([]);
    await vi.waitFor(() =>
      expect(t.published.map((p) => p.topic)).toContain(`freya/r1/${DEV}/cmd/voice/stop`),
    );
  });

  it("does not answer a voice the gate keeps out", async () => {
    const guest: SpeakerIdentity = { ...UNVERIFIED(0), kind: "guest", confidence: 0.05 };
    const t = setup({ speaker: async () => guest });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 30);
    expect(t.brainCalls).toEqual([]);
  });

  it("sends each person's words with their own voice when several spoke, heard if any one of them would be", async () => {
    const guest: SpeakerIdentity = { ...UNVERIFIED(0), kind: "guest", confidence: 0.2 };
    const sara: SpeakerIdentity = { ...guest, kind: "saved", personId: "sara", name: "Sara" };
    const owner: SpeakerIdentity = { ...guest, kind: "owner", personId: "owner" };
    const heard: number[] = [];
    const t = setup({
      speaker: async () => guest,
      voices: async () => ({
        kind: "many",
        spans: [
          { startMs: 0, endMs: 500, identity: sara },
          { startMs: 500, endMs: 1_200, identity: owner },
        ],
      }),
      preview: async (pcm) => (
        heard.push(pcm.length),
        pcm.length === 8_000 ? "what time is it" : "set a timer"
      ),
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 30);
    // After the early preview of the whole turn, each span alone.
    expect(heard.slice(-2)).toEqual([8_000, 11_200]);
    expect(t.brainCalls.at(-1)!.tessaya.segments).toEqual([
      { speaker: sara, words: "what time is it" },
      { speaker: owner, words: "set a timer" },
    ]);
  });

  it("asks for one at a time, without her brain, when too many voices meet", async () => {
    const spoken: string[] = [];
    const t = setup({
      voices: async () => ({ kind: "one-at-a-time", why: "three-voices" }),
      speak: async function* (text) {
        spoken.push(text);
        yield new Int16Array(3_200);
      },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 30);
    expect(t.brainCalls).toEqual([]);
    expect(spoken).toEqual(["One at a time, please."]);
  });

  it("stops talking and flushes the R1's buffer when what he cut in with is his", async () => {
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
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.feed(true, 10);
    // Cut off once what he said is known to be his, not on sound alone (it may be her own voice).
    await t.feed(false, 8);
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
    t.s2();
    await turn(t);
    await turn(t);
    await t.deps.sleep(ROOM_CONFIG.followMs + 2_000);
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
      // "No, dismissed." rests the session on the R1 itself, with no brain call.
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

  it("hands a turn to the persona he calls, in its voice and eyes, for the whole session until he names another (13 Nov)", async () => {
    const voices: Array<string | undefined> = [];
    const t = setup({
      recognise: said([
        "Alfred, what broke?",
        "And the fix?",
        "Alfred, still there?",
        "Tessaya, what time is it?",
      ]),
      speak: async function* (_text, _signal, voice) {
        voices.push(voice);
        yield new Int16Array(3_200);
      },
    });
    await turn(t);
    await turn(t);
    // The window lapses (sleepy eyes), and Alfred is still the one who answers.
    await t.deps.sleep(ROOM_CONFIG.followMs + 2_000);
    t.room.sweep();
    await turn(t);
    await turn(t);
    expect(t.brainCalls.map((c) => [c.tessaya.persona, c.tessaya.switched])).toEqual([
      ["engineering", true],
      ["engineering", undefined],
      ["engineering", undefined],
      ["executive", true],
    ]);
    expect(new Set(voices)).toEqual(new Set(["peter_yearsley", "eve"]));
    expect(voices.at(-1)).toBe("eve");
    expect(
      t.published.filter((p) => p.topic.endsWith("/cmd/eye/persona")).map((p) => String(p.payload)),
    ).toEqual(['{"name":"alfred"}', '{"name":"tessaya"}']);
  });

  it("does not chain into a conversation with the room (19:05, 12 Nov): audio alone opens nothing, a stray 'yeah' extends nothing", async () => {
    const cascade = ["Yes.", "Okay.", "Movie going here.", "Yeah.", "Yeah."];
    // Short lines a second or two apart, as they came.
    const quick = async (t: ReturnType<typeof setup>) => {
      await t.feed(true, 10);
      await t.feed(false, 10);
    };
    const heardOnly = setup({ recognise: said(cascade) });
    for (const _ of cascade) await quick(heardOnly);
    expect(heardOnly.brainCalls).toEqual([]);

    // Had S2 opened it: his first words are hers, a stray "okay" or "yeah" after her answers is not.
    const pressed = setup({ recognise: said(cascade) });
    pressed.s2();
    for (const _ of cascade) await quick(pressed);
    expect(pressed.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Yes.",
      "Movie going here.",
    ]);
  });

  it("holds the window for his answer when her reply asks for one (19:23:44, 12 Nov), and glances at a turn just too late", async () => {
    const replies: Record<string, string> = {
      "Can you take a look at my laptop?":
        "I can't look at your laptop, because it isn't linked to this server. You'd need to link it first.",
      "What time is it?": "It's twenty-three minutes past seven.",
    };
    const t = setup({
      recognise: said([
        "Can you take a look at my laptop?",
        "How do I link it?",
        "What time is it?",
        "And the date?",
      ]),
      brain: async function* (input) {
        t.brainCalls.push(input);
        yield replies[input.messages.at(-1)!.content] ?? "Fine.";
      },
    });
    const glances = () => t.published.filter((p) => String(p.payload).includes('"glance"')).length;
    t.s2();
    await turn(t);
    // Past the usual window after her reply, inside the longer hold.
    await t.deps.sleep(ROOM_CONFIG.followMs + 2_000);
    await turn(t);
    await turn(t);
    // Her answer asked nothing: this one starts a second or so after the usual window closed.
    await t.deps.sleep(ROOM_CONFIG.followMs - 2_000);
    await turn(t);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Can you take a look at my laptop?",
      "How do I link it?",
      "What time is it?",
    ]);
    expect(glances()).toBe(1);
  });

  it("after S2 his first words are hers, however late he starts, after a reply of hers too (00:20, 13 Nov)", async () => {
    const logs: string[] = [];
    const t = setup({ recognise: said(["What's on today?"]), log: (l) => logs.push(l) });
    t.s2();
    await turn(t);
    expect(t.brainCalls).toHaveLength(1);

    // S2, then a line of hers from the server, then him 25 s later: still his first turn.
    const late = setup({ recognise: said(["What's on today?", "And tomorrow?"]) });
    late.s2();
    late.room.message(
      `freya/r1/${DEV}/voice/say`,
      Buffer.from(JSON.stringify({ text: "Morning." })),
    );
    // Her line goes out first (on the fake clock it would otherwise play over him).
    await late.feed(false, 5);
    await late.deps.sleep(ROOM_CONFIG.firstTurnMs - 5_000);
    await turn(late);
    expect(late.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual(["What's on today?"]);

    // Audio alone still opens nothing, and the log says what was not answered.
    const room = setup({ recognise: said(["the match starts at nine"]), log: (l) => logs.push(l) });
    await turn(room);
    expect(room.brainCalls).toEqual([]);
    // His words are never logged (13 Nov): only that a line of 5 words was held back.
    expect(
      logs.some((l) => /not said to her; not answered.*\(5 words, #[0-9a-f]{8}\)/.test(l)),
    ).toBe(true);
    expect(logs.some((l) => l.includes("match"))).toBe(false);
  });

  /** Speech-like sound: a pitch under a syllable-rate envelope (her voice and his differ in both). */
  const voice = (n: number, pitchHz: number, syllableHz: number, from = 0) =>
    Int16Array.from({ length: n }, (_, k) => {
      const i = k + from;
      const env = Math.abs(Math.sin((Math.PI * syllableHz * i) / 16_000));
      return Math.round(9_000 * env * Math.sin((2 * Math.PI * pitchHz * i) / 16_000));
    });

  it("never answers her own voice coming back through the R1's mic, nor stops for it (00:40, 13 Nov)", async () => {
    // Her whole reply goes out at once (no pacing), so each frame sounds at a known time.
    const t = setup(
      {
        recognise: said(["What time is it?", "Twenty to one in the morning."]),
        brain: async function* (input) {
          t.brainCalls.push(input);
          yield "Twenty to one, in the morning. It's late for a chat.";
        },
        speak: async function* () {
          for (let i = 0; i < 10; i += 1) yield voice(3_200, 210, 3.1, i * 3_200);
        },
      },
      { ...QUIET, leadMs: 60_000, prerollMs: 0 },
    );
    const played: Array<{ at: number; pcm: Int16Array }> = [];
    const publish = t.deps.publish;
    (t.deps as { publish: RoomDeps["publish"] }).publish = (topic, payload) => {
      if (topic.endsWith("/voice/down"))
        played.push({
          at: t.deps.now(),
          pcm: new Int16Array(Uint8Array.from(payload as Uint8Array).buffer),
        });
      publish(topic, payload);
    };
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    // Each frame comes back through the mic, quieter, as it sounds (downlink 300 ms, a Bluetooth speaker's lag).
    let sounds = 0;
    let k = 0;
    for (let idle = 0; idle < 20;) {
      const p = played[k];
      if (p === undefined) {
        idle += 1;
        await t.feed(false, 1);
        continue;
      }
      idle = 0;
      k += 1;
      sounds = Math.max(p.at + ROOM_CONFIG.downDelayMs, sounds + 60);
      await t.deps.sleep(Math.max(0, sounds + 180 - t.deps.now()));
      t.room.message(`freya/r1/${DEV}/voice/up`, toBytes(p.pcm.map((v) => Math.round(v * 0.4))));
      await t.room.session(DEV)!.drained();
    }
    expect(k).toBeGreaterThan(60);
    await t.feed(false, 60);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual(["What time is it?"]);
    expect(
      t.published.filter(
        (p) => p.topic.endsWith("/voice/ctl") && String(p.payload).includes("flush"),
      ),
    ).toEqual([]);
  });

  it("drops her echo by how it sounds, partly cancelled and with her persona's name in it (09:00 sweep, 13 Nov)", async () => {
    const t = setup(
      {
        recognise: said(["Can I talk to someone else?", "Freya, I can take that over."]),
        brain: async function* (input) {
          t.brainCalls.push(input);
          yield "Freya, I can take that over. Tell me what you need.";
        },
        speak: async function* () {
          for (let i = 0; i < 10; i += 1) yield voice(3_200, 210, 3.1, i * 3_200);
        },
      },
      { ...QUIET, leadMs: 60_000, prerollMs: 0 },
    );
    const played: Array<{ at: number; pcm: Int16Array }> = [];
    const publish = t.deps.publish;
    (t.deps as { publish: RoomDeps["publish"] }).publish = (topic, payload) => {
      if (topic.endsWith("/voice/down"))
        played.push({
          at: t.deps.now(),
          pcm: new Int16Array(Uint8Array.from(payload as Uint8Array).buffer),
        });
      publish(topic, payload);
    };
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    // What the mic hears while she plays: her voice, mostly cancelled, under a little of the room.
    const room = voice(960 * 80, 333, 5.3);
    let sounds = 0;
    let k = 0;
    for (let idle = 0; idle < 20;) {
      const f = played[k];
      if (f === undefined) {
        idle += 1;
        await t.feed(false, 1);
        continue;
      }
      idle = 0;
      sounds = Math.max(f.at + ROOM_CONFIG.downDelayMs, sounds + 60);
      await t.deps.sleep(Math.max(0, sounds + 180 - t.deps.now()));
      const noise = room.subarray((k % 80) * 960, (k % 80) * 960 + 960);
      t.room.message(
        `freya/r1/${DEV}/voice/up`,
        toBytes(f.pcm.map((v, i) => Math.round(v * 0.25 + noise[i]! * 0.03))),
      );
      k += 1;
      await t.room.session(DEV)!.drained();
    }
    await t.feed(false, 60);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Can I talk to someone else?",
    ]);
    expect(t.published.filter((p) => p.topic.endsWith("/cmd/eye/persona"))).toEqual([]);
  });

  it("never answers a turn heard before the R1 muted itself (08:39, 08:45 and 08:50, 13 Nov)", async () => {
    let finished: (text: string) => void = () => undefined;
    let settled: (how: string) => void = () => undefined;
    const outcome = new Promise<string>((r) => (settled = r));
    const t = setup({
      recognise: () => ({
        feed: () => undefined,
        finish: () => new Promise<string>((r) => (finished = r)),
        cancel: () => undefined,
      }),
      brain: async function* () {
        settled("answered");
        yield "";
      },
      log: (l) => {
        if (l.includes("not answered")) settled("held back");
      },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    // The mute arrives while the recogniser is still on it.
    t.room.message(`freya/r1/${DEV}/voice/ctl`, Buffer.from('{"ev":"mute"}'));
    finished("So here's the thing, the first job failed because the token expired.");
    expect(await outcome).toBe("held back");
  });

  describe("stopping her while she speaks (13 Nov: he could not stop or dismiss her)", () => {
    /** Her reply, the mic open over it: each 60 ms frame of hers comes back as it sounds, or his words instead. */
    const overHer = async (heard: ReadonlyArray<string>, over: "echo" | "his") => {
      const logs: string[] = [];
      const t = setup(
        {
          recognise: said(heard),
          brain: async function* (input) {
            t.brainCalls.push(input);
            yield "The office fan is on, and I'll stop it in a minute. Shall I stop the lamp too?";
          },
          speak: async function* () {
            for (let i = 0; i < 10; i += 1) yield voice(3_200, 210, 3.1, i * 3_200);
          },
          log: (l) => logs.push(l),
          // Her "rest once played" timer would jump this fake clock to the end of her reply; it runs without moving it.
          sleep: async (ms) => {
            if (ms < 1_000) t.advance(ms);
          },
        },
        { ...QUIET, leadMs: 60_000, prerollMs: 0 },
      );
      const played: Array<{ at: number; pcm: Int16Array }> = [];
      const publish = t.deps.publish;
      (t.deps as { publish: RoomDeps["publish"] }).publish = (topic, payload) => {
        if (topic.endsWith("/voice/down"))
          played.push({
            at: t.deps.now(),
            pcm: new Int16Array(Uint8Array.from(payload as Uint8Array).buffer),
          });
        publish(topic, payload);
      };
      t.s2();
      await t.feed(true, 20);
      await t.feed(false, 8);
      const first = played[0]!.at + ROOM_CONFIG.downDelayMs + 180;
      const his = voice(960 * 12, 120, 4.7);
      // A second into her reply: her own words back through the mic, or his short word over her.
      for (let k = 16; k < 28; k += 1) {
        await t.deps.sleep(Math.max(0, first + k * 60 - t.deps.now()));
        const pcm =
          over === "echo"
            ? played[k]!.pcm.map((v) => Math.round(v * 0.4))
            : his.slice((k - 16) * 960, (k - 15) * 960);
        t.room.message(`freya/r1/${DEV}/voice/up`, toBytes(pcm));
        await t.room.session(DEV)!.drained();
      }
      await t.feed(false, 12);
      const flushed = t.published.some(
        (p) => p.topic.endsWith("/voice/ctl") && String(p.payload).includes("flush"),
      );
      return { t, logs, flushed };
    };

    it("never stops for her own words, though they say stop", async () => {
      const r = await overHer(["Turn the office fan on.", "I'll stop it in a minute."], "echo");
      expect(r.flushed).toBe(false);
      expect(r.t.brainCalls).toHaveLength(1);
    });

    it("stops at once for his stop, answers nothing for it, and listens for his next words", async () => {
      const r = await overHer(["Turn the office fan on.", "Stop.", "What time is it?"], "his");
      expect(r.flushed).toBe(true);
      expect(r.logs.some((l) => l.includes("he said stop; she stopped"))).toBe(true);
      // A breath, then his next request, with no name: she is listening.
      await r.t.feed(false, 15);
      await r.t.feed(true, 20);
      await r.t.feed(false, 40);
      expect(r.t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
        "Turn the office fan on.",
        "What time is it?",
      ]);
    });

    it("is dismissed over her voice, and nothing else he says over her is taken", async () => {
      const sent = await overHer(["Turn the office fan on.", "Dismissed."], "his");
      expect(sent.flushed).toBe(true);
      await sent.t.feed(false, 20);
      expect(sent.t.published.some((p) => p.payload === '{"mood":"sleepy"}')).toBe(true);
      const other = await overHer(["Turn the office fan on.", "Turn the lamp on as well."], "his");
      expect(other.flushed).toBe(false);
      expect(other.t.brainCalls).toHaveLength(1);
      expect(other.logs.some((l) => l.includes("over her voice and not a stop"))).toBe(true);
    });

    it("stops on the R1's own stop (S2 or a tap), and a turn on its way then is not answered", async () => {
      let finished: (text: string) => void = () => undefined;
      let n = 0;
      const t = setup({
        recognise: () => {
          n += 1;
          return {
            feed: () => undefined,
            finish:
              n === 1 ? async () => "Turn the fan on." : () => new Promise((r) => (finished = r)),
            cancel: () => undefined,
          };
        },
        speak: async function* (_t, signal) {
          yield new Int16Array(3_200);
          await abortedBy(signal);
        },
      });
      t.s2();
      await t.feed(true, 20);
      await t.feed(false, 8);
      await t.feed(true, 20);
      await t.feed(false, 8);
      t.room.message(`freya/r1/${DEV}/event/voice/interrupt`, Buffer.from('{"src":"key"}'));
      finished("And the lamp.");
      await t.feed(false, 20);
      expect(
        t.published.some(
          (p) => p.topic.endsWith("/voice/ctl") && String(p.payload).includes("flush"),
        ),
      ).toBe(true);
      expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual(["Turn the fan on."]);
    });
  });

  it("never answers on a bench sweep (cmd/voice/no-reply), and answers again once it is cleared", async () => {
    const logs: string[] = [];
    const t = setup({
      recognise: said(["So here's the thing, the first job failed.", "What time is it?"]),
      log: (l) => logs.push(l),
    });
    t.room.message(`freya/r1/${DEV}/cmd/voice/no-reply`, Buffer.from('{"on":true}'));
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(t.brainCalls).toEqual([]);
    expect(logs.some((l) => /bench, not answered; his \(likeness 0\.00, 8 words, #/.test(l))).toBe(
      true,
    );
    t.room.message(`freya/r1/${DEV}/cmd/voice/no-reply`, Buffer.from('{"on":false}'));
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual(["What time is it?"]);
  });

  it("answers his command just after her reply though it shares her words (13 Nov, 07:40 and 07:41)", async () => {
    const t = setup({
      recognise: said(["Turn the office fan on.", "Turn it off now."]),
      brain: async function* (input) {
        t.brainCalls.push(input);
        yield "The office fan is on. Shall I turn it off by hand later?";
      },
      speak: async function* () {
        for (let i = 0; i < 6; i += 1) yield voice(3_200, 210, 3.1, i * 3_200);
      },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    // Right as her last words fade, in his own voice.
    const his = voice(960 * 18, 120, 4.7);
    for (let i = 0; i < 18; i += 1) {
      t.room.message(`freya/r1/${DEV}/voice/up`, toBytes(his.slice(i * 960, (i + 1) * 960)));
      await t.deps.sleep(60);
      await t.room.session(DEV)!.drained();
    }
    await t.feed(false, 60);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Turn the office fan on.",
      "Turn it off now.",
    ]);
  });

  it("opens the window again when the R1 comes back on the link mid-session (00:43, 13 Nov)", async () => {
    const t = setup({
      recognise: said(["Turn on the office fan.", "Is it on now?", "And the lamp?"]),
    });
    t.s2();
    await turn(t);
    await t.deps.sleep(ROOM_CONFIG.followMs + 5_000);
    await turn(t);
    expect(t.brainCalls).toHaveLength(1);
    t.room.message(`freya/r1/${DEV}/state/online`, Buffer.from("1"));
    await turn(t);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Turn on the office fan.",
      "And the lamp?",
    ]);
  });

  it("rests at once when sent away, without asking her brain", async () => {
    const spoken: string[] = [];
    const t = setup({
      recognise: said(["I said dismissed."]),
      speak: async function* (text) {
        spoken.push(text);
        yield new Int16Array(3_200);
      },
    });
    t.s2();
    await turn(t);
    expect(t.brainCalls).toEqual([]);
    // At once and on the R1 alone (10:36:40, 13 Nov: 6.5 s and a full sentence): sleepy eyes, no brain, no words.
    expect(spoken).toEqual([]);
    expect(t.published.some((p) => p.payload === '{"mood":"sleepy"}')).toBe(true);
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
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls[0]?.tessaya.persona).toBe("engineering");
    // The R1 only streams wake audio between sessions: once its mic has been quiet a while, the session here is stale.
    await t.deps.sleep(3_000);
    t.room.message(`freya/r1/${DEV}/voice/wake`, new Uint8Array(1920));
    expect(frames).toEqual([DEV, DEV]);
    expect(t.room.session(DEV)).toBeUndefined();
  });

  it("keeps the session her name just opened while the rest of that wake segment arrives (03:30 replay, 13 Nov)", async () => {
    // The loop's own wake path, with a detector that, like openWakeWord, scores nothing before 16 chunks.
    let room: ReturnType<typeof createRoomVoice> | null = null;
    let seen = 0;
    const wake = createWakeStream({
      words: [{ word: "Tessaya", threshold: 0.99 }],
      scorer: async (): Promise<WakeScorer> => ({
        chunkSamples: 1280,
        reset: () => {
          seen = 0;
        },
        score: async (chunk) => [(seen += 1) >= 16 && chunk.includes(7) ? 1 : 0],
      }),
      confirm: async () => "Tessaya.",
      onWake: (id, word) => room?.woken(id, word),
      log: () => undefined,
    });
    const t = setup({
      wake,
      recognise: () => ({
        feed: () => undefined,
        finish: async () => "what's on today?",
        cancel: () => undefined,
      }),
    });
    room = t.room;
    const segment = (v: number) => toBytes(new Int16Array(960).fill(v));
    // 300 ms before, his name, then quiet: a 1.0 s segment as SMP 0.3.36 sends it.
    for (let i = 0; i < 5; i += 1) t.room.message(`freya/r1/${DEV}/voice/wake`, segment(1));
    for (let i = 0; i < 6; i += 1) t.room.message(`freya/r1/${DEV}/voice/wake`, segment(7));
    await wake.drained(DEV);
    expect(t.published.some((p) => p.topic === `freya/r1/${DEV}/cmd/voice/start`)).toBe(true);
    // Its own start comes back, then the tail of the segment the R1 had already sent.
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    for (let i = 0; i < 6; i += 1) t.room.message(`freya/r1/${DEV}/voice/wake`, segment(1));
    t.room.message(`freya/r1/${DEV}/voice/wake/end`, new Uint8Array());
    expect(t.room.session(DEV)).toBeDefined();
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual(["what's on today?"]);
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
    t.s2();
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
    t.s2();
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
    t.s2();
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
  it("gives her voice the first clause as soon as it is whole, three words or more", () => {
    expect(firstClause("The office fan is on, and the lamp")).toEqual({
      head: "The office fan is on,",
      rest: "and the lamp",
    });
    expect(firstClause("Yes, it's on")).toBeNull();
    expect(firstClause("It's twenty to six")).toBeNull();
    expect(firstClause("Twenty-six minutes to eleven, in the")).toEqual({
      head: "Twenty-six minutes to eleven,",
      rest: "in the",
    });
  });

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
    const room = createRoomVoice(deps, { ...QUIET, inhouse: new Set(["r1-a"]) });
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
  it("switches to the next persona on an R1 button, in its voice, then answers a button's prompt as that persona", async () => {
    const spoken: Array<[string, string | undefined]> = [];
    const t = setup({
      speak: async function* (text, _signal, voice) {
        spoken.push([text, voice]);
        yield new Int16Array(3_200);
      },
    });
    t.room.message(`freya/r1/${DEV}/voice/persona`, Buffer.from("{}"));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    expect(spoken).toEqual([["Alfred here.", "peter_yearsley"]]);
    t.room.message(
      `freya/r1/${DEV}/voice/ask`,
      Buffer.from(JSON.stringify({ text: "What's next?" })),
    );
    await t.metrics;
    expect(t.brainCalls.map((c) => [c.messages.at(-1)?.content, c.tessaya.persona])).toEqual([
      ["What's next?", "engineering"],
    ]);
    t.room.message(`freya/r1/${DEV}/voice/persona`, Buffer.from('{"name":"freya"}'));
    expect(spoken.at(-1)).toEqual(["Fray-uh here.", "azelma"]);
  });

  it("asks a button's prompt with no session only once the R1 has opened its mic", async () => {
    const t = setup();
    t.room.message(
      `freya/r1/${DEV}/voice/ask`,
      Buffer.from(JSON.stringify({ text: "What's next?" })),
    );
    expect(t.published.map((p) => p.topic)).toContain(`freya/r1/${DEV}/cmd/voice/start`);
    expect(t.room.session(DEV)).toBeUndefined();
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.metrics;
    expect(t.brainCalls.map((c) => c.messages.at(-1)?.content)).toEqual(["What's next?"]);
  });

  it("says a line on the R1 when asked, and hears nothing while muted", async () => {
    const t = setup();
    t.room.message(
      `freya/r1/${DEV}/voice/say`,
      Buffer.from(JSON.stringify({ text: "Dinner is ready." })),
    );
    // The R1 plays her voice only in its own session: it is asked to open one, and the line ends it.
    expect(t.published.map((p) => p.topic)).toEqual([`freya/r1/${DEV}/cmd/voice/start`]);
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await vi.waitFor(() =>
      expect(t.published.map((p) => p.topic)).toContain(`freya/r1/${DEV}/cmd/voice/stop`),
    );
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
      t.s2();
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
    const played: string[] = [];
    const confirmed: string[] = [];
    const g = guessing("turn on the study light", "Turn on the study light.", {
      played: (callId) => played.push(callId),
      confirmed: (callId) => confirmed.push(callId),
    });
    const m = await g.run();
    expect(g.atRelease()).toBe(1);
    expect(g.asked).toEqual(["turn on the study light"]);
    expect(m.speculative).toBe(true);
    expect(g.t.published.some((p) => p.topic.endsWith("voice/down"))).toBe(true);
    // Only now, played to him, may the server record the guess and learn from it.
    expect(played).toHaveLength(1);
    // Its held house changes were released for the same guess.
    expect(confirmed).toEqual(played);
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
    const played: string[] = [];
    const confirmed: string[] = [];
    const sent: Array<{ speculative?: true; callId?: string }> = [];
    const g = guessing("turn on the study", "turn on the study light", {
      played: (callId) => played.push(callId),
      confirmed: (callId) => confirmed.push(callId),
      brain: async function* (input) {
        sent.push(input.tessaya);
        yield "Done.";
      },
    });
    const m = await g.run();
    expect(m.speculative).toBe(false);
    // The guess went out marked as one, the final turn did not, and the thrown-away guess is never reported played.
    expect(sent.map((t) => t.speculative === true)).toEqual([true, false]);
    expect(played).toEqual([]);
    // The guess heard other words: whatever it would have changed is never released.
    expect(confirmed).toEqual([]);
  });
});

describe("the 13 Nov audit: one sentence, one answer, and only what she means to say", () => {
  const heardInTurn = (texts: ReadonlyArray<string>, partials: ReadonlyArray<string> = []) => {
    let n = 0;
    return () => {
      const i = n++;
      return {
        feed: () => undefined,
        finish: async () => texts[i] ?? "",
        cancel: () => undefined,
        onPartial: (l: (text: string) => void) => {
          if (partials[i]) l(partials[i]!);
        },
      };
    };
  };

  it("joins a sentence he paused in to its rest and answers it once (07:39:13)", async () => {
    const holds: Array<() => void> = [];
    const t = setup({
      recognise: heardInTurn(["Is it possible to", "have you turn it on for just one minute."]),
      sleep: async (ms) => {
        if (ms === ROOM_CONFIG.joinMs) await new Promise<void>((r) => holds.push(r));
        else t.advance(ms);
      },
    });
    t.room.message(
      `freya/r1/${DEV}/state/caps`,
      Buffer.from('{"fw":"smp-0.3.38","bt_speaker":true,"eyes":true}'),
    );
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    expect(t.brainCalls).toEqual([]);
    await t.feed(true, 20);
    await t.feed(false, 8);
    for (const release of holds) release();
    await t.feed(false, 20);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Is it possible to have you turn it on for just one minute.",
    ]);
    expect(t.brainCalls[0]!.messages).toHaveLength(1);
    // The envelope every vessel sends her one turn pipeline (MEMORY-V2-DESIGN §2.0).
    expect(t.brainCalls[0]!.tessaya).toEqual({
      vessel: { kind: "device", id: DEV },
      origin: "voice",
      persona: "executive",
      addressed: true,
      via: "first",
      tainted: false,
      tz: ROOM_CONFIG.tz,
      words: "Is it possible to have you turn it on for just one minute.",
      capabilities: ["bt_speaker", "eyes"],
      speaker: expect.objectContaining({ kind: "unverified" }),
    });

    // Nothing follows: the half sentence is answered on its own after the wait.
    const alone = setup({ recognise: heardInTurn(["Is it possible to"]) });
    alone.s2();
    await alone.feed(true, 20);
    await alone.feed(false, 40);
    expect(alone.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual(["Is it possible to"]);
  });

  it("stops her at once when he says her name over her, and answers him, not the stale turn", async () => {
    const t = setup({
      recognise: heardInTurn(
        ["What time is it?", "Tessaya, turn the office fan off."],
        ["", "Tessaya, turn the"],
      ),
      brain: async function* (input, signal) {
        t.brainCalls.push(input);
        yield "It's seven forty. ";
        if (input.messages.at(-1)!.content === "What time is it?") await abortedBy(signal);
        yield "Done.";
      },
      speak: async function* (_text, signal) {
        yield new Int16Array(3_200);
        await abortedBy(signal);
      },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    // He talks over her (firmware that sends the mic while she plays).
    await t.feed(true, 20);
    const flushes = () =>
      t.published.filter(
        (p) => p.topic.endsWith("/voice/ctl") && String(p.payload).includes("flush"),
      );
    expect(flushes()).toHaveLength(1);
    await t.feed(false, 20);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "What time is it?",
      "Tessaya, turn the office fan off.",
    ]);
    // Begun over her voice: the pipeline is told some of it may be hers.
    expect(t.brainCalls.map((c) => c.tessaya.tainted)).toEqual([false, true]);
  });

  it("open talk-over: anything he says over her stops her and is answered; her own echo never does", async () => {
    // Her reply as speech-like sound, and the R1's 0.3.92 uplink: each frame says how much of her it has played.
    const her = Int16Array.from(speechLike(6, 3, 190), (v) => v * 32768);
    const run = async (mode: "open" | "keyword", him: boolean) => {
      const t = setup({
        recognise: heardInTurn(["What time is it?", "No, I meant in London."]),
        vad: () => ({
          score: async (w) =>
            Math.sqrt(w.reduce((a, v) => a + v * v, 0) / w.length) > 300 ? 0.9 : 0.05,
        }),
        brain: async function* (input, signal) {
          t.brainCalls.push(input);
          yield "It's seven forty here, and the sun is up.";
          if (input.messages.at(-1)!.content === "What time is it?") await abortedBy(signal);
        },
        speak: async function* (_text, signal) {
          yield her;
          await abortedBy(signal);
        },
      });
      t.room.message(`freya/r1/${DEV}/cmd/voice/talkover`, Buffer.from(JSON.stringify({ mode })));
      let seq = 0;
      let played = 0;
      const sent = () =>
        t.published
          .filter((p) => p.topic.endsWith("/voice/down"))
          .reduce((n, p) => n + (p.payload as Uint8Array).length, 0);
      const up = async (voice: (i: number) => number, n: number) => {
        for (let k = 0; k < n; k += 1) {
          const rx = sent();
          const pcm = new Int16Array(960);
          for (let i = 0; i < 960; i += 1) {
            // What is left of her after the R1's own echo cancelling (-26 dB), at its 123 ms latency, plus him.
            const e = played / 2 + i - 1972;
            pcm[i] =
              (e >= 0 && e < rx / 2 ? her[e % her.length]! * 0.05 : 0) + voice(seq * 960 + i);
          }
          played = Math.min(rx, played + 1920);
          const head = new DataView(new ArrayBuffer(16));
          head.setUint32(0, seq, true);
          head.setUint32(4, rx, true);
          head.setUint32(8, rx - played, true);
          const bytes = new Uint8Array(16 + 1920);
          bytes.set(new Uint8Array(head.buffer), 0);
          bytes.set(toBytes(pcm), 16);
          t.room.message(`freya/r1/${DEV}/voice/up/tainted`, bytes);
          seq += 1;
          t.advance(60);
          await t.room.session(DEV)!.drained();
        }
      };
      const loud = (i: number) => Math.round(4000 * Math.sin(i / 7) * Math.sin(i / 900));
      const quiet = () => 0;
      t.s2();
      await up(loud, 20);
      await up(quiet, 10);
      // She is talking now: her echo alone for 1.8 s, then (perhaps) him over her.
      await up(quiet, 30);
      if (him) await up(loud, 20);
      await up(quiet, 20);
      const flushed = t.published.some(
        (p) => p.topic.endsWith("/voice/ctl") && String(p.payload).includes("flush"),
      );
      return { flushed, asked: t.brainCalls.map((c) => c.messages.at(-1)!.content) };
    };
    expect(await run("open", true)).toEqual({
      flushed: true,
      asked: ["What time is it?", "No, I meant in London."],
    });
    // Her own voice coming back is not him.
    expect((await run("open", false)).flushed).toBe(false);
    // Keyword mode (the default): over her voice only a stop phrase or her name counts.
    expect((await run("keyword", true)).asked).toEqual(["What time is it?"]);
  });

  it("never says her reasoning, nor keeps it in the conversation (07:17:55, 07:38:34, 07:44:27)", async () => {
    const spoken: string[] = [];
    const t = setup({
      recognise: heardInTurn(["To say yeah.", "Turn the fan off."]),
      brain: async function* (input) {
        t.brainCalls.push(input);
        yield "Looks like a stray fragment; the office fan was already turned off earlier and nothing is pending. ";
        yield "I'll keep it short. Got it, nothing else is waiting on you.";
      },
      speak: async function* (text) {
        spoken.push(text);
        yield new Int16Array(3_200);
      },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(spoken).toContain("Got it, nothing else is waiting on you.");
    expect(spoken.join(" ")).not.toMatch(/stray fragment|keep it short/);
    expect(t.brainCalls[1]!.messages[1]).toEqual({
      role: "assistant",
      content: "Got it, nothing else is waiting on you.",
    });
  });

  it("says words his way once her server sends his pronunciations, and sends who was addressed and why", async () => {
    const spoken: string[] = [];
    const t = setup({
      recognise: heardInTurn(["Say your name."]),
      brain: async function* () {
        yield "I'm Tessaya, and this is Kazi.";
      },
      speak: async function* (text) {
        spoken.push(text);
        yield new Int16Array(3_200);
      },
    });
    t.room.message(`freya/r1/${DEV}/voice/pronounce`, Buffer.from('{"Kazi":"Kah-zee"}'));
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(spoken).toEqual(["I'm Tessayya, and this is Kah-zee."]);
  });

  it("logs every eye command and its acknowledgement, and says when one never came", async () => {
    const logs: string[] = [];
    const t = setup({ log: (l) => logs.push(l) });
    t.room.message(`freya/r1/${DEV}/cmd/eye/persona`, Buffer.from('{"name":"alfred"}'));
    t.room.message(`freya/r1/${DEV}/cmd/eye/set`, Buffer.from('{"mood":"thinking"}'));
    t.advance(120);
    t.room.message(`freya/r1/${DEV}/state/eye/persona`, Buffer.from('{"name":"alfred"}'));
    t.room.message(`freya/r1/${DEV}/cmd/eye/persona`, Buffer.from('{"name":"freya"}'));
    t.advance(4_000);
    t.room.sweep();
    expect(logs).toEqual([
      `[${DEV}] eye seen cmd/eye/persona {"name":"alfred"}`,
      `[${DEV}] eye seen cmd/eye/set {"mood":"thinking"}`,
      `[${DEV}] eye ack persona {"name":"alfred"} after 120 ms`,
      `[${DEV}] eye seen cmd/eye/persona {"name":"freya"}`,
      `[${DEV}] eye persona freya: no acknowledgement in 3 s`,
    ]);
    // The loop's own: an R1 button switches to Alfred.
    t.room.message(`freya/r1/${DEV}/voice/persona`, Buffer.from('{"name":"alfred"}'));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    expect(logs).toContain(`[${DEV}] eye sent cmd/eye/persona {"name":"alfred"}`);
  });
});

describe("his 10:35 to 10:37 session, 13 Nov", () => {
  const heard = (texts: ReadonlyArray<string>) => {
    let n = 0;
    return () => {
      const text = texts[n++] ?? "";
      return { feed: () => undefined, finish: async () => text, cancel: () => undefined };
    };
  };
  const loud = (amp: number) => toBytes(new Int16Array(960).fill(amp));
  const speakTurn = async (t: ReturnType<typeof setup>, amp = 3000, frames = 20) => {
    for (let i = 0; i < frames; i += 1) {
      t.room.message(`freya/r1/${DEV}/voice/up`, loud(amp));
      await t.deps.sleep(60);
      await t.room.session(DEV)!.drained();
    }
    await t.feed(false, 40);
  };

  it("takes his Urdu as his when the household speaks it, set per R1 by voice/languages (13 Nov correction)", async () => {
    const line = "Ik heb minekin, for nie bata. Foi já gente. Quem quer essa trilha?";
    const urdu = setup({ recognise: heard([line]) }, { ...QUIET, languages: ["en", "ur"] });
    urdu.s2();
    await speakTurn(urdu);
    expect(urdu.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([line]);
    const english = setup({ recognise: heard([line, line]) });
    english.s2();
    await speakTurn(english);
    expect(english.brainCalls).toEqual([]);
    english.room.message(
      `freya/r1/${DEV}/voice/languages`,
      Buffer.from('{"languages":["en","ur"]}'),
    );
    english.s2();
    await speakTurn(english);
    expect(english.brainCalls).toHaveLength(1);
  });

  it("keeps the room's TV out after her name: another language, or a voice far quieter than his", async () => {
    const t = setup({
      recognise: heard([
        "Ik heb minekin, for nie bata. Foi já gente. Quem quer essa trilha?",
        "And so the match goes on in the other room tonight.",
        "What time is it?",
      ]),
    });
    t.room.woken(DEV, "Tessaya", -20);
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await speakTurn(t);
    await speakTurn(t, 200);
    await speakTurn(t);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual(["What time is it?"]);
  });

  it("answers the same question once when the transcript grows by 'Oh.' (10:36:11)", async () => {
    const t = setup({ recognise: heard(["I think. Tessaya, what time is it?", "Oh."]) });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.feed(true, 6);
    await t.feed(false, 40);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "I think. Tessaya, what time is it?",
    ]);
  });

  it("rests at once on 'Dismiss.', never joined to what follows (10:37:43)", async () => {
    const logs: string[] = [];
    const t = setup({
      recognise: heard(["Dismiss.", "So do you know? But yeah, and he checked."]),
      log: (l) => logs.push(l),
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(t.brainCalls).toEqual([]);
    expect(logs.some((l) => l.includes("dismissed; she rests"))).toBe(true);
  });

  it("never holds a room that keeps talking for more than 2.5 s (10:35:22 to 10:35:46: 24 s)", async () => {
    const logs: string[] = [];
    const t = setup({
      recognise: heard([
        "So the thing is that",
        "and then the",
        "we went to the",
        "and after that the",
      ]),
      log: (l) => logs.push(l),
    });
    t.s2();
    for (let i = 0; i < 4; i += 1) {
      await t.feed(true, 15);
      await t.feed(false, 6);
    }
    await t.feed(false, 60);
    expect(logs.filter((l) => l.includes("held for the rest")).length).toBeLessThanOrEqual(2);
    expect(t.brainCalls.length).toBeGreaterThan(0);
  });

  it("never says 'Alfred here.' or his role pitch (10:36:57)", async () => {
    const spoken: string[] = [];
    const t = setup({
      recognise: heard(["Alfred."]),
      brain: async function* () {
        yield "Alfred here, ready when you are. Sessions, builds and releases are mine, so tell me what you need checked or shipped.";
      },
      speak: async function* (text) {
        spoken.push(text);
        yield new Int16Array(3_200);
      },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(spoken).toEqual(["ready when you are."]);
  });

  it("applies her server's eye mood as the one writer, and its own moods wait while it holds", async () => {
    const logs: string[] = [];
    const t = setup({ log: (l) => logs.push(l) });
    t.s2();
    t.room.message(
      `freya/r1/${DEV}/voice/intent/eye`,
      Buffer.from('{"vessel":"r1","mood":"thinking","holdMs":15000,"reason":"brain"}'),
    );
    await t.feed(true, 20);
    const moods = t.published
      .filter((p) => p.topic.endsWith("/cmd/eye/set"))
      .map((p) => JSON.parse(String(p.payload)).mood as string);
    expect(moods).toEqual(["thinking"]);
    expect(logs).toContain(`[${DEV}] eye intent thinking for 15000 ms (brain)`);
  });
});

describe("one responder per utterance (the server's voice arbiter, R1-P7)", () => {
  it("two R1s hear her name at once: both listen at once, the arbiter's loser closes and stays quiet", async () => {
    const claims: Array<{ deviceId: string; loudnessDb: number | null }> = [];
    let decide: () => void = () => undefined;
    const decided = new Promise<void>((r) => (decide = r));
    let quietLogged: () => void = () => undefined;
    const quiet = new Promise<void>((r) => (quietLogged = r));
    const t = setup({
      arbiter: {
        claim: async (c) => {
          claims.push(c);
          if (claims.length === 2) decide();
          await decided;
          const loudest = claims.toSorted(
            (a, b) => (b.loudnessDb ?? -99) - (a.loudnessDb ?? -99),
          )[0]!;
          return loudest.deviceId === c.deviceId
            ? { answer: true }
            : { answer: false, winner: loudest.deviceId, until: t.deps.now() + 20_000 };
        },
        report: () => undefined,
      },
      log: (l) => {
        if (l.includes("this R1 stays quiet")) quietLogged();
      },
    });
    let stopped: () => void = () => undefined;
    const farStopped = new Promise<void>((r) => (stopped = r));
    const publish = t.deps.publish;
    (t.deps as { publish: RoomDeps["publish"] }).publish = (topic, payload) => {
      publish(topic, payload);
      if (topic === "freya/r1/r1-far/cmd/voice/stop") stopped();
    };
    t.room.woken("r1-near", "Tessaya", -18, 1);
    t.room.woken("r1-far", "Tessaya", -35, 1);
    // Neither waits for the arbiter to start listening (13 Nov: a 1.3-1.7 s claim round before every wake).
    const started = () =>
      t.published
        .filter((p) => p.topic.endsWith("/cmd/voice/start"))
        .map((p) => p.topic.split("/")[2]);
    expect(started()).toEqual(["r1-near", "r1-far"]);
    await quiet;
    await farStopped;
    expect(
      t.published
        .filter((p) => p.topic.endsWith("/cmd/voice/stop"))
        .map((p) => p.topic.split("/")[2]),
    ).toEqual(["r1-far"]);
    // The far one hears her name again (her voice from the near one): not taken.
    t.room.woken("r1-far", "Tessaya", -30, 1);
    expect(claims).toHaveLength(2);
    expect(started()).toEqual(["r1-near", "r1-far"]);
  });

  it("never lets her voice out on an R1 whose claim is lost while it was answering", async () => {
    let lose: () => void = () => undefined;
    const lost = new Promise<void>((r) => (lose = r));
    const t = setup({
      recognise: () => ({
        feed: () => undefined,
        finish: async () => "What time is it?",
        cancel: () => undefined,
      }),
      arbiter: {
        claim: async () => {
          await lost;
          return { answer: false, winner: "r1-other", until: t.deps.now() + 20_000 };
        },
        report: () => undefined,
      },
    });
    t.room.message(`freya/r1/${DEV}/cmd/voice/earcons`, Buffer.from('{"on":false}'));
    t.room.woken(DEV, "Tessaya", -20, 1);
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    await t.feed(false, 10);
    lose();
    await t.feed(false, 30).catch(() => undefined);
    expect(t.published.filter((p) => p.topic.endsWith("/voice/down"))).toEqual([]);
  });

  it("claims with who Voice ID heard, and sends the conversation the arbiter names on the turns that follow", async () => {
    const claimed: Array<{ personId: string | null; verified: boolean } | null> = [];
    const t = setup({
      speaker: async () => ({
        kind: "owner",
        personId: "owner",
        name: null,
        confidence: 0.8,
        verified: true,
        inherited: false,
        at: 0,
      }),
      recognise: () => ({
        feed: () => undefined,
        finish: async () => "Tessaya, what time is it?",
        cancel: () => undefined,
      }),
      arbiter: {
        claim: async (c) => {
          claimed.push(c.speaker ?? null);
          return { answer: true, conversation: "person:owner" };
        },
        report: () => undefined,
      },
    });
    let opened: () => void = () => undefined;
    const open = new Promise<void>((r) => (opened = r));
    const publish = t.deps.publish;
    (t.deps as { publish: RoomDeps["publish"] }).publish = (topic, payload) => {
      publish(topic, payload);
      if (topic.endsWith("/cmd/voice/start")) opened();
    };
    t.room.woken(DEV, "Tessaya", -20, 1, new Int16Array(16_000));
    await open;
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(claimed).toEqual([{ personId: "owner", verified: true }]);
    expect(t.brainCalls[0]!.tessaya.conversation).toBe("person:owner");
  });

  it("answers as before when the arbiter cannot be asked (an older server)", async () => {
    let opened: () => void = () => undefined;
    const open = new Promise<void>((r) => (opened = r));
    const t = setup({
      arbiter: { claim: async () => null, report: () => undefined },
      publish: (topic) => {
        if (topic === `freya/r1/${DEV}/cmd/voice/start`) opened();
      },
    });
    t.room.woken(DEV, "Tessaya", -20, 1);
    // Resolves only if the R1 is told to start: an arbiter that cannot be asked never holds her back.
    await open;
  });

  it("tells the arbiter where her reply stands, then that it ended", async () => {
    const reports: string[] = [];
    const t = setup({
      arbiter: { claim: async () => ({ answer: true }), report: (op) => reports.push(op) },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(reports[0]).toBe("speaking");
    expect(reports.at(-1)).toBe("ended");
  });
});

describe("an early start on his stable words (B6)", () => {
  /** A recogniser whose partial words he sets, and whose final text waits until released. */
  const live = (final: string) => {
    const listeners: Array<(t: string) => void> = [];
    let release: () => void = () => undefined;
    const done = new Promise<void>((r) => (release = r));
    return {
      partial: (t: string) => listeners.forEach((l) => l(t)),
      release,
      recognise: () => ({
        feed: () => undefined,
        finish: async () => {
          await done;
          return final;
        },
        cancel: () => undefined,
        onPartial: (l: (t: string) => void) => void listeners.push(l),
      }),
    };
  };

  it("starts her brain at his pause on words that held still and end a sentence, and keeps it when the final says the same", async () => {
    const r = live("What time is it?");
    const t = setup({ recognise: r.recognise, smartTurn: async () => 0.2 });
    t.s2();
    await t.feed(true, 10);
    r.partial("What time is it?");
    await t.feed(true, 6);
    // His pause: Smart Turn is asked, and the words have held still for over 300 ms.
    await t.feed(false, 5);
    expect(t.brainCalls).toHaveLength(1);
    expect(t.brainCalls[0]!.tessaya).toMatchObject({
      speculative: true,
      words: "What time is it?",
    });
    await t.feed(false, 30);
    r.release();
    await t.metrics;
    expect(t.brainCalls).toHaveLength(1);
  });

  it("never starts on an unfinished line, starts on a whole request with no full stop, and drops a start the final words disagree with", async () => {
    const changing = live("Turn on the office fan");
    const a = setup({ recognise: changing.recognise, smartTurn: async () => 0.2 });
    a.s2();
    await a.feed(true, 10);
    changing.partial("Turn on the");
    await a.feed(true, 6);
    await a.feed(false, 5);
    expect(a.brainCalls).toHaveLength(0);

    // His words often reach the recogniser with no full stop (13 Nov: 1 of 18 started early).
    const bare = live("Turn on the office fan");
    const b = setup({ recognise: bare.recognise, smartTurn: async () => 0.2 });
    b.s2();
    await b.feed(true, 10);
    bare.partial("Turn on the office fan");
    await b.feed(true, 6);
    await b.feed(false, 5);
    expect(b.brainCalls).toHaveLength(1);

    const r = live("What time is it in London?");
    const t = setup({ recognise: r.recognise, smartTurn: async () => 0.2 });
    t.s2();
    await t.feed(true, 10);
    r.partial("What time is it?");
    await t.feed(true, 6);
    await t.feed(false, 5);
    expect(t.brainCalls).toHaveLength(1);
    await t.feed(false, 30);
    r.release();
    await t.metrics;
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "What time is it?",
      "What time is it in London?",
    ]);
  });
});

describe("an early start with no partial words: a preview of his audio at his first pause", () => {
  it("starts her brain on the preview when it reads as whole, and keeps it when his final words agree", async () => {
    let previews = 0;
    let release: () => void = () => undefined;
    const done = new Promise<void>((r) => (release = r));
    const logs: string[] = [];
    const t = setup({
      recognise: () => ({
        feed: () => undefined,
        finish: async () => {
          await done;
          return "What time is it?";
        },
        cancel: () => undefined,
      }),
      preview: async () => {
        previews += 1;
        return "What time is it?";
      },
      smartTurn: async () => 0.2,
      log: (l) => logs.push(l),
    });
    t.s2();
    await t.feed(true, 16);
    await t.feed(false, 5);
    expect(previews).toBe(1);
    expect(t.brainCalls).toHaveLength(1);
    await t.feed(false, 30);
    release();
    await t.metrics;
    expect(t.brainCalls).toHaveLength(1);
    expect(logs.some((l) => l.includes("early start kept"))).toBe(true);
  });
});

describe("a member's data destroyed (identity lane)", () => {
  it("removes their voice profile here, and ignores a message without a member", () => {
    const forgotten: string[] = [];
    const t = setup({ forget: (id) => forgotten.push(id) });
    t.room.message(`freya/r1/${DEV}/voice/forget`, Buffer.from('{"personId":"member-7"}'));
    t.room.message(`freya/r1/${DEV}/voice/forget`, Buffer.from("{}"));
    expect(forgotten).toEqual(["member-7"]);
  });
});

describe("her brain starts alongside the speaker check (13 Nov, Sonnet)", () => {
  it("asks her brain before Voice ID has answered, and a voice the gate keeps out is still never heard", async () => {
    let tell: (who: SpeakerIdentity) => void = () => undefined;
    const t = setup({
      speaker: () => new Promise<SpeakerIdentity>((r) => (tell = r)),
      speak: async function* (_text, signal) {
        yield new Int16Array(3_200);
        await abortedBy(signal);
      },
    });
    t.room.message(`freya/r1/${DEV}/cmd/voice/earcons`, Buffer.from('{"on":false}'));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    await t.feed(false, 8);
    expect(t.brainCalls).toHaveLength(1);
    tell({
      kind: "guest",
      personId: null,
      name: null,
      confidence: 0.1,
      verified: false,
      inherited: false,
      at: 0,
    });
    await t.feed(false, 20);
    expect(t.published.filter((p) => p.topic.endsWith("/voice/down"))).toEqual([]);
  });
});

describe("recognising who she is talking to across a session (recognition.ts)", () => {
  const owner = (confidence: number, verified: boolean): SpeakerIdentity => ({
    kind: "owner",
    personId: "member-1",
    name: "Rab",
    confidence,
    verified,
    inherited: false,
    at: 0,
  });
  const lines = (texts: ReadonlyArray<string>) => {
    let n = 0;
    return () => {
      const text = texts[n++] ?? "";
      return { feed: () => undefined, finish: async () => text, cancel: () => undefined };
    };
  };

  it("looks warmly once and says his name once, on the turn he is first recognised", async () => {
    const t = setup({
      recognise: lines(["What time is it?", "And the date?"]),
      speaker: async () => owner(0.7, true),
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(t.brainCalls.map((c) => c.tessaya.nameOnce)).toEqual(["Rab", undefined]);
    expect(t.published.filter((p) => String(p.payload) === '{"mood":"happy"}')).toHaveLength(1);
  });

  it("asks before an act her server holds, and lets it run once his reply proves it is him", async () => {
    const spoken: string[] = [];
    let said = "";
    const t = setup({
      recognise: () => ({
        feed: () => undefined,
        finish: async () => said,
        cancel: () => undefined,
      }),
      speaker: async () => owner(0.6, false),
      speak: async function* (text) {
        spoken.push(text);
        yield new Int16Array(3_200);
      },
    });
    t.s2();
    t.room.message(
      `freya/r1/${DEV}/voice/stepup`,
      Buffer.from('{"act":"unlock-door","shared":true}'),
    );
    const ask = spoken.at(-1)!;
    expect(ask.startsWith("I'm not sure it's you yet.")).toBe(true);
    said = /"([a-z]+ [a-z]+)"/.exec(ask)![1]!;
    // His voice over a few turns adds up to a match: the phrase answers, and the act runs.
    await t.feed(true, 80);
    await t.feed(false, 40);
    const done = t.published.filter((p) => p.topic.endsWith("/voice/stepup/done"));
    expect(done.map((p) => JSON.parse(String(p.payload)) as { act: string; ok: boolean })).toEqual([
      expect.objectContaining({ act: "unlock-door", ok: true, how: "voice" }),
    ]);
    expect(t.brainCalls).toEqual([]);
  });

  it("takes S2 as presence for a held act, and a member's own persona and voice once he is recognised", async () => {
    const voices: Array<string | undefined> = [];
    const t = setup({
      recognise: lines(["What's on today?"]),
      speaker: async () => owner(0.7, true),
      speak: async function* (_text, _signal, voice) {
        voices.push(voice);
        yield new Int16Array(3_200);
      },
    });
    t.room.message(`freya/r1/${DEV}/voice/stepup`, Buffer.from('{"act":"camera"}'));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    expect(
      t.published
        .filter((p) => p.topic.endsWith("/voice/stepup/done"))
        .map((p) => (JSON.parse(String(p.payload)) as { how: string }).how),
    ).toEqual(["button"]);
    t.room.message(
      `freya/r1/${DEV}/voice/prefs/member-1`,
      Buffer.from('{"persona":"research","voice":"alba"}'),
    );
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(t.brainCalls.at(-1)!.tessaya.persona).toBe("research");
  });
});

describe("her name alone, then nothing (16:36:43, 13 Nov: the red light and silence)", () => {
  const wakeThenSilence = async (
    acknowledge: "voice" | "tone" | "off",
    speaks: boolean,
    bench = false,
  ) => {
    const spoken: string[] = [];
    const logs: string[] = [];
    const waits: Array<() => void> = [];
    const t = setup(
      {
        speak: async function* (text) {
          spoken.push(text);
          yield new Int16Array(3_200);
        },
        random: () => 0.9,
        log: (l) => logs.push(l),
        // Her 1.2 s wait runs on his real time: it ends only when the test says so.
        sleep: async (ms) => {
          if (ms === 1_200) await new Promise<void>((r) => waits.push(r));
          else t.advance(ms);
        },
      },
      { ...ROOM_CONFIG, acknowledge },
    );
    if (bench) t.room.message(`freya/r1/${DEV}/cmd/voice/no-reply`, Buffer.from('{"on":true}'));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    const cueFrames = t.published.filter((p) => p.topic.endsWith("/voice/down")).length;
    if (speaks) await t.feed(true, 20);
    t.advance(1_200);
    for (const go of waits) go();
    await t.feed(false, 30);
    const after = t.published.filter((p) => p.topic.endsWith("/voice/down")).length - cueFrames;
    return { t, spoken, after, logs };
  };

  it("says a short line of hers and looks attentive when nothing follows, but not when he goes straight on", async () => {
    const quiet = await wakeThenSilence("voice", false);
    expect(
      quiet.logs.some((l) => /her name alone: "(Yes\?|Mm\?|I'm here\.|Go on\.|Hey\.)"/.test(l)),
    ).toBe(true);
    expect(quiet.t.published.some((p) => p.payload === '{"mood":"attentive"}')).toBe(true);
    const talking = await wakeThenSilence("voice", true);
    expect(talking.t.brainCalls).toHaveLength(1);
    expect(talking.logs.some((l) => l.includes("her name alone"))).toBe(false);
  });

  it("never repeats her last line across S2 presses, and is often only a look when pressed again soon", async () => {
    const said: string[] = [];
    const t = setup(
      {
        random: () => 0.95,
        log: (l) => {
          const m = /her name alone: (?:"(.*)"|her look)/.exec(l);
          if (m !== null) said.push(m[1] ?? "(look)");
        },
      },
      { ...ROOM_CONFIG, acknowledge: "voice" },
    );
    t.room.message(`freya/r1/${DEV}/cmd/voice/earcons`, Buffer.from('{"on":false}'));
    for (let i = 0; i < 3; i += 1) {
      t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
      await t.feed(false, 30);
      t.room.message(`freya/r1/${DEV}/cmd/voice/stop`, new Uint8Array());
      t.advance(10 * 60_000);
    }
    expect(said).toHaveLength(3);
    for (let i = 1; i < said.length; i += 1) expect(said[i]).not.toBe(said[i - 1]);
  });

  it("is a sound with 'tone' and nothing with 'off'", async () => {
    const off = await wakeThenSilence("off", false);
    expect(off.after).toBe(0);
    const tone = await wakeThenSilence("tone", false);
    expect(tone.after).toBeGreaterThan(0);
  });

  it("is silent on a bench sweep (cmd/voice/no-reply): no line, no tone, no listening sound", async () => {
    for (const acknowledge of ["voice", "tone"] as const) {
      const bench = await wakeThenSilence(acknowledge, false, true);
      expect(bench.t.published.filter((p) => p.topic.endsWith("/voice/down"))).toEqual([]);
      expect(bench.logs.filter((l) => l.includes('her name alone: "'))).toEqual([]);
    }
  });
});
