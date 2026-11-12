// @effect-diagnostics globalTimers:off
import { describe, expect, it, vi } from "vite-plus/test";

import { queueSpeech } from "@t3tools/baton-shared/companionPacing";

import { pocketPlan } from "./pocketVoice.ts";
import {
  createSpeaker,
  pcmLevel,
  speakableText,
  wavFormat,
  type VoiceChoice,
  type VoicePlayer,
} from "./voiceSpeaker.ts";

const SYSTEM: VoiceChoice = { kind: "system" };

const player: VoicePlayer = { play: async () => true, stop: () => {}, dispose: () => {} };
const drain = async (stream: AsyncIterable<Buffer>) => {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
};

describe("speakableText", () => {
  it("drops markup a voice would read out", () => {
    expect(speakableText("**Done**, see `file`\n# next")).toBe("Done , see file next");
  });
});

describe("createSpeaker on the OS voice", () => {
  it("plays in order and reports active once for the whole run", async () => {
    const said: string[] = [];
    const active: boolean[] = [];
    const speaker = createSpeaker({
      os: { name: "os", speak: async (text) => void said.push(text) },
      voice: () => SYSTEM,
      player,
      onActive: (value) => active.push(value),
    });
    await Promise.all([speaker.speak("one."), speaker.speak("two.")]);
    expect(said).toEqual(["one.", "two."]);
    expect(active).toEqual([true, false]);
  });

  it("drops what is queued on cancel, and cuts off the System voice mid-sentence", async () => {
    const said: string[] = [];
    let cut = 0;
    const speaker = createSpeaker({
      os: {
        name: "os",
        speak: async (text) => void said.push(text),
        cancel: () => void (cut += 1),
      },
      voice: () => SYSTEM,
      player,
    });
    const run = Promise.all([speaker.speak("one."), speaker.speak("two.")]);
    speaker.cancel();
    await run;
    expect(said).toEqual([]);
    expect(cut).toBe(1);
  });

  it("generates one sentence at a time, ahead of playback", async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => (release = resolve));
    const speaker = createSpeaker({
      os: { name: "os", speak: async () => {} },
      voice: () => ({
        kind: "synth",
        synth: (text) => ({
          stream: (async function* () {
            order.push(`start ${text}`);
            if (text === "one.") await held;
            yield Buffer.alloc(2);
            order.push(`end ${text}`);
          })(),
          cancel: () => {},
        }),
      }),
      player: {
        ...player,
        play: async (wav) => {
          await drain(wav);
          return true;
        },
      },
    });
    const run = Promise.all([speaker.speak("one."), speaker.speak("two.")]);
    await vi.waitFor(() => expect(order).toEqual(["start one."]));
    release!();
    await run;
    expect(order).toEqual(["start one.", "end one.", "start two.", "end two."]);
  });

  it("starts a longer sentence that follows another with a soft breath, and leaves the first alone", async () => {
    const wav = () => {
      const out = Buffer.alloc(44 + 200);
      out.write("RIFF", 0, "latin1");
      out.write("WAVEfmt ", 8, "latin1");
      out.writeUInt32LE(24_000, 24);
      out.write("data", 36, "latin1");
      for (let i = 44; i < out.length; i += 2) out.writeInt16LE(1000, i);
      return out;
    };
    const played: number[] = [];
    const speaker = createSpeaker({
      os: { name: "os", speak: async () => {} },
      voice: () => ({
        kind: "synth",
        voice: "eve",
        synth: () => ({
          stream: (async function* () {
            yield wav();
          })(),
          cancel: () => {},
        }),
      }),
      player: {
        ...player,
        play: async (stream) => {
          played.push(await drain(stream));
          return true;
        },
      },
    });
    await Promise.all([
      speaker.speak("The build passed."),
      speaker.speak("And the deploy finishes at half past two this afternoon."),
    ]);
    // The first plays as synthesised; the second gets a 170 ms breath and a 70 ms gap before its words.
    expect(played[0]).toBe(44 + 200);
    expect(played[1]).toBe(44 + (4_080 + 1_680) * 2 + 200);
  });

  it("gives the voice the respelled line, and keeps the written one for the screen and her echo", async () => {
    const synthesised: string[] = [];
    const noted: string[] = [];
    const speaker = createSpeaker({
      os: { name: "os", speak: async () => {} },
      voice: () => ({
        kind: "synth",
        synth: (text) => ({
          stream: (async function* () {
            synthesised.push(text);
            yield Buffer.alloc(2);
          })(),
          cancel: () => {},
        }),
      }),
      player: {
        ...player,
        play: async (wav) => {
          await drain(wav);
          return true;
        },
      },
      onText: (text) => void noted.push(text),
      respellings: () => ({ Kiro: "Keer-oh" }),
    });
    await speaker.speak("Freya asked Kiro about the PR.");
    expect(synthesised).toEqual(["Fray-uh asked Keer-oh about the P R."]);
    // Both, so her own voice is known whether the recogniser writes "PR" or "P R".
    expect(noted).toEqual([
      "Freya asked Kiro about the PR.",
      "Fray-uh asked Keer-oh about the P R.",
    ]);
    // A stage direction is a sound between the words, never words; an interjection is respelled for the voice.
    synthesised.length = 0;
    noted.length = 0;
    await speaker.speak("Ugh. *sighs* Fine.");
    expect(synthesised).toEqual(["Uhhgh.", "Fine."]);
    expect(noted).toEqual(["Ugh. Fine."]);
  });

  it("shows a line of only emoji, and says nothing without calling it unsaid", async () => {
    const noted: string[] = [];
    let unsaid = 0;
    let played = 0;
    const speaker = createSpeaker({
      os: { name: "os", speak: async () => {} },
      voice: () => ({
        kind: "synth",
        synth: () => ({ stream: (async function* () {})(), cancel: () => {} }),
      }),
      player: { ...player, play: async () => ((played += 1), true) },
      onText: (text) => void noted.push(text),
      onUnavailable: () => void (unsaid += 1),
    });
    await speaker.speak("🎉");
    expect(noted).toEqual(["🎉"]);
    expect(unsaid).toBe(0);
    expect(played).toBe(0);
  });

  it("says nothing at all in Written only", async () => {
    const said: string[] = [];
    const active: boolean[] = [];
    const speaker = createSpeaker({
      os: { name: "os", speak: async (text) => void said.push(text) },
      voice: () => SYSTEM,
      player,
      silent: () => true,
      onActive: (value) => active.push(value),
    });
    await speaker.speak("one.");
    expect(said).toEqual([]);
    expect(active).toEqual([]);
  });

  it("plays a voice's bytes, and when it fails says nothing aloud, only that it could not", async () => {
    const said: string[] = [];
    const played: number[] = [];
    const unavailable: string[] = [];
    let fail = false;
    const speaker = createSpeaker({
      os: { name: "os", speak: async (text) => void said.push(text) },
      voice: () => ({
        kind: "synth",
        synth: () => ({
          stream: (async function* () {
            if (fail) throw new Error("no");
            yield Buffer.alloc(3);
          })(),
          cancel: () => {},
        }),
      }),
      player: {
        ...player,
        play: async (wav) => {
          const bytes = await drain(wav);
          played.push(bytes);
          return true;
        },
      },
      onUnavailable: (text) => unavailable.push(text),
    });
    await speaker.speak("one.");
    fail = true;
    await speaker.speak("two.");
    expect(played).toEqual([3]);
    expect(said).toEqual([]);
    expect(unavailable).toEqual(["two."]);
  });
});

describe("the voice is still loading", () => {
  const synthOf = (): VoiceChoice => ({
    kind: "synth",
    synth: () => ({
      stream: (async function* () {
        yield Buffer.alloc(4);
      })(),
      cancel: () => {},
    }),
  });
  const playing = (played: number[]): VoicePlayer => ({
    ...player,
    play: async (wav) => {
      played.push(await drain(wav));
      return true;
    },
  });

  it("holds the line until Tessaya's own voice is ready, then speaks it in that voice, never the OS one", async () => {
    const said: string[] = [];
    const played: number[] = [];
    const waiting: boolean[] = [];
    let ready = false;
    let release!: (ok: boolean) => void;
    const loaded = new Promise<boolean>((resolve) => (release = resolve));
    const speaker = createSpeaker({
      os: { name: "os", speak: async (text) => void said.push(text) },
      voice: () => (ready ? synthOf() : { kind: "wait", ready: loaded }),
      player: playing(played),
      onWaiting: (w) => waiting.push(w),
    });
    const line = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(waiting).toEqual([true]));
    expect(played).toEqual([]);
    expect(said).toEqual([]);
    ready = true;
    release(true);
    await line;
    expect(played).toEqual([4]);
    expect(said).toEqual([]);
    expect(waiting).toEqual([true, false]);
  });

  it("says nothing aloud when it cannot load for good, and reports the line as text only", async () => {
    const said: string[] = [];
    const played: number[] = [];
    const unavailable: string[] = [];
    const speaker = createSpeaker({
      os: { name: "os", speak: async (text) => void said.push(text) },
      voice: () => ({ kind: "wait", ready: Promise.resolve(false) }),
      player: playing(played),
      onUnavailable: (text) => unavailable.push(text),
    });
    await speaker.speak("Hello there.");
    expect(said).toEqual([]);
    expect(played).toEqual([]);
    expect(unavailable).toEqual(["Hello there."]);
  });

  it("uses the OS voice only when he chose System voice", async () => {
    const said: string[] = [];
    const speaker = createSpeaker({
      os: { name: "os", speak: async (text) => void said.push(text) },
      voice: () => SYSTEM,
      player,
    });
    await speaker.speak("Hello there.");
    expect(said).toEqual(["Hello there."]);
  });

  it("plays a sample in a voice he is trying, even in Written only, and the OS voice never", async () => {
    const said: string[] = [];
    const played: number[] = [];
    const speaker = createSpeaker({
      os: { name: "os", speak: async (text) => void said.push(text) },
      voice: () => SYSTEM,
      player: playing(played),
      silent: () => true,
    });
    await speaker.sample(synthOf(), "Hello, this is how I sound.");
    expect(played).toEqual([4]);
    expect(said).toEqual([]);
  });
});

describe("reading a streamed WAV", () => {
  it("finds the rate and the samples in the header", () => {
    const head = Buffer.alloc(48);
    head.writeUInt32LE(24_000, 24);
    head.write("data", 36, "latin1");
    expect(wavFormat(head)).toEqual({ rate: 24_000, start: 44 });
    expect(wavFormat(Buffer.from("nope"))).toBeNull();
  });

  it("measures how loud a run of samples is", () => {
    expect(pcmLevel(Buffer.alloc(64))).toBe(0);
    const loud = Buffer.from(new Int16Array(32).fill(16_000).buffer);
    expect(pcmLevel(loud)).toBeGreaterThan(0.9);
  });
});

describe("pocketPlan", () => {
  it("fills every local path and asks only for what a voice needs", () => {
    const plan = pocketPlan("D:\\state\\pocket", "vera");
    expect(plan.config).not.toContain("{dir}");
    expect(plan.config).toContain("D:/state/pocket");
    expect(plan.files.map((f) => f.file)).toContain("vera.safetensors");
    expect(plan.files.map((f) => f.file)).not.toContain("anna.safetensors");
    expect(pocketPlan("x", "quick").files.map((f) => f.file)).toContain("tokenizer.model");
  });
});

describe("silencing a reply of several sentences", () => {
  it("stops the ones still waiting", async () => {
    const said: string[] = [];
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => (release = resolve));
    const speaker = createSpeaker({
      os: {
        name: "os",
        speak: async (text) => {
          said.push(text);
          await held;
        },
      },
      voice: () => SYSTEM,
      player,
    });
    const queue = queueSpeech(speaker.speak);
    queue.add("one.");
    queue.add("two.");
    queue.add("three.");
    await vi.waitFor(() => expect(said).toEqual(["one."]));
    speaker.cancel();
    release!();
    await queue.finished();
    expect(said).toEqual(["one."]);
  });
});
