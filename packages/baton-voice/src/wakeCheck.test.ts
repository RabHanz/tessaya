/* oxlint-disable t3code/no-real-time-wait-in-tests -- Baton file predating the rule (D82) */
import { describe, expect, it } from "vite-plus/test";

import { createVoiceCore, type VoiceCoreEvent } from "./core.ts";
import { DEFAULT_TIMINGS } from "./modeMachine.ts";

const FRAME = 320;
const frames = (seconds: number) => Math.round((seconds * 16_000) / FRAME);

const rig = (
  verify:
    | ((pcm: Int16Array, word: string | null, score: number) => Promise<boolean | null>)
    | undefined,
  trustWake?: (word: string, score: number) => boolean,
  /** The echo guard hears someone over her voice. */
  nearEnd = false,
  /** Recognition waits for this: a busy recogniser. */
  recognised?: Promise<void>,
  /** He is recording with the dictation keys. */
  recording?: () => boolean,
) => {
  let fire = false;
  let firedAgo = 0;
  let speech = false;
  const heard: number[] = [];
  const loud: number[] = [];
  let said = "what time is it";
  let wall = 0;
  const events: VoiceCoreEvent[] = [];
  const core = createVoiceCore({
    waitMs: () => 0,
    clock: () => wall,
    ...(verify === undefined ? {} : { verifyWake: verify }),
    ...(recording === undefined ? {} : { recording }),
    ...(trustWake === undefined ? {} : { trustWake }),
    ...(nearEnd
      ? {
          echo: {
            reference: () => {},
            process: () => ({ ready: true, nearEnd: true, erleDb: 20 }),
            reset: () => {},
            state: () => ({ delayMs: 0, erleDb: 20, converged: true }),
          },
        }
      : {}),
    wake: {
      name: "fake",
      reset: () => {},
      process: () => {
        const score = fire ? 1 : null;
        fire = false;
        return score;
      },
      lastWord: () => "Sebastian",
      firedAgo: () => firedAgo,
    },
    vad: {
      name: "fake",
      reset: () => {},
      isSpeech: () => speech,
      probability: () => (speech ? 0.9 : 0.02),
    },
    stt: {
      name: "fake",
      transcribe: async (pcm) => {
        await recognised;
        heard.push(pcm.length);
        loud.push(pcm.filter((v) => v !== 0).length);
        return said;
      },
    },
  });
  core.subscribe((event) => events.push(event));
  const push = (seconds: number) => {
    for (let i = 0; i < frames(seconds); i += 1)
      core.pushAudio(new Int16Array(FRAME).fill(speech ? 1_000 : 0));
  };
  return {
    core,
    push,
    events,
    heard,
    loud,
    wake: (agoSeconds = 0) => {
      fire = true;
      firedAgo = Math.round(agoSeconds * 16_000);
    },
    speak: (on: boolean) => (speech = on),
    /** What recognition returns from now on. */
    hears: (text: string) => (said = text),
    /** The wall clock moves on (the lone-wake check's time limit). */
    advance: (ms: number) => (wall += ms),
  };
};

describe("the second check before a wake from sleep", () => {
  it("takes a wake the model is sure of without asking the recogniser, when she is not speaking", async () => {
    let checks = 0;
    const r = rig(
      async () => {
        checks += 1;
        return false;
      },
      () => true,
    );
    r.push(2);
    r.wake();
    r.push(0.1);
    await r.core.idle();
    expect(checks).toBe(0);
    expect(r.events.some((e) => e.type === "wake")).toBe(true);
  });

  it("sends a sure fire over her voice to the check when his voice was not heard", async () => {
    let checks = 0;
    const r = rig(
      async () => {
        checks += 1;
        return false;
      },
      () => true,
    );
    r.core.noteSpoken("The build is done");
    r.core.setSpeaking(true);
    r.push(1);
    r.wake();
    r.push(0.1);
    await new Promise((resolve) => setImmediate(resolve));
    r.push(0.2);
    expect(checks).toBe(1);
    expect(r.events.some((e) => e.type === "barge_in")).toBe(false);
  });

  it("drops a wake the recogniser did not hear, with no wake, no cue and no turn", async () => {
    const seen: Array<[number, string | null, number]> = [];
    const r = rig(async (pcm, word, score) => {
      seen.push([pcm.length, word, score]);
      return false;
    });
    r.push(2);
    r.wake();
    r.push(0.1);
    await new Promise((resolve) => setImmediate(resolve));
    r.push(1);
    await r.core.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toBe("Sebastian");
    // The model's score goes with it, for the wake_check log line.
    expect(seen[0]![2]).toBe(1);
    expect(r.events.some((e) => e.type === "wake")).toBe(false);
    expect(r.events.some((e) => e.type === "dropped" && e.reason === "wake not confirmed")).toBe(
      true,
    );
    expect(r.core.snapshot().machine.mode).toBe("sleeping");
  });

  it("wakes when the check agrees, and keeps what was said after the name while it ran", async () => {
    const r = rig(async () => true);
    r.push(2);
    r.wake();
    r.push(0.1);
    r.speak(true);
    r.push(0.6);
    await new Promise((resolve) => setImmediate(resolve));
    r.push(0.2);
    expect(r.events.some((e) => e.type === "wake")).toBe(true);
    r.speak(false);
    r.push(1.2);
    await r.core.idle();
    // The utterance reaches recognition with the speech that began during the check.
    expect(r.heard.length).toBeGreaterThan(0);
    expect(Math.max(...r.heard)).toBeGreaterThan(16_000 * 0.6);
  });

  it("keeps the whole command when the first check after launch is slower than the sentence", async () => {
    let confirm: (ok: boolean) => void = () => {};
    const r = rig(() => new Promise((resolve) => (confirm = resolve)));
    r.push(1);
    r.wake();
    r.speak(true);
    r.push(2);
    r.speak(false);
    // 0.1.56's first command: the check took 18 s, longer than the longest sentence.
    r.push(18);
    confirm(true);
    await new Promise((resolve) => setImmediate(resolve));
    r.push(1.2);
    await r.core.idle();
    expect(r.events.some((e) => e.type === "wake")).toBe(true);
    // All two seconds he spoke reach recognition, not the last three seconds of silence.
    expect(Math.max(0, ...r.loud)).toBeGreaterThanOrEqual(16_000 * 2);
  });

  it("places a wake the scorer reports late at the name, not at the moment the report arrives", async () => {
    const checked: number[] = [];
    const r = rig(async (pcm) => {
      checked.push(pcm.filter((v) => v !== 0).length);
      return true;
    });
    r.push(1);
    r.speak(true);
    r.push(2);
    r.speak(false);
    r.push(16);
    // The scorer was behind on the frames after launch: the name ended at 1.5 s, 17.5 s before this report.
    r.wake(17.5);
    r.push(0.1);
    await new Promise((resolve) => setImmediate(resolve));
    r.push(1.2);
    await r.core.idle();
    // The check heard the name, and recognition got the command said right after it.
    expect(checked[0]).toBeGreaterThan(0);
    expect(Math.max(0, ...r.loud)).toBeGreaterThanOrEqual(16_000 * 1.5);
    const wake = r.events.find((e) => e.type === "wake");
    expect(wake?.type === "wake" ? wake.lateMs : 0).toBeGreaterThanOrEqual(17_000);
  });

  it("checks a wake that fires in an open window too, so a false fire cannot flash the pill or extend it", async () => {
    let checks = 0;
    const r = rig(async () => {
      checks += 1;
      return false;
    });
    r.core.activate("wake");
    await r.core.idle();
    const wakesBefore = r.events.filter((e) => e.type === "wake").length;
    r.wake();
    r.push(0.2);
    await new Promise((resolve) => setImmediate(resolve));
    r.push(0.2);
    expect(checks).toBe(1);
    expect(r.events.filter((e) => e.type === "wake")).toHaveLength(wakesBefore);
  });

  it("never takes his wake for her voice once she and the room have gone quiet", async () => {
    const r = rig(async () => true);
    r.core.noteSpoken("Sebastian, your build is done");
    r.core.setSpeaking(true);
    r.push(1);
    r.core.setSpeaking(false);
    r.push(2);
    r.wake();
    r.push(0.2);
    await new Promise((resolve) => setImmediate(resolve));
    r.push(0.2);
    expect(r.events.some((e) => e.type === "dropped" && e.reason === "own voice")).toBe(false);
  });

  it("takes his name over her voice when she said it sentences ago, not now (0.1.75 H3)", async () => {
    const r = rig(async () => true);
    // Alfred quoted the name a reply ago; what she says now does not have it.
    r.core.noteSpoken("Sebastian told you the build is done");
    for (const line of ["It is 8:50.", "Sunday the eighth.", "In the morning.", "On GMT+5."])
      r.core.noteSpoken(line);
    r.core.setSpeaking(true);
    r.push(1);
    r.wake();
    r.push(0.2);
    await new Promise((resolve) => setImmediate(resolve));
    r.push(0.2);
    expect(r.events.some((e) => e.type === "dropped" && e.reason === "own voice")).toBe(false);
  });

  it("does not let its own voice barge in, and a fire over speech must be heard", async () => {
    const r = rig(async () => false);
    r.core.noteSpoken("Sebastian, your build is done");
    r.core.setSpeaking(true);
    r.push(1);
    r.wake();
    r.push(0.2);
    expect(r.events.some((e) => e.type === "barge_in" || e.type === "wake")).toBe(false);
    expect(r.events.some((e) => e.type === "dropped" && e.reason === "own voice")).toBe(true);
    // A sure score alone may be her own clean "Sebastian": still hers, with the score kept.
    const alone = rig(
      async () => true,
      () => true,
    );
    alone.core.noteSpoken("Sebastian, your build is done");
    alone.core.setSpeaking(true);
    alone.push(1);
    alone.wake();
    alone.push(0.2);
    expect(alone.events.find((e) => e.type === "dropped")).toMatchObject({
      reason: "own voice",
      score: 1,
    });
    // With his voice heard over hers as well, the sure fire is his.
    const sure = rig(
      async () => true,
      () => true,
      true,
    );
    sure.core.noteSpoken("Sebastian, your build is done");
    sure.core.setSpeaking(true);
    sure.push(1);
    sure.wake();
    sure.push(0.1);
    await new Promise((resolve) => setImmediate(resolve));
    sure.push(0.2);
    expect(sure.events.some((e) => e.type === "dropped" && e.reason === "own voice")).toBe(false);
    expect(sure.events.some((e) => e.type === "barge_in")).toBe(true);
    const other = rig(async () => false);
    other.core.noteSpoken("The build is done");
    other.core.setSpeaking(true);
    other.push(1);
    other.wake();
    other.push(0.1);
    await new Promise((resolve) => setImmediate(resolve));
    other.push(0.2);
    expect(other.events.some((e) => e.type === "barge_in")).toBe(false);
  });
});

/** 0.1.57 right after launch: a scripted microphone, a wake check that answers when told, and a router that records who was asked. */
const launch = () => {
  let firing: { readonly word: string; readonly ago: number } | null = null;
  let word: string | null = null;
  let ago = 0;
  const checks: Array<{ readonly word: string | null; readonly answer: (ok: boolean) => void }> =
    [];
  const routed: Array<{ readonly text: string; readonly wake: string | null | undefined }> = [];
  const events: VoiceCoreEvent[] = [];
  /** Recognition held back (the recogniser busy right after launch) until `recognise`. */
  let slow = false;
  const recognitions: Array<() => void> = [];
  /**
   * The speech detector scores frames `lag` behind the newest, repeating its last answer meanwhile: a stall
   * (frames in a burst it has not scored) is an endless lag until it catches up.
   */
  let lag = 0;
  let lastSpeech = false;
  const unscored: boolean[] = [];
  const scored = { speech: 0, quiet: 0 };
  const score = (keep: number) => {
    while (unscored.length > keep) {
      lastSpeech = unscored.shift()!;
      if (lastSpeech) {
        scored.speech += FRAME;
        scored.quiet = 0;
      } else scored.quiet += FRAME;
    }
  };
  // Each sentence is its own sample value, so recognition can tell which sentences a clip holds.
  const SAID: Record<number, string> = {
    1_000: "what time is it",
    2_000: "what is the weather",
    3_000: "what needs me",
    4_000: "Alfred, what needs me",
  };
  const core = createVoiceCore({
    waitMs: () => 0,
    timings: { ...DEFAULT_TIMINGS, wakeWords: ["Freya", "Alfred"] },
    verifyWake: (_pcm, w) => new Promise((answer) => checks.push({ word: w, answer })),
    wake: {
      name: "fake",
      reset: () => {},
      process: () => {
        if (firing === null) return null;
        ({ word, ago } = firing);
        firing = null;
        return 1;
      },
      lastWord: () => word,
      firedAgo: () => ago,
    },
    vad: {
      name: "fake",
      reset: () => {},
      isSpeech: (frame) => {
        unscored.push(frame[0] !== 0);
        score(lag);
        return lastSpeech;
      },
      scored: () => ({ ...scored }),
    },
    stt: {
      name: "fake",
      transcribe: async (pcm) => {
        if (slow) await new Promise<void>((resolve) => recognitions.push(resolve));
        return [...new Set(pcm)]
          .filter((v) => v !== 0)
          .map((v) => SAID[v])
          .join(" ");
      },
    },
    router: {
      route: async (effect, context) => {
        if (effect.kind === "command") routed.push({ text: effect.text, wake: context.wake });
        return { kind: "none" };
      },
    },
  });
  core.subscribe((event) => events.push(event));
  const say = (value: number, seconds: number) => {
    for (let i = 0; i < frames(seconds); i += 1) core.pushAudio(new Int16Array(FRAME).fill(value));
  };
  return {
    core,
    events,
    routed,
    checks,
    say,
    quiet: (seconds: number) => say(0, seconds),
    /** The scorer reports a name that ended `agoSeconds` before now. */
    fire: (w: string, agoSeconds = 0) => {
      firing = { word: w, ago: Math.round(agoSeconds * 16_000) };
    },
    /** He says a name, and the scorer reports it as it ends. */
    name: (w: string, value: number) => {
      say(value, 0.5);
      firing = { word: w, ago: 0 };
    },
    confirm: (w: string) => checks.find((c) => c.word === w)?.answer(true),
    slowRecognition: () => (slow = true),
    recognise: () => {
      slow = false;
      recognitions.splice(0).forEach((resolve) => resolve());
    },
    stall: (on: boolean) => {
      lag = on ? Infinity : 0;
      if (!on) score(0);
    },
    /** The detector keeps up, `seconds` behind. */
    lagBy: (seconds: number) => (lag = frames(seconds)),
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
};

describe("right after launch, when the wake check is slow", () => {
  it("answers a name said while the first check still runs, as that name, with only its own sentence", async () => {
    const r = launch();
    r.quiet(1);
    r.name("Freya", 1_000);
    r.say(1_000, 1.4);
    r.quiet(3);
    r.name("Alfred", 2_000);
    r.say(2_000, 1.4);
    r.quiet(2);
    r.confirm("Freya");
    r.confirm("Alfred");
    await r.settle();
    r.quiet(2);
    await r.core.idle();
    expect(r.routed).toEqual([
      { text: "what time is it", wake: "Freya" },
      { text: "what is the weather", wake: "Alfred" },
    ]);
  });

  it("answers as the name he starts his sentence with, in another persona's open window", async () => {
    const r = launch();
    r.quiet(1);
    r.name("Freya", 1_000);
    r.say(1_000, 1.4);
    r.quiet(3);
    r.confirm("Freya");
    await r.settle();
    r.quiet(1);
    // No model fires for this one, only the words name him. (It cannot cover 0.1.63's "Teseat"/"SA":
    // recognition wrote those too far from the name to trust as one.)
    r.say(4_000, 1.4);
    r.quiet(2);
    await r.settle();
    r.quiet(1);
    // The next sentence has no name: it stays with the one he named.
    r.say(3_000, 1.4);
    r.quiet(2);
    await r.settle();
    r.quiet(2);
    await r.core.idle();
    expect(r.routed.slice(-2)).toEqual([
      { text: "what needs me", wake: "Alfred" },
      { text: "what needs me", wake: "Alfred" },
    ]);
  });

  it("answers each sentence once, as the name said before it, when a name lands in the last one's open window", async () => {
    const r = launch();
    r.quiet(1);
    r.name("Freya", 1_000);
    r.say(1_000, 1.4);
    r.quiet(3);
    r.confirm("Freya");
    await r.settle();
    r.quiet(1);
    // Her window is open; his check is still running when his sentence ends.
    r.name("Alfred", 2_000);
    r.say(2_000, 1.4);
    r.quiet(2);
    await r.settle();
    r.confirm("Alfred");
    await r.settle();
    r.quiet(2);
    await r.core.idle();
    expect(r.routed).toEqual([
      { text: "what time is it", wake: "Freya" },
      { text: "what is the weather", wake: "Alfred" },
    ]);
  });

  it("answers a sentence whose recognition comes back after its window would have closed", async () => {
    const r = launch();
    r.quiet(4.4);
    r.name("Freya", 1_000);
    r.say(1_000, 1.4);
    r.quiet(2);
    // 0.1.59: the check took 28 s, and the sentence then waited another 20 s behind the next check.
    r.slowRecognition();
    r.quiet(26);
    r.confirm("Freya");
    await r.settle();
    r.quiet(20);
    r.recognise();
    await r.settle();
    r.quiet(1);
    await r.core.idle();
    expect(r.routed).toEqual([{ text: "what time is it", wake: "Freya" }]);
  });

  it("does not end the sentence after a name on frames the speech detector has not scored", async () => {
    const r = launch();
    r.quiet(4.4);
    r.name("Freya", 1_000);
    r.quiet(0.15);
    // The app stalls as the sentence starts: its frames arrive in a burst, and the detector still says silence.
    r.stall(true);
    r.say(1_000, 1.4);
    r.stall(false);
    r.quiet(2);
    r.confirm("Freya");
    await r.settle();
    r.quiet(1);
    await r.core.idle();
    expect(r.events.some((e) => e.type === "dropped" && e.reason === "no speech")).toBe(false);
    expect(r.routed).toEqual([{ text: "what time is it", wake: "Freya" }]);
  });

  it("keeps a command the busy detector scored too little of, while the wake was still being checked", async () => {
    const r = launch();
    r.quiet(4.4);
    r.name("Freya", 1_000);
    r.quiet(0.15);
    // 0.1.63: under load the detector scores almost none of it, and the check answers 3.8 s late.
    r.say(1_000, 0.2);
    r.quiet(2);
    r.confirm("Freya");
    await r.settle();
    r.quiet(1);
    await r.core.idle();
    expect(r.events.some((e) => e.type === "dropped" && e.reason === "no speech")).toBe(false);
    expect(r.routed).toEqual([{ text: "what time is it", wake: "Freya" }]);
  });

  it("starts no turn for a name with nothing after it, while its check runs", async () => {
    const r = launch();
    r.quiet(4.4);
    // 9_000 is the name alone: recognition hears no sentence in it.
    r.name("Freya", 9_000);
    r.quiet(2.5);
    r.confirm("Freya");
    await r.settle();
    r.quiet(1);
    await r.core.idle();
    expect(r.routed).toEqual([]);
  });

  it("keeps a command said after a pause behind the name, while the check still runs", async () => {
    const r = launch();
    r.quiet(4.4);
    // 0.1.65: "Freya, bring Notepad to the front" came back as "To the front.": the name and its pause
    // ended a sentence, and what followed went unheard until the late check confirmed the wake.
    r.name("Freya", 9_000);
    r.quiet(0.9);
    r.say(1_000, 1.4);
    r.quiet(2);
    r.confirm("Freya");
    await r.settle();
    r.quiet(2);
    await r.core.idle();
    expect(r.routed).toEqual([{ text: "what time is it", wake: "Freya" }]);
  });

  it("ends the sentence promptly on silence a lagging detector has scored", async () => {
    const r = launch();
    r.quiet(4.4);
    r.lagBy(1);
    r.name("Freya", 1_000);
    r.quiet(0.15);
    r.say(1_000, 1.4);
    // A second behind, plus the end-of-speech silence: not the fifteen-second cap.
    r.quiet(2);
    expect(r.events.some((e) => e.type === "speech_end")).toBe(false);
    r.confirm("Freya");
    await r.settle();
    expect(r.events.some((e) => e.type === "speech_end")).toBe(true);
    r.quiet(1);
    await r.core.idle();
    expect(r.routed).toEqual([{ text: "what time is it", wake: "Freya" }]);
  });

  it("takes a name said after her voice stopped as his, though the scorer reports it while she speaks again", async () => {
    const r = launch();
    r.core.noteSpoken("Freya here. It is seven in the morning.");
    r.core.setSpeaking(true);
    r.quiet(2);
    r.core.setSpeaking(false);
    r.quiet(1);
    r.say(3_000, 0.5);
    r.quiet(0.5);
    r.core.setSpeaking(true);
    r.quiet(0.5);
    r.fire("Freya", 1);
    r.quiet(0.2);
    r.confirm("Freya");
    await r.settle();
    r.quiet(0.2);
    expect(r.events.some((e) => e.type === "dropped" && e.reason === "own voice")).toBe(false);
    expect(r.events.some((e) => e.type === "wake" && e.word === "Freya")).toBe(true);
  });
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const was = (events: ReadonlyArray<VoiceCoreEvent>, reason: string) =>
  events.some((e) => e.type === "dropped" && e.reason === reason);

// The model is saturated (0.1.70: a noise fire scored 1.0519, like his real wakes), so a sure wake with nothing
// after it has its name checked in the background. Nothing in the voice queue waits on that check.
describe("a wake from sleep with nothing after it", () => {
  it("is let go silently after 5 s when the name's own audio does not hold the name", async () => {
    const r = rig(
      async () => false,
      () => true,
    );
    r.hears("");
    r.push(2);
    r.wake();
    r.push(0.1);
    await r.core.idle();
    // The pill shows at once, as for any sure wake.
    expect(r.events.some((e) => e.type === "wake")).toBe(true);
    // A no is only unsure: his real name can fail the matcher.
    r.push(4.5);
    await r.core.idle();
    expect(r.core.snapshot().machine.mode).toBe("command_window");
    r.push(0.6);
    await r.core.idle();
    expect(
      r.events.find((e) => e.type === "dropped" && e.reason === "wake not heard"),
    ).toMatchObject({ vadPeak: 0.02, vadMean: 0.02 });
    expect(r.events.some((e) => e.type === "dismissed")).toBe(false);
    expect(r.core.snapshot().machine.mode).toBe("sleeping");
  });

  it("keeps the window for a pause after the name, and the words he says then (L-11)", async () => {
    // His real "Tessaya" can fail the matcher ("Okay, to say you, what time…"): his words decide when he speaks.
    for (const [heardName, pause] of [
      [true, 7],
      [false, 4.5],
    ] as const) {
      const r = rig(
        async () => heardName,
        () => true,
      );
      r.push(2);
      r.wake();
      r.push(0.1);
      await r.core.idle();
      r.push(pause);
      await r.core.idle();
      r.speak(true);
      r.push(1);
      r.speak(false);
      r.push(1.5);
      await r.core.idle();
      expect(r.events.some((e) => e.type === "transcript")).toBe(true);
      expect(was(r.events, "wake not heard")).toBe(false);
    }
  });

  it("keeps his sentence when the no arrives just after he starts speaking", async () => {
    const answer = deferred<boolean>();
    const asked = deferred<void>();
    const r = rig(
      () => {
        asked.resolve();
        return answer.promise;
      },
      () => true,
    );
    r.push(2);
    r.wake();
    r.push(0.7);
    await asked.promise;
    r.speak(true);
    r.push(0.1);
    answer.resolve(false);
    await r.core.idle();
    r.push(0.9);
    r.speak(false);
    r.push(1.5);
    await r.core.idle();
    expect(r.events.some((e) => e.type === "transcript")).toBe(true);
    expect(was(r.events, "wake not heard")).toBe(false);
  });

  it("with the check off or unsure, is let go after 5 s of no speech", async () => {
    const r = rig(
      async () => null,
      () => true,
    );
    r.push(2);
    r.wake();
    r.push(0.1);
    await r.core.idle();
    r.push(4);
    await r.core.idle();
    expect(r.core.snapshot().machine.mode).toBe("command_window");
    r.push(1.2);
    await r.core.idle();
    expect(was(r.events, "wake not heard")).toBe(true);
    expect(r.core.snapshot().machine.mode).toBe("sleeping");
  });

  it("takes a hung check as unsure after 2 s on the clock, and never holds the queue on it", async () => {
    const asked = deferred<void>();
    const r = rig(
      () => {
        asked.resolve();
        return new Promise<boolean>(() => {});
      },
      () => true,
    );
    r.push(2);
    r.wake();
    r.push(1);
    await asked.promise;
    await r.core.idle();
    r.advance(2_100);
    r.push(4.2);
    await r.core.idle();
    expect(was(r.events, "wake not heard")).toBe(true);
  });

  it("ignores a check that answers after a newer wake", async () => {
    const first = deferred<boolean>();
    const firstAsked = deferred<void>();
    let checks = 0;
    const r = rig(
      () => {
        checks += 1;
        if (checks > 1) return Promise.resolve(null);
        firstAsked.resolve();
        return first.promise;
      },
      () => true,
    );
    r.push(2);
    r.wake();
    r.push(1);
    await firstAsked.promise;
    // He ends that window himself and wakes her again; only then does the first check say it heard the name.
    r.core.activate("dismiss");
    await r.core.idle();
    r.wake();
    r.push(0.1);
    await r.core.idle();
    // The newer wake's own check runs and is unsure; then the first one's late "heard" must change nothing.
    r.push(1);
    await r.core.idle();
    first.resolve(true);
    await r.core.idle();
    r.push(4.2);
    await r.core.idle();
    expect(checks).toBe(2);
    expect(was(r.events, "wake not heard")).toBe(true);
  });

  it("does not end a dictation, a key dictation or a question that came during it", async () => {
    const dictating = rig(
      async () => false,
      () => true,
    );
    dictating.push(2);
    dictating.wake();
    dictating.push(0.1);
    await dictating.core.idle();
    expect(await dictating.core.setDictation(true)).toBe(true);
    dictating.push(5.5);
    await dictating.core.idle();
    expect(was(dictating.events, "wake not heard")).toBe(false);
    expect(dictating.core.snapshot().machine.mode).toBe("dictation");

    // Recording or writing it out with the keys: the sidecar is busy.
    const keys = rig(
      async () => false,
      () => true,
      false,
      undefined,
      () => true,
    );
    keys.push(2);
    keys.wake();
    keys.push(5.5);
    await keys.core.idle();
    expect(was(keys.events, "wake not heard")).toBe(false);

    const asking = rig(
      async () => false,
      () => true,
    );
    asking.push(2);
    asking.wake();
    asking.push(0.1);
    await asking.core.idle();
    asking.core.confirm("Send it to Sam?");
    await asking.core.idle();
    asking.push(5.5);
    await asking.core.idle();
    expect(was(asking.events, "wake not heard")).toBe(false);
    expect(asking.core.snapshot().machine.pending).not.toBe(null);
  });

  // The paths that froze a version that waited on the check: each must leave a core that settles.
  it.each([0, 0.1, 0.3])("settles after a %s s blip behind a no", async (blip) => {
    const r = rig(
      async () => false,
      () => true,
    );
    r.hears("");
    r.push(2);
    r.wake();
    r.push(0.3);
    r.speak(true);
    r.push(blip);
    r.speak(false);
    r.push(1.5);
    await r.core.idle();
    r.hears("what time is it");
    r.push(1);
    r.wake();
    r.speak(true);
    r.push(1);
    r.speak(false);
    r.push(1.5);
    await r.core.idle();
    expect(r.events.some((e) => e.type === "transcript")).toBe(true);
  });

  it("settles when she starts speaking during it", async () => {
    const r = rig(
      async () => false,
      () => true,
    );
    r.hears("");
    r.push(2);
    r.wake();
    r.push(0.1);
    await r.core.idle();
    r.core.setSpeaking(true);
    r.push(0.5);
    r.core.setSpeaking(false);
    r.push(1.5);
    await r.core.idle();
    expect(was(r.events, "wake not heard")).toBe(false);
  });

  it.each([true, false])(
    "settles after two sure fires inside one check (the check says %s)",
    async (ok) => {
      const r = rig(
        async () => ok,
        () => true,
      );
      r.push(2);
      r.wake();
      r.push(0.02);
      r.wake();
      r.push(0.02);
      r.speak(true);
      r.push(1);
      r.speak(false);
      r.push(1.5);
      await r.core.idle();
      expect(r.events.some((e) => e.type === "transcript")).toBe(true);
    },
  );
});

// 0.1.73: "Freya, bring Notepad to the front" became "The pad to the front": the segment a wake opened ended as
// "no speech" 140 ms in, on a quiet count the speech detector had kept from before she slept.
describe("the words right after the name", () => {
  it("are kept when the speech detector is slow to hear them and its quiet count is stale", async () => {
    let fire = false;
    let firedAgo = 0;
    let speech = false;
    // Like Silero: it reports speech only a few frames after it starts, and counts the quiet it has scored.
    const LAG = 10;
    let run = 0;
    let scoredSpeech = 0;
    let quiet = 0;
    const heard: number[] = [];
    const events: VoiceCoreEvent[] = [];
    const core = createVoiceCore({
      waitMs: () => 0,
      trustWake: () => true,
      wake: {
        name: "fake",
        reset: () => {},
        process: () => {
          const score = fire ? 1 : null;
          fire = false;
          return score;
        },
        lastWord: () => "Sebastian",
        firedAgo: () => firedAgo,
      },
      vad: {
        name: "fake",
        reset: () => {
          run = 0;
          scoredSpeech = 0;
          quiet = 0;
        },
        isSpeech: (frame) => {
          run = speech ? run + 1 : 0;
          const heardIt = run > LAG;
          if (heardIt) {
            scoredSpeech += frame.length;
            quiet = 0;
          } else quiet += frame.length;
          return heardIt;
        },
        scored: () => ({ speech: scoredSpeech, quiet }),
      },
      stt: {
        name: "fake",
        transcribe: async (pcm) => {
          heard.push(pcm.length);
          return "bring Notepad to the front";
        },
      },
    });
    core.subscribe((event) => events.push(event));
    const push = (seconds: number) => {
      for (let i = 0; i < frames(seconds); i += 1) core.pushAudio(new Int16Array(FRAME));
    };
    // A window that ran out in silence: the detector heard seconds of quiet, then she slept.
    core.activate("wake");
    await core.idle();
    push(DEFAULT_TIMINGS.commandWindowMs / 1_000 + 1);
    await core.idle();
    expect(core.snapshot().machine.mode).toBe("sleeping");
    // The name, reported 120 ms late, with his command running straight on after it.
    speech = true;
    push(0.5);
    fire = true;
    firedAgo = Math.round(0.12 * 16_000);
    push(1.5);
    speech = false;
    push(1);
    await core.idle();
    expect(events.some((e) => e.type === "dropped" && e.reason === "no speech")).toBe(false);
    // One clip, from the name to the end of the command.
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeGreaterThan(1.5 * 16_000);
  });
});
