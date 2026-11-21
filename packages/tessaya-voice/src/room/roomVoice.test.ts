import { describe, expect, it, vi } from "vite-plus/test";

import type { EnrolCard } from "@t3tools/tessaya-contracts";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { firstClause } from "@t3tools/tessaya-shared/narration";

import type { SpeakerIdentity } from "../speaker.ts";
import { speakerPath, UNVERIFIED } from "../speaker.ts";
import { PILL_SOUNDS, renderSound } from "../cueSounds.ts";
import { speechLike } from "../echoSim.ts";
import { speechLevel, toBytes } from "./audio.ts";
import { createWakeStream, type WakeScorer } from "./wakeStream.ts";
import {
  brainNotReached,
  brainOrLocal,
  busOfBrain,
  fromBrainHub,
  relayToBrain,
  loopBuses,
  createRoomVoice,
  ROOM_CONFIG,
  routeForDevice,
  servedRoster,
  splitSentences,
  testModeAsked,
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
      by: () => ({ host: "asr:1" }),
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
      lifted: false,
      recogniser: { host: "asr:1" },
    });
    // Stamped, so an old line is never read as a new turn.
    expect(m.at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(m.firstSoundMs).not.toBeNull();
    expect(t.brainCalls[0]!.messages).toEqual([
      { role: "user", content: "turn on the study light" },
    ]);
    expect(t.brainCalls[0]!.tessaya.speaker?.kind).toBe("unverified");
    const down = t.published.filter((p) => p.topic === `freya/r1/${DEV}/voice/down`);
    // Her listening sound on S2, then two sentences of 0.2 s each at 16 kHz, in 60 ms frames.
    const cue = Math.ceil((renderSound(PILL_SOUNDS.wake, 16_000).length * 2) / 1_920);
    expect(down.length).toBe(cue + 2 * Math.ceil(6_400 / 1_920));
    expect(t.brainCalls[0]!.tessaya.playback).toBeUndefined();

    // Our test run playing into the room: answered, and the turn says so, so her server learns nothing from it.
    const played = setup({ playback: () => "osp-run1" });
    played.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await played.feed(false, 5);
    await played.feed(true, 20);
    await played.feed(false, 8);
    await played.metrics;
    expect(played.brainCalls[0]!.tessaya.playback).toBe("osp-run1");
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
      value: "Tessel (room mic)",
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

  it("judges a headset turn as the headset's (upformat flags bit4), and teaches it from a session verified on her mic", async () => {
    const owner: SpeakerIdentity = {
      ...UNVERIFIED(0),
      kind: "owner",
      personId: "owner",
      confidence: 0.8,
      verified: true,
    };
    const inputs: Array<string | undefined> = [];
    const learnt: Array<string> = [];
    const t = setup({
      speaker: async (_pcm, input) => (inputs.push(input), owner),
      learnInput: (input, personId) => learnt.push(`${input}:${personId}`),
    });
    const framed = (loud: boolean, flags: number) => {
      const bytes = new Uint8Array(16 + 1_920);
      new DataView(bytes.buffer).setUint16(12, flags, true);
      bytes.set(frame(loud), 16);
      return bytes;
    };
    const feed = async (loud: boolean, n: number, flags: number) => {
      for (let i = 0; i < n; i += 1) {
        t.room.message(`freya/r1/${DEV}/voice/up`, framed(loud, flags));
        t.advance(60);
        await t.room.session(DEV)!.drained();
      }
    };
    t.s2();
    await feed(true, 20, 0);
    await feed(false, 30, 0);
    expect(learnt).toEqual([]);
    t.s2();
    await feed(true, 20, 16);
    await feed(false, 30, 16);
    expect(inputs).toEqual(["mic", "headset"]);
    expect(learnt).toEqual(["headset:owner"]);
  });

  it("keeps his own verified turns for his voice models, never a guest's, and not once he turns it off", async () => {
    const run = async (kind: "owner" | "guest", capture?: boolean, privately = false) => {
      const kept: Array<{ speaker: string; samples: number }> = [];
      const t = setup({
        ...(privately
          ? {
              // Her private self answered: the brain marks the turn private.
              brain: async function* () {
                yield "[private]Just between us.";
              },
            }
          : {}),
        speaker: async () => ({
          ...UNVERIFIED(0),
          kind,
          personId: kind === "owner" ? "owner" : null,
          confidence: 0.6,
          verified: kind === "owner",
        }),
        keepTurn: (_id, pcm, meta) => kept.push({ speaker: meta.speaker, samples: pcm.length }),
      });
      if (capture !== undefined)
        t.room.message(
          `freya/r1/${DEV}/voice/capture`,
          Buffer.from(JSON.stringify({ on: capture })),
        );
      t.s2();
      await t.feed(true, 20);
      await t.feed(false, 30);
      return kept;
    };
    expect(await run("owner")).toEqual([{ speaker: "owner", samples: expect.any(Number) }]);
    expect((await run("owner"))[0]!.samples).toBeGreaterThan(0);
    expect(await run("guest")).toEqual([]);
    expect(await run("owner", false)).toEqual([]);
    // A private moment is never kept, his own verified voice included.
    expect(await run("owner", undefined, true)).toEqual([]);
  });

  it("keeps a turn it could not place only in a session where he was verified, marked unverified", async () => {
    const kept: Array<{ speaker: string; verified: boolean | undefined }> = [];
    let n = 0;
    const t = setup({
      speaker: async () =>
        n++ === 0
          ? { ...UNVERIFIED(0), kind: "owner", personId: "owner", confidence: 0.6, verified: true }
          : { ...UNVERIFIED(0), confidence: 0.05 },
      keepTurn: (_id, _pcm, meta) => kept.push({ speaker: meta.speaker, verified: meta.verified }),
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 30);
    await t.feed(true, 20);
    await t.feed(false, 30);
    expect(kept).toEqual([
      { speaker: "owner", verified: undefined },
      { speaker: "unverified", verified: false },
    ]);
  });

  it("tells her and her health when his uplink lost audio mid-turn: he was breaking up (18 Nov)", async () => {
    const t = setup();
    let seq = 0;
    const feed = async (loud: boolean, n: number) => {
      for (let i = 0; i < n; i += 1) {
        const bytes = new Uint8Array(16 + 1_920);
        new DataView(bytes.buffer).setUint32(0, seq, true);
        bytes.set(frame(loud), 16);
        t.room.message(`freya/r1/${DEV}/voice/up`, bytes);
        seq += 1;
        t.advance(60);
        await t.room.session(DEV)!.drained();
      }
    };
    t.s2();
    await feed(true, 10);
    seq += 8; // 480 ms of his voice that Wi-Fi never delivered
    await feed(true, 10);
    await feed(false, 30);
    expect(t.brainCalls[0]!.tessaya.input).toMatchObject({ verdict: "breaking up", gapMs: 480 });
    const metrics = t.published.find((p) => p.topic.endsWith("/event/voice/metrics"));
    expect(JSON.parse(String(metrics!.payload)).input.verdict).toBe("breaking up");
  });

  it("hands his headset's starved or silent mic back to her own without a word, never her own mic's quiet", async () => {
    for (const [flags, quiet, says] of [
      [16, "gap", "starved"],
      [16, "zeros", "silent"],
      [0, "gap", null],
      [0, "zeros", null],
    ] as const) {
      const t = setup();
      const framed = (flagged: number) => {
        const bytes = new Uint8Array(16 + 1_920);
        new DataView(bytes.buffer).setUint16(12, flagged, true);
        bytes.set(frame(false), 16);
        return bytes;
      };
      t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
      t.room.message(`freya/r1/${DEV}/voice/up`, framed(flags));
      // Nothing from the radio for 2.1 s, or 3.1 s of exact silence: no real room is that quiet.
      if (quiet === "gap") t.advance(2_100);
      else
        for (let i = 0; i < 52; i += 1) {
          t.advance(60);
          t.room.message(`freya/r1/${DEV}/voice/up`, framed(flags));
        }
      t.room.sweep();
      t.room.sweep();
      const poor = t.published.filter((p) => p.topic.endsWith("/event/audio/input"));
      expect(poor.map((p) => JSON.parse(String(p.payload)).why)).toEqual(
        says === null ? [] : [says],
      );
    }
  });

  it("does not answer a voice the gate keeps out", async () => {
    const guest: SpeakerIdentity = { ...UNVERIFIED(0), kind: "guest", confidence: 0.05 };
    const t = setup({ speaker: async () => guest });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 30);
    expect(t.brainCalls).toEqual([]);
    // His Voice ID switches from her brain (the desktop's "respond to others") open it for the next turn.
    t.room.message(
      `freya/r1/${DEV}/voice/gate`,
      Buffer.from(
        '{"respondToOthers":true,"offSilencesSaved":false,"savedBarge":false,"strictWhenUnavailable":false}',
      ),
    );
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 30);
    expect(t.brainCalls).toHaveLength(1);
  });

  it("keeps answering his soft voice in his own conversation, and a saved person ends it (21 Nov, 06:03-06:07 GMT+5)", async () => {
    const at = { ...UNVERIFIED(0), name: null, inherited: false, verified: false } as const;
    const his: SpeakerIdentity = {
      ...at,
      kind: "owner",
      personId: "owner",
      // Verified, but under the 0.5 the unsure-turn capture once needed: the presumption keeps his soft turns.
      confidence: 0.45,
      verified: true,
      own: { score: 0.45, ms: 1_500 },
    };
    const soft = (score: number): SpeakerIdentity => ({
      ...at,
      kind: "guest",
      confidence: score,
      own: { score, ms: 1_500 },
    });
    const sara: SpeakerIdentity = {
      ...at,
      kind: "saved",
      personId: "sara",
      name: "Sara",
      confidence: 0.6,
    };
    // His opening turn, then the live sequence: 0.32, 0.26, then an 11-word sentence far under the bar; then Sara.
    const said = [his, soft(0.32), soft(0.26), soft(0.06), sara, soft(0.2)];
    let n = 0;
    const logs: string[] = [];
    const kept: Array<string> = [];
    const t = setup({
      log: (l) => logs.push(l),
      speaker: async () => said[n++]!,
      keepTurn: (_id, _pcm, meta) => kept.push(`${meta.speaker}:${String(meta.verified)}`),
    });
    t.s2();
    for (let i = 0; i < said.length; i += 1) {
      await t.feed(true, 20);
      await t.feed(false, 30);
    }
    // Every turn of his is answered, never "a guest voice"; his soft turns stay unverified, so they grant nothing.
    expect(t.brainCalls.map((c) => c.tessaya.speaker?.kind)).toEqual([
      "owner",
      "unverified",
      "unverified",
      "unverified",
      "saved",
    ]);
    // Sara is answered as herself, and after her a low score is no longer presumed his.
    expect(logs.filter((l) => l.includes("a guest voice; not answered"))).toHaveLength(1);
    // His soft turns are kept apart as unverified (the far centroid's data); Sara's and the stranger's never are.
    expect(kept).toEqual([
      "owner:undefined",
      "unverified:false",
      "unverified:false",
      "unverified:false",
    ]);
  });

  it("presumes his next turn after he called her by name, and keeps it apart as unverified", async () => {
    const soft: SpeakerIdentity = {
      ...UNVERIFIED(0),
      kind: "guest",
      confidence: 0.26,
      own: { score: 0.26, ms: 1_500 },
    };
    const kept: Array<string> = [];
    const t = setup({
      speaker: async () => soft,
      keepTurn: (_id, _pcm, meta) => kept.push(`${meta.speaker}:${String(meta.verified)}`),
    });
    t.room.woken(DEV, "Tessaya", -20, 1);
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    // After her "I'm here", so his turn is not over her voice.
    await t.feed(false, 60);
    await t.feed(true, 20);
    await t.feed(false, 30);
    expect(t.brainCalls.map((c) => c.tessaya.speaker?.kind)).toEqual(["unverified"]);
    expect(kept).toEqual(["unverified:false"]);
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
    // Her server hears it at once, so a layer's device act stops on the interruption (VOXTA I4).
    expect(t.published.some((p) => p.topic === `freya/r1/${DEV}/event/voice/barge`)).toBe(true);
    const m = await t.metrics;
    expect(m.text).toBe("turn on the study light");
  });

  it("says a reply her brain opened with a tone in that tone of the persona's clone, never the mark itself", async () => {
    const spoken: Array<[string, string | undefined]> = [];
    const t = setup({
      brain: async function* () {
        yield "[tone:soft]";
        yield " I missed you too. ";
      },
      speak: async function* (text, _signal, voice) {
        spoken.push([text, voice]);
        yield new Int16Array(16_000);
      },
    });
    t.room.personas([
      {
        id: "executive",
        name: "Tessaya",
        voice: "http://127.0.0.1/clone.safetensors",
        cloneUrl: "/clone.safetensors",
        cloneTones: { soft: "http://127.0.0.1/clone.affect-soft.safetensors" },
      },
    ]);
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.metrics;
    await t.feed(false, 30);
    const reply = spoken.filter(([text]) => /missed/.test(text));
    expect(reply.length).toBeGreaterThan(0);
    expect(
      reply.every(([, voice]) => voice === "http://127.0.0.1/clone.affect-soft.safetensors"),
    ).toBe(true);
    expect(spoken.some(([text]) => text.includes("[tone"))).toBe(false);
  });

  it("says a line of hers from her server in the tone it carries, and the next one plainly", async () => {
    const spoken: Array<[string, string | undefined]> = [];
    const t = setup({
      speak: async function* (text, _signal, voice) {
        spoken.push([text, voice]);
        yield new Int16Array(3_200);
      },
    });
    t.room.personas([
      {
        id: "executive",
        name: "Tessaya",
        voice: "http://127.0.0.1/clone.safetensors",
        cloneUrl: "/clone.safetensors",
        cloneTones: { excited: "http://127.0.0.1/clone.affect-excited.safetensors" },
      },
    ]);
    const say = (body: object) =>
      t.room.message(`freya/r1/${DEV}/voice/say`, Buffer.from(JSON.stringify(body)));
    say({ text: "Welcome back! How was the trip?", tone: "excited" });
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.deps.sleep(500);
    say({ text: "The front door is unlocked." });
    await t.deps.sleep(500);
    expect(spoken.find(([text]) => /trip/.test(text))?.[1]).toBe(
      "http://127.0.0.1/clone.affect-excited.safetensors",
    );
    expect(spoken.find(([text]) => /unlocked/.test(text))?.[1]).toBe(
      "http://127.0.0.1/clone.safetensors",
    );
  });

  it("shows a stage direction's face and asks for its buzz on its word, once her sentence is playing (G7)", async () => {
    const fired: Array<{ args: readonly unknown[]; framesBefore: number }> = [];
    const t = setup({
      brain: async function* () {
        yield "That's great *laughs* you did it.";
      },
      speak: async function* () {
        yield new Int16Array(16_000);
      },
      effect: (...args) =>
        fired.push({
          args,
          framesBefore: t.published.filter((p) => p.topic.endsWith("/voice/down")).length,
        }),
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.metrics;
    await t.feed(false, 30);
    expect(fired.map((f) => f.args)).toEqual([[DEV, "laugh", "laughing"]]);
    expect(fired[0]!.framesBefore).toBeGreaterThan(0);
    expect(
      t.published.some(
        (p) => p.topic.endsWith("/cmd/eye/set") && String(p.payload) === '{"mood":"laughing"}',
      ),
    ).toBe(true);
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
      ["butler", true],
      ["butler", undefined],
      ["butler", undefined],
      ["executive", true],
    ]);
    expect(new Set(voices)).toEqual(new Set(["peter_yearsley", "eve"]));
    expect(voices.at(-1)).toBe("eve");
    expect(
      t.published.filter((p) => p.topic.endsWith("/cmd/eye/persona")).map((p) => String(p.payload)),
      // A fresh loop shows the lead's first; no acknowledgement here, so the sweep asks for Alfred's look again.
    ).toEqual([
      '{"name":"tessaya"}',
      '{"name":"alfred"}',
      '{"name":"alfred"}',
      '{"name":"tessaya"}',
    ]);
  });

  it("hears a bare name that answers her own question as his answer, not a switch (18 Nov, 00:22:59)", async () => {
    const asked: Array<[string, true | undefined]> = [];
    const t = setup({
      recognise: said(["Tessaya, whose eyes are these?", "Alfred.", "Alfred, what broke?"]),
      brain: async function* (input) {
        asked.push([input.tessaya.persona, input.tessaya.switched]);
        yield asked.length === 1 ? "Whose do you see, Alfred's or mine?" : "Noted.";
      },
    });
    await turn(t);
    await turn(t);
    await turn(t);
    // Her question named Alfred, so "Alfred." answers it; calling him with a request still switches.
    expect(asked).toEqual([
      ["executive", undefined],
      ["executive", undefined],
      ["butler", true],
    ]);
  });

  it("says each group member's words in its own voice, its eyes queued with them, then returns to its own (M-021)", async () => {
    const spoken: Array<[string, string | undefined]> = [];
    const t = setup({
      recognise: said(["Tessaya, what do you two think?"]),
      // The last speaker's sentence has no full stop: it must still go out whole in the first voice.
      brain: async function* () {
        yield "[as:butler]Rest first";
        yield "[as:executive]Agreed. Sleep.";
      },
      speak: async function* (text, _signal, voice) {
        spoken.push([text, voice]);
        yield new Int16Array(3_200);
      },
    });
    await turn(t);
    expect(spoken).toEqual([
      ["Rest first", "peter_yearsley"],
      ["Agreed.", "eve"],
      ["Sleep.", "eve"],
    ]);
    await t.deps.sleep(5_000);
    expect(
      t.published.filter((p) => p.topic.endsWith("/cmd/eye/persona")).map((p) => String(p.payload)),
    ).toEqual([
      '{"name":"tessaya"}',
      '{"name":"alfred"}',
      '{"name":"tessaya"}',
      '{"name":"tessaya"}',
    ]);
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

  // Firmware 0.3.137 sends the mic while a Bluetooth reply plays: her echo then arrives after its buffer and the sink.
  it.each([0, 1_300])(
    "drops her echo by how it sounds, partly cancelled and with her persona's name in it (09:00 sweep, 13 Nov; Bluetooth buffer %i ms)",
    async (btMs) => {
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
      if (btMs > 0)
        t.room.message(
          `freya/r1/${DEV}/state/voice`,
          Buffer.from(JSON.stringify({ ev: "out", out: "bt", bt_latency_ms: btMs })),
        );
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
        sounds = Math.max(
          f.at + ROOM_CONFIG.downDelayMs + (btMs > 0 ? btMs + 150 : 0),
          sounds + 60,
        );
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
      expect(
        t.published
          .filter((p) => p.topic.endsWith("/cmd/eye/persona"))
          .map((p) => String(p.payload)),
      ).toEqual(['{"name":"tessaya"}']);
    },
  );

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
    const overHer = async (
      heard: ReadonlyArray<string>,
      over: "echo" | "his",
      extra: Partial<RoomDeps> = {},
    ) => {
      const logs: string[] = [];
      const t = setup(
        {
          ...extra,
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
      expect(r.logs.some((l) => l.includes('he said stop ("stop"); she stopped'))).toBe(true);
      // A breath, then his next request, with no name: she is listening.
      await r.t.feed(false, 15);
      await r.t.feed(true, 20);
      await r.t.feed(false, 40);
      expect(r.t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
        "Turn the office fan on.",
        "What time is it?",
      ]);
    });

    it("is dismissed over her voice, and with nobody enrolled anything else he says over her is answered", async () => {
      const sent = await overHer(["Turn the office fan on.", "Dismissed."], "his");
      expect(sent.flushed).toBe(true);
      await sent.t.feed(false, 20);
      expect(sent.t.published.some((p) => p.payload === '{"mood":"sleepy"}')).toBe(true);
      // 14 Nov, 18:57: "Yes?", then his request over her tail got a glance.
      const other = await overHer(["Turn the office fan on.", "Turn the lamp on as well."], "his");
      expect(other.flushed).toBe(true);
      expect(other.t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
        "Turn the office fan on.",
        "Turn the lamp on as well.",
      ]);
      expect(other.logs.some((l) => l.includes("not answered"))).toBe(false);
    });

    it("never puts a turn over her voice on his path without its own Voice ID verdict (18 Nov, 00:16:04)", async () => {
      // His session verified on the first turn; Voice ID then has nothing for the words over her (it failed).
      let n = 0;
      const r = await overHer(["Turn the office fan on.", "Turn the lamp on as well."], "his", {
        speaker: async () => {
          n += 1;
          if (n > 1) throw new Error("no embedding");
          return {
            kind: "owner",
            personId: "owner",
            name: null,
            confidence: 0.7,
            verified: true,
            inherited: false,
            at: 0,
            own: { score: 0.7, ms: 1_200 },
          };
        },
      });
      expect(r.t.brainCalls.map((c) => c.tessaya.speaker?.kind)).toEqual(["owner", "unverified"]);
      expect(r.t.brainCalls[1]!.tessaya.tainted).toBe(true);
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
    const t = setup(
      { recognise: said(["Turn on the office fan.", "Is it on now?", "And the lamp?"]) },
      { ...QUIET, acknowledge: "tone" },
    );
    t.s2();
    await turn(t);
    await t.deps.sleep(ROOM_CONFIG.followMs + 5_000);
    await turn(t);
    expect(t.brainCalls).toHaveLength(1);
    const sent = t.published.filter((p) => p.topic.endsWith("/voice/down")).length;
    t.room.message(`freya/r1/${DEV}/state/online`, Buffer.from("1"));
    // No acknowledgement for a heartbeat: the R1 refuses audio outside a session (14 Nov, 20:05).
    await t.deps.sleep(2_000);
    expect(t.published.filter((p) => p.topic.endsWith("/voice/down")).length).toBe(sent);
    await turn(t);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Turn on the office fan.",
      "And the lamp?",
    ]);
  });

  it("rests gently when sent away, without asking her brain", async () => {
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
    // No brain (10:36:40, 13 Nov: 6.5 s and a full sentence), but a brief "okay" before the soft close (15 Nov).
    expect(spoken).toEqual(["Okay."]);
    expect(t.published.some((p) => p.payload === '{"mood":"sleepy"}')).toBe(true);
  });

  it("plays her closing tone whole when the dismissal is heard early and then again (14 Nov, 19:40)", async () => {
    const logs: string[] = [];
    const t = setup({
      log: (l) => logs.push(l),
      recognise: () => {
        let partial: (text: string) => void = () => undefined;
        return {
          feed: () => undefined,
          finish: async () => {
            // "Dismissed" is heard early, and the final words land a few milliseconds later while her tone plays.
            partial("Dismissed.");
            await Promise.resolve();
            t.advance(8);
            return "Dismissed.";
          },
          cancel: () => undefined,
          onPartial: (l) => void (partial = l),
        };
      },
    });
    t.s2();
    await turn(t);
    expect(logs.filter((l) => l.includes("she rests"))).toHaveLength(1);
    expect(
      t.published.some(
        (p) => p.topic.endsWith("/voice/ctl") && String(p.payload).includes("flush"),
      ),
    ).toBe(false);
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
    expect(t.brainCalls[0]?.tessaya.persona).toBe("butler");
    // The R1 only streams wake audio between sessions: once its mic has been quiet a while, the session here is stale.
    await t.deps.sleep(3_000);
    t.room.message(`freya/r1/${DEV}/voice/wake`, new Uint8Array(1920));
    expect(frames).toEqual([DEV, DEV]);
    expect(t.room.session(DEV)).toBeUndefined();
    // Muted, nothing is heard: no wake, and no voice for ambient presence either (M-123).
    t.room.message(`freya/r1/${DEV}/state/mic`, Buffer.from('{"muted":true,"src":"button"}'));
    t.room.message(`freya/r1/${DEV}/voice/wake`, new Uint8Array(1920));
    expect(frames).toEqual([DEV, DEV]);
  });

  it("reopens a session the R1 lost to a reboot, with one short line, and leaves it open for him", async () => {
    // 18 Nov, 00:21: her watchdog rebooted her mid-answer; the loop held the dead session 47 s, then she was silent.
    const spoken: string[] = [];
    const logs: string[] = [];
    const t = setup({
      speak: async function* (text) {
        spoken.push(text);
        yield new Int16Array(320);
      },
      log: (l) => logs.push(l),
    });
    const starts = () =>
      t.published.filter((p) => p.topic === `freya/r1/${DEV}/cmd/voice/start`).length;
    t.room.message(
      `freya/r1/${DEV}/event/wake/boot`,
      Buffer.from('{"reason":1,"fw_ver":"smp-0.3.156","kept":1,"why":"wd-cmd: a command"}'),
    );
    expect(starts()).toBe(0);
    expect(logs).toContain(
      `[${DEV}] booted: fw_ver "smp-0.3.156" reason 1 why "wd-cmd: a command" uptime_s null kept 1`,
    );
    // He was talking to Alfred when she rebooted (18 Nov, 05:51): the reopened session is still his, and remembers.
    t.room.woken(DEV, "Alfred");
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    await t.feed(false, 60);
    spoken.length = 0;
    const before = starts();
    t.room.message(`freya/r1/${DEV}/event/wake/boot`, Buffer.from('{"reason":1}'));
    expect(starts()).toBe(before + 1);
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.room.session(DEV)!.drained();
    expect(spoken).toEqual(["Sorry, I just restarted. Go on."]);
    expect(t.room.session(DEV)).toBeDefined();
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls.at(-1)?.tessaya.persona).toBe("butler");
    expect(t.brainCalls.at(-1)?.messages.slice(0, 2)).toEqual([
      { role: "user", content: "turn on the study light" },
      { role: "assistant", content: "Done. The study light is on." },
    ]);
  });

  it("sends her live volume with each turn, so the brain answers it without a tool round (18 Nov, 23:07)", async () => {
    const t = setup();
    t.room.message(`freya/r1/${DEV}/state/volume`, Buffer.from('{"pct":40}'));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls.at(-1)?.tessaya.volume).toBe(40);
  });

  it("wears a persona her server puts on this Tessel mid-session, once her reply has ended", async () => {
    const t = setup();
    t.room.message(`freya/r1/${DEV}/voice/cast`, Buffer.from('{"persona":"executive"}'));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls.at(-1)?.tessaya.persona).toBe("executive");
    // "Got it, Alfred has it from here." and then Tessaya still answered (18 Nov, 05:52): the hand-off is worn.
    t.room.message(`freya/r1/${DEV}/voice/cast`, Buffer.from('{"persona":"butler"}'));
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls.at(-1)?.tessaya.persona).toBe("butler");
  });

  it("drives only a Tessel on its bus, and that bus is always its brain's hub", () => {
    // [tail, online on this loop's bus] → what the loop does with it.
    const cases: Array<[string, boolean, string]> = [
      ["voice/intent/eye", true, "room"],
      ["voice/intent/eye", false, "drop"],
      ["voice/stepup", false, "drop"],
      ["cmd/voice/start", false, "drop"],
      ["voice/up", false, "room"],
      ["cmd/voice/no-reply", false, "room"],
    ];
    for (const [tail, here, want] of cases)
      expect([tail, here, routeForDevice(tail, here)]).toEqual([tail, here, want]);
    // 18 Nov: a loop on one server's hub called another's brain, whose acts went to a hub she was not on.
    expect(busOfBrain("https://brain.example/api/devices/r1/v1/chat/completions")).toBe(
      "wss://brain.example/api/tessel/mqtt",
    );
    expect(busOfBrain("http://127.0.0.1:3773/api/devices/tessel/v1/chat/completions")).toBe(
      "ws://127.0.0.1:3773/api/tessel/mqtt",
    );
  });

  it("turns run on the brain while she stays on her own hub, with its acts and acks bridged (18 Nov: 1.3 s → 3.0 s)", async () => {
    const brain = "http://brain.example:3773/api/devices/r1/v1/chat/completions";
    // Unset, one bus as before (slice 1); set, her own hub, plus the brain's hub for its acts.
    expect(loopBuses(brain, undefined)).toEqual({
      hub: "ws://brain.example:3773/api/tessel/mqtt",
      brain: null,
    });
    expect(loopBuses(brain, "ws://127.0.0.1:3773/api/tessel/mqtt")).toEqual({
      hub: "ws://127.0.0.1:3773/api/tessel/mqtt",
      brain: "ws://brain.example:3773/api/tessel/mqtt",
    });
    // From the brain's hub: its turn's acts for a Tessel here; a device command goes by the peer route, with its ack.
    const cases: Array<[string, boolean, boolean]> = [
      ["voice/intent/eye", true, true],
      ["voice/intent/rest", true, true],
      ["voice/stepup", true, true],
      ["voice/say", true, true],
      ["voice/intent/eye", false, false],
      ["cmd/voice/volume", true, false],
      ["voice/up", true, false],
    ];
    for (const [tail, here, want] of cases)
      expect([tail, here, fromBrainHub(tail, here)]).toEqual([tail, here, want]);
    // 23:07-23:25: the brain saw her offline ("Tumble's link to the server is down"), her volume 4 h old, and no mic
    // readings ("I haven't got any recent sound readings"): what she reports on her hub reaches the brain's too.
    const relayed: Array<[string, ReturnType<typeof relayToBrain>]> = [
      ["state/online", "retain"],
      ["state/volume", "retain"],
      ["event/voice/metrics", "once"],
      ["event/audio/input", "once"],
      ["voice/up", null],
      ["voice/wake", null],
      ["cmd/voice/start", null],
    ];
    for (const [tail, want] of relayed) expect([tail, relayToBrain(tail)]).toEqual([tail, want]);
    // The brain unreachable: the turn goes to her own hub's server, never silence; once a word is out, no second turn.
    const lines: string[] = [];
    const down = (): AsyncIterable<string> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(brainNotReached("connect ECONNREFUSED")),
      }),
    });
    const local = async function* (): AsyncGenerator<string> {
      yield "Nine ";
      yield "oh nine.";
    };
    const turn = { deviceId: "r1", messages: [], tessaya: {} as never };
    const said: string[] = [];
    for await (const w of brainOrLocal(down, local, (l) => lines.push(l))(
      turn,
      new AbortController().signal,
    ))
      said.push(w);
    expect(said.join("")).toBe("Nine oh nine.");
    expect(lines.join("\n")).toMatch(
      /brain unreachable .*ECONNREFUSED.*; this hub's server answers/,
    );
    const halfway = async function* (): AsyncGenerator<string> {
      yield "Nine ";
      throw new Error("reset");
    };
    const again: string[] = [];
    await expect(
      (async () => {
        for await (const w of brainOrLocal(
          halfway,
          local,
          () => undefined,
        )(turn, new AbortController().signal))
          again.push(w);
      })(),
    ).rejects.toThrow("reset");
    expect(again).toEqual(["Nine "]);
    // Its stream broke before a word: it took the turn and may be acting, so no second server runs it.
    let localTried = false;
    const broke = (): AsyncIterable<string> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("terminated")) }),
    });
    const tryLocal = async function* (): AsyncGenerator<string> {
      localTried = true;
      yield "twice";
    };
    await expect(
      (async () => {
        for await (const _ of brainOrLocal(
          broke,
          tryLocal,
          () => undefined,
        )(turn, new AbortController().signal));
      })(),
    ).rejects.toThrow("terminated");
    expect(localTried).toBe(false);
    // A slow brain is waited for, never doubled by the local server: it may already be acting.
    let release = () => undefined as void;
    const slow = async function* (): AsyncGenerator<string> {
      await new Promise<void>((r) => (release = r));
      yield "Done.";
    };
    let localRan = false;
    const never = async function* (): AsyncGenerator<string> {
      localRan = true;
      yield "twice";
    };
    const waited = (async () => {
      const out: string[] = [];
      for await (const w of brainOrLocal(
        slow,
        never,
        () => undefined,
      )(turn, new AbortController().signal))
        out.push(w);
      return out;
    })();
    await Promise.resolve();
    release();
    expect(await waited).toEqual(["Done."]);
    expect(localRan).toBe(false);
  });

  it("opens on the persona the Cast puts on this Tessel, and a wake word for another never re-homes it", async () => {
    const t = setup({
      wake: { frame: () => undefined, end: () => undefined },
      recognise: () => ({
        feed: () => undefined,
        finish: async () => "what broke?",
        cancel: () => undefined,
      }),
    });
    t.room.message(
      `freya/r1/${DEV}/voice/cast`,
      Buffer.from('{"persona":"companion","follows":null}'),
    );
    // A (perhaps false) wake for Alfred: that session is his.
    t.room.message(`freya/r1/${DEV}/voice/wake`, new Uint8Array(1920));
    t.room.woken(DEV, "Alfred");
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls.at(-1)?.tessaya.persona).toBe("butler");
    // He talked to Alfred, so the next session by the button goes on with Alfred while that conversation is held
    // (20 Nov 13:27: a false lift reopened on the lead), and only after it lapses is the body Freya's again.
    const next = async (wait: number) => {
      await t.deps.sleep(wait);
      t.room.message(`freya/r1/${DEV}/voice/wake`, new Uint8Array(1920));
      expect(t.room.session(DEV)).toBeUndefined();
      t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
      await t.feed(true, 20);
      await t.feed(false, 60);
      return t.brainCalls.at(-1)?.tessaya.persona;
    };
    expect(await next(3_000)).toBe("butler");
    expect(await next(11 * 60_000)).toBe("companion");
  });

  it("drops the R1's mic tail after her stop, and a later session keeps the persona he was talking to (20 Nov 13:27)", async () => {
    const t = setup();
    const looks = () =>
      t.published.filter((p) => p.topic.endsWith("/cmd/eye/persona")).map((p) => String(p.payload));
    t.room.woken(DEV, "companion");
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.feed(true, 20);
    await t.feed(false, 60);
    expect(t.brainCalls.at(-1)?.tessaya.persona).toBe("companion");
    // "Okay, thanks, that will be all": her stop, then 6 s more of the R1's mic.
    t.room.message(`freya/r1/${DEV}/cmd/voice/stop`, new Uint8Array());
    t.room.message(`freya/r1/${DEV}/voice/up`, new Uint8Array(1920));
    expect(t.room.session(DEV)).toBeUndefined();
    // Audio after the tail opens a session (an R1 that sends no start), on Freya still, her eyes unchanged.
    const before = looks().length;
    t.advance(11_000);
    t.room.message(`freya/r1/${DEV}/voice/up`, new Uint8Array(1920));
    expect(t.room.session(DEV)).toBeDefined();
    expect(looks().slice(before)).toEqual([]);
  });

  it.each([
    { who: "unverified", speaker: UNVERIFIED(0), spoken: true },
    // His own verified voice is spoken on this path; the TTS bench clips are a guest and are not (16 Nov, 01:37).
    {
      who: "his verified",
      speaker: { ...UNVERIFIED(0), kind: "owner", personId: "owner", verified: true },
      spoken: true,
    },
    {
      who: "a guest",
      speaker: { ...UNVERIFIED(0), kind: "guest", confidence: 0.05 },
      spoken: false,
    },
  ] satisfies ReadonlyArray<{ who: string; speaker: SpeakerIdentity; spoken: boolean }>)(
    'answers the request said in the same breath as her name, with no "I\'m here" first, in $who voice',
    async ({ speaker, spoken }) => {
      const logs: string[] = [];
      const t = setup({ log: (l) => logs.push(l), speaker: async () => speaker });
      const segment = new Int16Array(3 * 16_000).fill(2_000);
      // The request is in her name's own segment, so it is as loud as the name was.
      t.room.woken(
        DEV,
        "Tessaya",
        speechLevel(segment),
        1,
        segment,
        Promise.resolve({ text: "what time is it?", startedAt: 0, endedAt: 900 }),
      );
      t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
      if (!spoken) {
        // Judged before her brain starts: a guest's request is never asked.
        await vi.waitFor(() => expect(logs.some((l) => l.includes("a guest voice"))).toBe(true));
        expect(t.brainCalls).toEqual([]);
        return;
      }
      const m = await t.metrics;
      // Her brain may start closed before the verdict; the call she answers from carries it.
      expect(new Set(t.brainCalls.map((c) => c.messages.at(-1)!.content))).toEqual(
        new Set(["what time is it?"]),
      );
      expect(speakerPath(t.brainCalls.at(-1)!.tessaya.speaker)).toBe(speakerPath(speaker));
      expect(m).toMatchObject({ reason: "wake", text: "what time is it?" });
      expect(m.firstSoundMs).not.toBeNull();
      expect(logs.some((l) => l.includes("her name alone"))).toBe(false);
    },
  );

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
      confirm: async () => ["Tessaya."],
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

  it("starts her sentence again on the new output when replies move mid-reply, and a quiet mic on Bluetooth moves nothing", async () => {
    let started: () => void = () => undefined;
    const speaking = new Promise<void>((r) => (started = r));
    let finish: () => void = () => undefined;
    let go: () => void = () => undefined;
    const heard = new Promise<void>((r) => (go = r));
    const t = setup(
      {
        // Her reply is still coming when the output moves.
        speak: async function* () {
          await heard;
          yield Int16Array.from({ length: 48_000 }, (_, i) => (i % 50) * 100);
          started();
          await new Promise<void>((r) => (finish = r));
        },
      },
      // Sent as it comes: nothing held back for a preroll.
      { ...QUIET, prerollMs: 0 },
    );
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    t.room.message(
      `freya/r1/${DEV}/state/voice`,
      Buffer.from(JSON.stringify({ ev: "start", out: "bt" })),
    );
    await t.feed(true, 20);
    await t.feed(false, 8);
    go();
    await speaking;
    const downs = () =>
      t.published.filter((p) => p.topic.endsWith("/voice/down")).map((p) => String(p.payload));
    const flushes = () =>
      t.published.filter(
        (p) => p.topic.endsWith("/voice/ctl") && String(p.payload).includes("flush"),
      );
    const sentence = Math.ceil((48_000 * 2) / 1_920);
    // Her first sentence is out (her listening sound went first).
    await vi.waitFor(() => expect(downs().length).toBeGreaterThanOrEqual(sentence));
    const before = downs();
    // 18 Nov, 00:38 GMT+5: moved to her speaker mid-reply, the rest played there while the headphones went on.
    t.room.message(
      `freya/r1/${DEV}/state/voice`,
      Buffer.from(JSON.stringify({ ev: "out", out: "onboard" })),
    );
    expect(flushes()).toHaveLength(1);
    // The whole sentence again from its start, on the new output, and nothing else.
    await vi.waitFor(() => expect(downs().length).toBe(before.length + sentence));
    expect(downs().slice(before.length)).toEqual(before.slice(-sentence));
    // Back on Bluetooth once she is quiet: nothing to start again. A quiet mic there is the shared radio, not a stall.
    t.advance(3_100);
    t.room.message(
      `freya/r1/${DEV}/state/voice`,
      Buffer.from(JSON.stringify({ ev: "out", out: "bt" })),
    );
    t.room.sweep();
    t.room.sweep();
    expect(t.published.filter((p) => p.topic.endsWith("/event/audio/stall"))).toEqual([]);
    expect(flushes()).toHaveLength(1);
    finish();
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
      'persona {"name":"tessaya"}',
      'set {"mood":"attentive"}',
      'gesture {"name":"nodSmall"}',
      'set {"mood":"neutral"}',
    ]);
  });

  it("sends the eyes changes only: his pauses mid-sentence do not resend attentive or a nod each time (18 Nov, 00:15:55)", async () => {
    // His words for each piece arrive once he has gone on, so the pieces are one turn.
    const pieces = ["Anything odd", "that you might be noticing", "in your work?"];
    const words: Array<(text: string) => void> = [];
    const t = setup({
      recognise: () => {
        let done: (text: string) => void = () => undefined;
        const text = new Promise<string>((r) => (done = r));
        words.push(done);
        return { feed: () => undefined, finish: () => text, cancel: () => undefined };
      },
    });
    t.s2();
    for (let i = 0; i < pieces.length; i += 1) {
      await t.feed(true, 8);
      await t.feed(false, 5);
      if (i > 0) words[i - 1]!(pieces[i - 1]!);
    }
    words[2]!(pieces[2]!);
    await t.feed(false, 40);
    const face = t.published
      .filter((p) => p.topic.includes("/cmd/eye/"))
      .map((p) => `${p.topic.split("/cmd/eye/")[1]} ${String(p.payload)}`);
    expect(face).toEqual([
      'persona {"name":"tessaya"}',
      'set {"mood":"attentive"}',
      'gesture {"name":"nodSmall"}',
      'set {"mood":"neutral"}',
    ]);
    // Once the Tessel shows another face (her server's, or its own), the same one is sent again.
    const sets = () => t.published.filter((p) => p.topic.endsWith("/cmd/eye/set")).length;
    await t.feed(true, 8);
    await t.feed(false, 5);
    const before = sets();
    await t.feed(true, 8);
    await t.feed(false, 5);
    expect(sets()).toBe(before);
    t.room.message(`freya/r1/${DEV}/state/eye/mood`, Buffer.from('{"mood":"sleepy","src":"idle"}'));
    await t.feed(true, 8);
    expect(sets()).toBe(before + 1);
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
      ["What's next?", "butler"],
    ]);
    t.room.message(`freya/r1/${DEV}/voice/persona`, Buffer.from('{"name":"freya"}'));
    expect(spoken.at(-1)).toEqual(["Fray-uh here.", "azelma"]);
  });

  it("takes her server's roster for the next session: his custom persona answers in its voice, with the generic eyes", async () => {
    const spoken: Array<[string, string | undefined]> = [];
    const t = setup({
      speak: async function* (text, _signal, voice) {
        spoken.push([text, voice]);
        yield new Int16Array(3_200);
      },
    });
    expect(servedRoster({ personas: "no" })).toBeNull();
    expect(servedRoster({ personas: [{ id: "x", name: "" }] })).toBeNull();
    const roster = servedRoster({
      personas: [
        {
          id: "nova",
          name: "Nova",
          wake: null,
          voice: "alba",
          lead: false,
          cloneUrl: "/tessaya/voice/embedding/k/c.safetensors",
          cloneTones: { soft: "/tessaya/voice/embedding/k/c.affect-soft.safetensors", bad: 3 },
        },
        { id: "bad", voice: "eve" },
        {
          id: "executive",
          name: "Tessaya",
          wake: "Tessaya",
          voice: "eve",
          lead: true,
          eyes: "tessaya",
        },
      ],
    });
    expect(roster).toEqual([
      { id: "executive", name: "Tessaya", voice: "eve", eyes: "tessaya" },
      // Her clone's path rides along; main.ts speaks it only where its Pocket can fetch it.
      {
        id: "nova",
        name: "Nova",
        voice: "alba",
        cloneUrl: "/tessaya/voice/embedding/k/c.safetensors",
        cloneTones: { soft: "/tessaya/voice/embedding/k/c.affect-soft.safetensors" },
      },
    ]);
    t.room.personas(roster!);
    t.room.message(`freya/r1/${DEV}/voice/persona`, Buffer.from('{"name":"nova"}'));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    expect(spoken).toEqual([["Nova here.", "alba"]]);
    expect(
      t.published.filter((p) => p.topic.endsWith("/cmd/eye/persona")).map((p) => String(p.payload)),
    ).toEqual(['{"name":"generic"}']);
    // Freya renamed Maya: her trained wake word still brings her, by the persona id it belongs to.
    const renamed = setup();
    renamed.room.personas(
      servedRoster({
        personas: [
          { id: "executive", name: "Tessaya", wake: "Tessaya", voice: "eve", lead: true },
          {
            id: "companion",
            name: "Maya",
            wake: "Maya",
            voice: "azelma",
            lead: false,
            eyes: "freya",
          },
        ],
      })!,
    );
    renamed.room.woken(DEV, "companion");
    renamed.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    expect(
      renamed.published
        .filter((p) => p.topic.endsWith("/cmd/eye/persona"))
        .map((p) => String(p.payload)),
    ).toEqual(['{"name":"freya"}']);
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

  it("shows the mood of her own line on the eyes, and leaves them for a plain one", async () => {
    const t = setup();
    t.s2();
    const eyes = () =>
      t.published
        .filter((p) => p.topic.endsWith("/cmd/eye/set"))
        .map((p) => JSON.parse(String(p.payload)).mood as string);
    const before = eyes().length;
    t.room.message(`freya/r1/${DEV}/voice/say`, Buffer.from(JSON.stringify({ text: "Updated." })));
    expect(eyes().length).toBe(before);
    t.room.message(
      `freya/r1/${DEV}/voice/say`,
      Buffer.from(JSON.stringify({ text: "Back, and up to date.", mood: "proud", gesture: "hop" })),
    );
    expect(eyes().slice(before)).toEqual(["proud"]);
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

  it("sends nothing when the R1 ends its own session, which then refuses audio (14 Nov, 20:20), and lets it go", async () => {
    const t = setup();
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.deps.sleep(2_000);
    const before = t.published.filter((p) => p.topic.endsWith("voice/down")).length;
    t.room.message(`freya/r1/${DEV}/state/voice`, Buffer.from(JSON.stringify({ ev: "stop" })));
    await t.deps.sleep(2_000);
    const after = t.published.filter((p) => p.topic.endsWith("voice/down")).length;
    expect(after - before).toBe(0);
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

  it.each([
    // The recogniser hears the whole sentence from all its pieces' audio.
    [
      "And how much would you say you have acquainted yourself about how I speak and do things?",
      "And how much would you say you have acquainted yourself about how I speak and do things?",
    ],
    // A second pass that fails or hears far less keeps every word of the pieces.
    ["", "And how much would you say you have acquainted yourself about Or Speak."],
    ["Speak.", "And how much would you say you have acquainted yourself about Or Speak."],
  ])(
    "recognises a sentence he paused in twice again as one (15 Nov, 09:10: second pass %j)",
    async (again, asked) => {
      const holds: Array<() => void> = [];
      const previews: number[] = [];
      const t = setup({
        recognise: heardInTurn([
          "And how much would you say you have acquainted yourself about",
          "Or",
          "Speak.",
        ]),
        // An early start's preview of one piece hears nothing; only the whole sentence is read again.
        preview: async (pcm) => (previews.push(pcm.length), pcm.length > 2 * 20 * 960 ? again : ""),
        smartTurn: async () => 0.9,
        sleep: async (ms) => {
          if (ms === ROOM_CONFIG.joinMs) await new Promise<void>((r) => holds.push(r));
          else t.advance(ms);
        },
      });
      t.s2();
      for (let i = 0; i < 3; i += 1) {
        await t.feed(true, 20);
        await t.feed(false, 8);
      }
      for (const release of holds) release();
      await t.feed(false, 20);
      expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([asked]);
      // All three pieces' audio in one pass.
      expect(previews.at(-1)).toBeGreaterThan(3 * 20 * 960);
    },
  );

  it("scores Voice ID on the whole joined sentence, not its last piece (15 Nov)", async () => {
    const holds: Array<() => void> = [];
    const scored: number[] = [];
    const t = setup({
      recognise: heardInTurn(["Is it possible to", "have you turn it on for just one minute."]),
      // One piece is too short to tell; the whole sentence is his.
      speaker: async (pcm) => {
        scored.push(pcm.length);
        return pcm.length > 30 * 960
          ? {
              kind: "owner",
              personId: "member-1",
              name: "Rab",
              confidence: 0.8,
              verified: true,
              inherited: false,
              at: 0,
            }
          : UNVERIFIED(0);
      },
      sleep: async (ms) => {
        if (ms === ROOM_CONFIG.joinMs) await new Promise<void>((r) => holds.push(r));
        else t.advance(ms);
      },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.feed(true, 20);
    await t.feed(false, 8);
    for (const release of holds) release();
    await t.feed(false, 20);
    expect(scored.at(-1)).toBeGreaterThan(2 * 20 * 960);
    expect(t.brainCalls[0]!.tessaya.speaker?.kind).toBe("owner");
  });

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
      input: expect.objectContaining({ verdict: expect.any(String) }),
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

  // Her reply as speech-like sound, and the R1's 0.3.92 uplink: each frame says how much of her it has played.
  const her = Int16Array.from(speechLike(6, 3, 190), (v) => v * 32768);
  const run = async (
    mode: "open" | "keyword",
    him: boolean,
    likeness = 0.6,
    enrolled = true,
    line = "It's seven forty here, and the sun is up.",
    verifiedFirst = false,
    // Her echo through the mic during the "him" phase (the new case's coupling), heard as these words.
    echoOver: string | null = null,
  ) => {
    const logs: string[] = [];
    const t = setup({
      log: (l) => logs.push(l),
      ...(verifiedFirst
        ? {
            speaker: async () => ({
              ...UNVERIFIED(0),
              kind: "owner" as const,
              personId: "owner",
              confidence: 0.8,
              verified: true,
            }),
          }
        : {}),
      member: async () => likeness,
      members: () => enrolled,
      // Her echo alone is recognised as her own words so far (her first clause), which with her sound make it hers.
      recognise: heardInTurn([
        "What time is it?",
        echoOver ?? (him ? "No, I meant in London." : "It's seven forty here."),
      ]),
      vad: () => ({
        score: async (w) =>
          Math.sqrt(w.reduce((a, v) => a + v * v, 0) / w.length) > 300 ? 0.9 : 0.05,
      }),
      brain: async function* (input, signal) {
        t.brainCalls.push(input);
        yield line;
        if (input.messages.at(-1)!.content === "What time is it?") await abortedBy(signal);
      },
      speak: async function* (_text, signal) {
        // Streamed as the voice makes it, a frame at a time.
        for (let at = 0; at < her.length; at += 960) yield her.subarray(at, at + 960);
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
    let coupling = 0.05;
    const up = async (voice: (i: number) => number, n: number) => {
      for (let k = 0; k < n; k += 1) {
        const rx = sent();
        const pcm = new Int16Array(960);
        for (let i = 0; i < 960; i += 1) {
          // What is left of her after the R1's own echo cancelling (-26 dB), at its 123 ms latency, plus him.
          const e = played / 2 + i - 1972;
          pcm[i] =
            (e >= 0 && e < rx / 2 ? her[e % her.length]! * coupling : 0) + voice(seq * 960 + i);
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
    if (echoOver !== null) {
      coupling = 0.9;
      await up(quiet, 20);
      coupling = 0.05;
    } else if (him) await up(loud, 20);
    await up(quiet, 20);
    const flushed = t.published.some(
      (p) => p.topic.endsWith("/voice/ctl") && String(p.payload).includes("flush"),
    );
    return {
      flushed,
      asked: t.brainCalls.map((c) => c.messages.at(-1)!.content),
      // Her reply reached the R1 exactly once: nothing dropped, nothing sent twice.
      sentOnce: sent() === her.length * 2,
      paused: logs.some((l) => l.endsWith("a voice over hers; she paused")),
      stopped: logs.filter((l) => l.endsWith("talked over; she stopped")).length,
    };
  };

  it("open talk-over: a household voice over her stops her and is answered; another voice or her echo never does", async () => {
    // Stopped once: the hold goes with her, so its voice check never stops her again (09:28:22-24, 15 Nov).
    expect(await run("open", true)).toMatchObject({
      flushed: true,
      asked: ["What time is it?", "No, I meant in London."],
      stopped: 1,
    });
    // Her own voice coming back is not him.
    expect((await run("open", false)).flushed).toBe(false);
    // Someone not in the household, or her echo in a case (18 Nov, 03:23 GMT+5): her feed pauses without a flush,
    // which would drop what the R1 holds and skip her speech, then goes on from the next sample; not answered.
    // In a session he opened (S2 here) she stays paused until that voice stops or 2 s of it is surely not his (20 Nov
    // 17:15), so a long pause goes on from her sentence's start.
    expect(await run("open", true, 0.05)).toMatchObject({
      flushed: false,
      asked: ["What time is it?"],
      paused: true,
      stopped: 0,
    });
    // His own session (his voice verified on the turn before): mixed with hers in the new case his words over her
    // scored -0.09 to 0.20 (19 Nov, 05:01-05:02) and were dropped. Now they are answered, and nothing is sent twice.
    expect(
      (await run("open", true, 0.05, true, "It's seven forty here, and the sun is up.", true))
        .asked,
    ).toEqual(["What time is it?", "No, I meant in London."]);
    // Keyword mode never pauses her for a voice, but his whole turn over her is still his: answered
    // (14 Nov, 21:39), while another voice's is not.
    expect((await run("keyword", true)).asked).toEqual([
      "What time is it?",
      "No, I meant in London.",
    ]);
    expect((await run("keyword", true, 0.05)).asked).toEqual(["What time is it?"]);
    // Over her question, his reply mixed with her voice scores like a stranger (17 Nov, 19:22: 0.30): with no second
    // of it after her voice, it is answered.
    expect(
      (await run("keyword", true, 0.05, true, "It's seven forty. Want the weather too? ")).asked,
    ).toEqual(["What time is it?", "No, I meant in London."]);
    // Nobody enrolled (14 Nov, 18:57): what the person who woke her says over her is answered, in either mode.
    for (const mode of ["open", "keyword"] as const)
      expect(await run(mode, true, 0.6, false)).toMatchObject({
        flushed: true,
        asked: ["What time is it?", "No, I meant in London."],
      });
  });

  it("never cuts her off for her own reply coming back loud in his session (20 Nov, 03:19 GMT+5)", async () => {
    // His session, but the words over her are her own reply coming back loud and misheard ("Not much, Donald.",
    // likeness 0.77, Voice ID -0.09; 20 Nov, 03:19 GMT+5): never taken as his, she is not cut off.
    expect(
      await run(
        "open",
        false,
        -0.09,
        true,
        "It's seven forty here, and the sun is up.",
        true,
        "Not much, Donald.",
      ),
    ).toMatchObject({ flushed: false, asked: ["What time is it?"] });
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

  it("tells her voice which sentences continue a reply, so they breathe as on the desktop", async () => {
    const continuing: Array<boolean | undefined> = [];
    const t = setup({
      recognise: heardInTurn(["Say two things."]),
      brain: async function* () {
        yield "First thing. Second thing.";
      },
      speak: async function* (_text, _signal, _voice, more) {
        continuing.push(more);
        yield new Int16Array(3_200);
      },
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(continuing).toEqual([false, true]);
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

  it("logs every eye command and its acknowledgement, asks again, and says when one never came", async () => {
    const logs: string[] = [];
    const t = setup({ log: (l) => logs.push(l) });
    t.room.message(`freya/r1/${DEV}/cmd/eye/persona`, Buffer.from('{"name":"alfred"}'));
    t.room.message(`freya/r1/${DEV}/cmd/eye/set`, Buffer.from('{"mood":"thinking"}'));
    t.advance(120);
    t.room.message(`freya/r1/${DEV}/state/eye/persona`, Buffer.from('{"name":"alfred"}'));
    t.room.message(`freya/r1/${DEV}/cmd/eye/persona`, Buffer.from('{"name":"freya"}'));
    for (let i = 0; i < 4; i++) {
      t.advance(4_000);
      t.room.sweep();
    }
    expect(logs).toEqual([
      `[${DEV}] eye seen cmd/eye/persona {"name":"alfred"}`,
      `[${DEV}] eye seen cmd/eye/set {"mood":"thinking"}`,
      `[${DEV}] eye ack persona {"name":"alfred"} after 120 ms`,
      `[${DEV}] eye seen cmd/eye/persona {"name":"freya"}`,
      `[${DEV}] eye persona freya: no acknowledgement in 3 s, try 2`,
      `[${DEV}] eye persona freya: no acknowledgement in 3 s, try 3`,
      `[${DEV}] eye persona freya: FAILED, no acknowledgement after 3 tries`,
    ]);
    // The loop's own: an R1 button switches to Alfred.
    t.room.message(`freya/r1/${DEV}/voice/persona`, Buffer.from('{"name":"alfred"}'));
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    expect(logs).toContain(`[${DEV}] eye sent cmd/eye/persona {"name":"alfred"}`);
  });

  it("puts the eyes of whoever answers on as each session opens (17 Nov, 23:29: Tessaya answered behind Alfred's eyes)", () => {
    const t = setup();
    const looks = () =>
      t.published.filter((p) => p.topic.endsWith("/cmd/eye/persona")).map((p) => String(p.payload));
    const wake = (persona: string) => {
      t.room.woken(DEV, persona);
      t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
      t.room.message(`freya/r1/${DEV}/event/session/end`, new Uint8Array());
    };
    // A loop just restarted does not know what the eyes show, so it says.
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    t.room.message(`freya/r1/${DEV}/event/session/end`, new Uint8Array());
    wake("butler");
    // Alfred again: his eyes are already on, so nothing flickers.
    wake("butler");
    // Her name on the next wake: the session opens on the lead, and her eyes come back with it.
    wake("executive");
    expect(looks()).toEqual(['{"name":"tessaya"}', '{"name":"alfred"}', '{"name":"tessaya"}']);
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

  it.each([
    ["Dismiss.", "dismissed; she rests"],
    ["Stop.", 'he said stop ("stop") with nothing to stop; she rests'],
  ])(
    "rests at once on '%s' with nothing of hers playing, and ends the session (10:37:43, 14:11 14 Nov)",
    async (said, line) => {
      const logs: string[] = [];
      const t = setup({
        recognise: heard([said, "So do you know? But yeah, and he checked."]),
        log: (l) => logs.push(l),
      });
      t.s2();
      await t.feed(true, 20);
      await t.feed(false, 8);
      await t.feed(true, 20);
      await t.feed(false, 40);
      expect(t.brainCalls).toEqual([]);
      expect(logs.some((l) => l.includes(line))).toBe(true);
      expect(t.published.filter((p) => p.topic === `freya/r1/${DEV}/cmd/voice/stop`)).toHaveLength(
        1,
      );
    },
  );

  it("answers his one question once though he paused five times in it, his words in as he goes on (18 Nov, 00:15:55)", async () => {
    // His pieces as he said them, each piece's words arriving once his next piece has begun (the recogniser took 0.4-2 s).
    const pieces: Array<[string, number]> = [
      ["Anything odd", 12],
      ["that you might be noticing in your work?", 40],
      ["Or", 5],
      ["how you are", 15],
      ["feeling and behaving and any tools that might not be working as", 55],
      ["they should.", 10],
    ];
    const words: Array<(text: string) => void> = [];
    const t = setup({
      recognise: () => {
        let done: (text: string) => void = () => undefined;
        const text = new Promise<string>((r) => (done = r));
        words.push(done);
        return { feed: () => undefined, finish: () => text, cancel: () => undefined };
      },
    });
    t.s2();
    for (const [i, [, frames]] of pieces.entries()) {
      await t.feed(true, frames);
      await t.feed(false, 8);
      if (i > 0) words[i - 1]!(pieces[i - 1]![0]);
    }
    words.at(-1)!(pieces.at(-1)![0]);
    await t.feed(false, 60);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      pieces.map(([w]) => w).join(" "),
    ]);
  });

  it("joins words whose whole sentence was still being recognised when he went on (18 Nov, 00:16:01)", async () => {
    const words: Array<(text: string) => void> = [];
    // The second recognition (a whole sentence, or an early start's) answers only when let go: none of it here.
    const slow: Array<() => void> = [];
    const letGo = () => slow.splice(0).forEach((f) => f());
    const t = setup({
      recognise: () => {
        let done: (text: string) => void = () => undefined;
        const text = new Promise<string>((r) => (done = r));
        words.push(done);
        return { feed: () => undefined, finish: () => text, cancel: () => undefined };
      },
      preview: () => new Promise<string>((r) => slow.push(() => r(""))),
    });
    t.s2();
    await t.feed(true, 5);
    await t.feed(false, 8);
    await t.feed(true, 3);
    words[0]!("Or");
    await t.feed(true, 12);
    await t.feed(false, 8);
    // "Or how you are" is in, and its whole sentence still being recognised when he goes on.
    words[1]!("how you are");
    await t.feed(true, 3);
    letGo();
    await t.feed(true, 50);
    await t.feed(false, 8);
    words[2]!("feeling and behaving and any tools that might not be working as they should.");
    await t.feed(false, 2);
    letGo();
    await t.feed(false, 60);
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      "Or how you are feeling and behaving and any tools that might not be working as they should.",
    ]);
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
    // A face-library mood shows by its own name; a word outside the one vocabulary never reaches the eyes.
    for (const mood of ["concerned", "worried", "attentive"])
      t.room.message(
        `freya/r1/${DEV}/voice/intent/eye`,
        Buffer.from(JSON.stringify({ vessel: "r1", mood, holdMs: 1000 })),
      );
    await t.feed(true, 20);
    expect(
      t.published
        .filter((p) => p.topic.endsWith("/cmd/eye/set"))
        .map((p) => JSON.parse(String(p.payload)).mood as string),
    ).toEqual(["thinking", "concerned"]);
  });

  it("wears her rest mood with its prop between turns, and plain neutral once it clears", () => {
    const t = setup();
    t.s2();
    const rest = (body: object) =>
      t.room.message(`freya/r1/${DEV}/voice/intent/rest`, Buffer.from(JSON.stringify(body)));
    rest({ mood: "focused", accessory: "reading" });
    rest({ mood: "giddy" });
    expect(
      t.published
        .filter((p) => p.topic.endsWith("/cmd/eye/set"))
        .map((p) => JSON.parse(String(p.payload))),
    ).toEqual([
      { mood: "focused", accessory: "reading" },
      { mood: "neutral", accessory: "auto" },
    ]);
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

describe("Voice ID never fails open to him (Director, 16 Nov)", () => {
  const him: SpeakerIdentity = {
    ...UNVERIFIED(0),
    kind: "owner",
    personId: "owner",
    confidence: 0.7,
    verified: true,
  };
  const guest: SpeakerIdentity = { ...UNVERIFIED(0), kind: "guest", confidence: 0.1 };
  /** A turn whose verdict and her brain's first words land when the test says. */
  const pendingTurn = async (over: Partial<RoomDeps> = {}) => {
    let tell: (who: SpeakerIdentity) => void = () => undefined;
    let firstWords: () => void = () => undefined;
    const words = new Promise<void>((r) => (firstWords = r));
    const t = setup({
      speaker: () => new Promise<SpeakerIdentity>((r) => (tell = r)),
      brain: async function* (input) {
        t.brainCalls.push(input);
        await words;
        yield "Done. ";
        yield "The light is on.";
      },
      ...over,
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    return { ...t, tell: (who: SpeakerIdentity) => tell(who), firstWords: () => firstWords() };
  };
  const spoken = (t: { published: Array<{ topic: string }> }) =>
    t.published.filter((p) => p.topic.endsWith("/voice/down")).length;

  it("starts her brain closed to his path, and asks again as his when his verdict beats her first words", async () => {
    const t = await pendingTurn();
    expect(t.brainCalls).toHaveLength(1);
    expect(t.brainCalls[0]!.tessaya.speaker).toEqual(
      expect.objectContaining({ kind: "unverified" }),
    );
    expect(t.brainCalls[0]!.tessaya.speaker.voiceIdOff).toBeUndefined();
    t.tell(him);
    await t.feed(false, 2);
    t.firstWords();
    const m = await t.metrics;
    expect(t.brainCalls).toHaveLength(2);
    expect(t.brainCalls[1]!.tessaya.speaker).toMatchObject({ kind: "owner", verified: true });
    expect(m).toMatchObject({ voiceIdLate: true, reasked: true });
    // Voice ID's own figures come from its late verdict, not the closed start's.
    expect(m).toMatchObject({ speaker: "unverified", verdict: "owner", speakerScore: 0.7 });
    expect(m.firstSoundMs).not.toBeNull();
  });

  it("answers as a guest when the verdict is still out at her first words, and stops if it keeps the voice out", async () => {
    const t = await pendingTurn();
    t.firstWords();
    await t.feed(false, 6);
    // Still unjudged after `sideMs`: her answer from the closed start is heard (a guest's reach, nothing of his).
    expect(spoken(t)).toBeGreaterThan(0);
    expect(t.brainCalls).toHaveLength(1);
    const heard = spoken(t);
    t.tell(guest);
    const m = await t.metrics;
    expect(m.reasked).toBeUndefined();
    expect(spoken(t)).toBeLessThanOrEqual(heard + 1);
  });

  it("in his session waits for this turn's verdict, and starts on the session rule without it (20 Nov, 06:03)", async () => {
    const run = async (verdictInTime: boolean) => {
      let calls = 0;
      let tell: (who: SpeakerIdentity) => void = () => undefined;
      let release: () => void = () => undefined;
      let clock = 0;
      const t = setup({
        recognise: () => ({
          feed: () => undefined,
          finish: async () => (calls === 1 ? "Turn on the water pump." : "For fifteen minutes."),
          cancel: () => undefined,
        }),
        // His first turn is verified; the second's verdict is still out when her brain would start.
        speaker: () => (calls++ === 0 ? Promise.resolve(him) : new Promise((r) => (tell = r))),
        now: () => clock,
        sleep: (ms) =>
          ms === 1_200
            ? new Promise<void>((r) => (release = r))
            : ((clock += ms), Promise.resolve()),
      });
      t.s2();
      await t.feed(true, 20);
      await t.feed(false, 40);
      await t.feed(true, 20);
      await t.feed(false, 8);
      if (verdictInTime) tell(him);
      release();
      await t.feed(false, 30);
      return t.brainCalls.map((c) => c.tessaya.speaker);
    };
    // Its verdict lands 400 ms in, inside the wait: her brain starts as his, once.
    const inTime = await run(true);
    expect(inTime).toHaveLength(2);
    expect(inTime[1]).toMatchObject({ kind: "owner", verified: true });
    // None by the bound: his held session decides (his path, nothing learned), never a guest's start.
    const late = await run(false);
    expect(late).toHaveLength(2);
    expect(late[1]).toMatchObject({ kind: "owner", inherited: true, verified: false });
  });

  it("gives his late verdict the closed answer once her words have begun, never his path", async () => {
    const t = await pendingTurn();
    t.firstWords();
    await t.feed(false, 6);
    t.tell(him);
    const m = await t.metrics;
    expect(t.brainCalls).toHaveLength(1);
    expect(t.brainCalls[0]!.tessaya.speaker.kind).toBe("unverified");
    expect(m).toMatchObject({ voiceIdLate: true, speaker: "unverified" });
  });

  it("uses the verdict begun on her name's segment for the request said with it, embedding it once", async () => {
    let embeds = 0;
    const t = setup({
      speaker: async () => {
        embeds += 1;
        return him;
      },
    });
    const segment = new Int16Array(3 * 16_000).fill(2_000);
    t.room.woken(
      DEV,
      "Tessaya",
      speechLevel(segment),
      1,
      segment,
      Promise.resolve({ text: "what time is it?", startedAt: 0, endedAt: 900 }),
      Promise.resolve(him),
    );
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await t.metrics;
    expect(embeds).toBe(0);
    expect(t.brainCalls.at(-1)!.tessaya.speaker).toMatchObject({ kind: "owner" });
  });
});

describe("test mode (Director, 16 Nov)", () => {
  const owner: SpeakerIdentity = {
    ...UNVERIFIED(0),
    kind: "owner",
    personId: "owner",
    confidence: 0.7,
    verified: true,
  };
  const clone: SpeakerIdentity = { ...owner, test: true };
  const lines = (said: string) => () => ({
    feed: () => undefined,
    finish: async () => said,
    cancel: () => undefined,
  });
  const turn = async (said: string, who: SpeakerIdentity, ready: boolean | "no host" = true) => {
    const logs: string[] = [];
    const t = setup({
      log: (l) => logs.push(l),
      recognise: lines(said),
      speaker: async () => who,
      ...(ready === "no host" ? {} : { testMode: { ready: () => ready } }),
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.feed(false, 4);
    return { ...t, logs };
  };
  const led = (t: { published: Array<{ topic: string; payload: Uint8Array | string }> }) =>
    t.published
      .filter((p) => p.topic.endsWith("/cmd/led/set"))
      .map((p) => JSON.parse(String(p.payload)));

  it.each([
    ["Test mode on", "on"],
    ["Tessaya, turn on test mode.", "on"],
    ["test mode off please", "off"],
    ["what does a test mean", null],
  ] as const)("hears %j as %s", (text, want) => expect(testModeAsked(text)).toBe(want));

  it("turns on only for his verified voice, lights the Tessel and tells the app, and the clone cannot turn it on", async () => {
    const his = await turn("Test mode on", owner);
    expect(his.room.testUntil()).toBeGreaterThan(0);
    expect(led(his).at(-1)).toMatchObject({ r: 255, g: 110, b: 0 });
    expect(
      his.published.some(
        (p) =>
          p.topic.endsWith("/state/item/voice.test_mode") && String(p.payload).includes("on until"),
      ),
    ).toBe(true);
    expect(his.brainCalls).toHaveLength(0);
    for (const who of [clone, { ...owner, verified: false }, { ...UNVERIFIED(0) }]) {
      const t = await turn("Test mode on", who);
      expect(t.room.testUntil()).toBe(0);
    }
    expect((await turn("Test mode on", owner, false)).room.testUntil()).toBe(0);
  });

  it("is off by default, exists only where the host has it, and the command turns it on and off", async () => {
    const none = await turn("Test mode on", owner, "no host");
    expect(none.room.testUntil()).toBe(0);
    // Without test mode on this host the words are just words for her brain.
    expect(none.brainCalls).toHaveLength(1);
    const t = setup({ testMode: { ready: () => true } });
    expect(t.room.testUntil()).toBe(0);
    t.room.message(`freya/r1/${DEV}/voice/testmode`, Buffer.from('{"minutes":600}'));
    // Never more than 2 hours.
    expect(t.room.testUntil() - t.deps.now()).toBe(2 * 60 * 60_000);
    t.room.message(`freya/r1/${DEV}/voice/testmode`, Buffer.from('{"off":true}'));
    expect(t.room.testUntil()).toBe(0);
    expect(led(t).at(-1)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("marks every turn it lets through, and the clone may turn it off", async () => {
    const t = await turn("what time is it", clone);
    const m = await t.metrics;
    expect(m.test).toBe(true);
    expect(t.logs.some((l) => l.includes("TEST SPEAKER answered as him"))).toBe(true);
    const off = setup({
      testMode: { ready: () => true },
      recognise: lines("test mode off"),
      speaker: async () => clone,
    });
    off.room.message(`freya/r1/${DEV}/voice/testmode`, Buffer.from('{"minutes":60}'));
    off.s2();
    await off.feed(true, 20);
    await off.feed(false, 12);
    expect(off.room.testUntil()).toBe(0);
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

  it("knows who spoke while the mood reader is still busy (15 Nov: owner, then unverified, turn to turn)", async () => {
    const t = setup({
      recognise: lines(["What time is it?"]),
      speaker: async () => owner(0.7, true),
      affect: () => new Promise(() => undefined),
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(t.brainCalls[0]!.tessaya.speaker?.kind).toBe("owner");
    expect((await t.metrics).speaker).toBe("owner");
  });

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

  it("asks a step-up held mid-reply once her reply ends, never over it (15 Nov, 08:19)", async () => {
    const spoken: string[] = [];
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => (release = r));
    const logs: string[] = [];
    const t = setup({
      brain: async function* () {
        yield "Right, AM and PM from now on.";
        await hold;
        yield " It's eight nineteen a.m.";
      },
      speak: async function* (text) {
        spoken.push(text);
        yield new Int16Array(3_200);
      },
      log: (l) => logs.push(l),
    });
    t.s2();
    await t.feed(true, 20);
    await t.feed(false, 8);
    t.room.message(`freya/r1/${DEV}/voice/stepup`, Buffer.from('{"act":"pref","shared":true}'));
    release();
    const m = await t.metrics;
    expect(m.firstSoundMs).not.toBeNull();
    expect(logs.some((l) => l.includes("cut off"))).toBe(false);
    expect(spoken.slice(0, 2)).toEqual([
      "Right, AM and PM from now on.",
      "It's eight nineteen a.m.",
    ]);
    expect(spoken[2]?.startsWith("I'm not sure it's you yet.")).toBe(true);
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
      Buffer.from('{"persona":"alter-ego","voice":"alba"}'),
    );
    // Who he last talked to elsewhere counts only with personaFollows on (P5).
    t.room.message(
      `freya/r1/${DEV}/voice/current/member-1`,
      Buffer.from('{"persona":"engineering"}'),
    );
    await t.feed(true, 20);
    await t.feed(false, 40);
    expect(t.brainCalls.at(-1)!.tessaya.persona).toBe("alter-ego");
    const follows = setup(
      { recognise: lines(["What's on today?"]), speaker: async () => owner(0.7, true) },
      { ...QUIET, personaFollows: true },
    );
    follows.room.message(
      `freya/r1/${DEV}/voice/prefs/member-1`,
      Buffer.from('{"persona":"alter-ego"}'),
    );
    follows.room.message(
      `freya/r1/${DEV}/voice/current/member-1`,
      Buffer.from('{"persona":"butler"}'),
    );
    follows.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await follows.feed(true, 20);
    await follows.feed(false, 40);
    expect(follows.brainCalls.at(-1)!.tessaya.persona).toBe("butler");
    // The Cast's rule for this Tessel wins over the loop's default: follows off keeps his own default persona.
    const pinned = setup(
      { recognise: lines(["What's on today?"]), speaker: async () => owner(0.7, true) },
      { ...QUIET, personaFollows: true },
    );
    pinned.room.message(
      `freya/r1/${DEV}/voice/cast`,
      Buffer.from('{"persona":null,"follows":false}'),
    );
    pinned.room.message(
      `freya/r1/${DEV}/voice/prefs/member-1`,
      Buffer.from('{"persona":"alter-ego"}'),
    );
    pinned.room.message(
      `freya/r1/${DEV}/voice/current/member-1`,
      Buffer.from('{"persona":"butler"}'),
    );
    pinned.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    await pinned.feed(true, 20);
    await pinned.feed(false, 40);
    expect(pinned.brainCalls.at(-1)!.tessaya.persona).toBe("alter-ego");
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

  it("renders her lines ahead only around live speech: his reply never queues behind them (09:26, 15 Nov)", async () => {
    const renders: Array<{ text: string; signal: AbortSignal }> = [];
    const t = setup(
      {
        speak: async function* (text, signal) {
          renders.push({ text, signal });
          // A line ahead renders until it is cut: only her live reply finishes.
          if (!/study|Done/.test(text))
            await new Promise((go) => signal.addEventListener("abort", go));
          yield new Int16Array(3_200);
        },
        sleep: async (ms) => {
          if (ms !== 1_200) t.advance(ms);
          else await new Promise<void>(() => undefined);
        },
      },
      { ...ROOM_CONFIG, acknowledge: "voice" },
    );
    t.room.message(`freya/r1/${DEV}/cmd/voice/start`, new Uint8Array());
    const ahead = renders.slice();
    expect(ahead).toHaveLength(1);
    await t.feed(true, 20);
    await t.feed(false, 8);
    await t.metrics;
    expect(ahead[0]!.signal.aborted).toBe(true);
    // Redone once no live line renders, and left to finish.
    expect(renders.at(-1)).toMatchObject({ text: ahead[0]!.text });
    expect(renders.at(-1)!.signal.aborted).toBe(false);
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

// M-135: he thinks out loud and she only listens; the whole thought is one turn.
describe("listen mode in the room", () => {
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

  it("keeps every line through long pauses and answers once, on his end words, with all of it", async () => {
    const t = setup({
      recognise: said([
        "Just listen.",
        "I want a planner for the garden.",
        "It should know the seasons here.",
        "And remind me to water. Over to you.",
      ]),
    });
    // His own silence setting, by voice ("wait a minute and a half"): longer than any conversation window.
    t.room.message(
      `freya/r1/${DEV}/voice/prefs/${OWNER_MEMBER_ID}`,
      Buffer.from(JSON.stringify({ listenWait: "90" })),
    );
    t.s2();
    await turn(t);
    await turn(t);
    await t.deps.sleep(ROOM_CONFIG.followMs + 5_000);
    t.room.sweep();
    await turn(t);
    expect(t.brainCalls).toHaveLength(0);
    await turn(t);
    expect(t.brainCalls).toHaveLength(1);
    const asked = t.brainCalls[0]!.messages.at(-1)!.content;
    expect(asked).toMatch(/only listen/);
    expect(asked).toMatch(
      /I want a planner for the garden\. It should know the seasons here\. And remind me to water\.$/,
    );
  });

  it("ends on his silence, and a cancel drops the thought with no turn", async () => {
    const t = setup({ recognise: said(["Let me think out loud.", "A shed by the fence."]) });
    t.s2();
    await turn(t);
    await turn(t);
    await t.deps.sleep(25_000);
    t.room.session(DEV)!.tick();
    await t.metrics;
    expect(t.brainCalls.map((c) => c.messages.at(-1)!.content)).toEqual([
      expect.stringMatching(/only listen[\s\S]*A shed by the fence\.$/),
    ]);

    const c = setup({ recognise: said(["Just listen.", "An idea.", "Never mind."]) });
    c.s2();
    await turn(c);
    await turn(c);
    await turn(c);
    expect(c.brainCalls).toHaveLength(0);
  });

  it("listens after her line when her brain starts it (listen_start)", async () => {
    const t = setup({
      recognise: said([
        "Give me a minute to work this through.",
        "Solar on the roof.",
        "Over to you.",
      ]),
      brain: async function* (input) {
        t.brainCalls.push(input);
        yield t.brainCalls.length === 1 ? "Go ahead, I'm listening.[listen]" : "Solar it is.";
      },
    });
    t.s2();
    await turn(t);
    await turn(t);
    expect(t.brainCalls).toHaveLength(1);
    await turn(t);
    expect(t.brainCalls).toHaveLength(2);
    expect(t.brainCalls[1]!.messages.at(-1)!.content).toMatch(/Solar on the roof\.$/);
  });
});
