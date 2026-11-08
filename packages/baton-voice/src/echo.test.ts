import { describe, expect, it } from "vite-plus/test";

import { createVoiceCore, trimQuietTail, type VoiceCoreEvent } from "./core.ts";
import type { EchoGuard } from "./echoGuard.ts";
import { SET_ASIDE, type SttProvider } from "./types.ts";

/** The stop path runs beside the core's queue, a few promise turns away. */
const settled = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const FRAME = 512;
const frames = (seconds: number) => Math.ceil((seconds * 16_000) / FRAME);

/** Wakes on demand, hears speech on every frame, and transcribes whatever reaches it. */
const rig = () => {
  let fire = false;
  const heard: number[] = [];
  const events: VoiceCoreEvent[] = [];
  const core = createVoiceCore({
    waitMs: () => 0,
    wake: {
      name: "fake",
      reset: () => {},
      process: () => {
        const score = fire ? 1 : null;
        fire = false;
        return score;
      },
    },
    vad: { name: "fake", reset: () => {}, isSpeech: () => true },
    stt: {
      name: "fake",
      transcribe: async (pcm) => {
        heard.push(pcm.length);
        return "something he said";
      },
    },
  });
  core.subscribe((event) => events.push(event));
  const push = (seconds: number) => {
    for (let i = 0; i < frames(seconds); i += 1) core.pushAudio(new Int16Array(FRAME));
  };
  return { core, push, heard, events, wake: () => (fire = true) };
};

describe("Baton hearing itself", () => {
  it("starts no turn from its own voice in a conversation window", async () => {
    const r = rig();
    r.core.activate("wake");
    await r.core.idle();
    r.core.setSpeaking(true);
    r.push(12);
    r.core.setSpeaking(false);
    r.push(0.3);
    await r.core.idle();
    // Short windows do go to recognition, looking for a stop phrase. They start no turn.
    expect(r.events.some((e) => e.type === "transcript" || e.type === "thinking")).toBe(false);
  });

  it("lets a real wake word cut in, and then listens", async () => {
    const r = rig();
    r.core.setSpeaking(true);
    r.push(1);
    r.wake();
    r.push(1);
    expect(r.events.some((e) => e.type === "barge_in")).toBe(true);
    expect(r.events.some((e) => e.type === "wake")).toBe(true);
    r.push(16);
    await r.core.idle();
    expect(r.heard.length).toBeGreaterThan(0);
  });

  it("hears him again once the echo has gone", async () => {
    const r = rig();
    r.core.activate("wake");
    await r.core.idle();
    r.core.setSpeaking(true);
    r.push(1);
    r.core.setSpeaking(false);
    r.push(0.6);
    r.push(16);
    await r.core.idle();
    expect(r.heard.length).toBeGreaterThan(0);
  });
});

describe("silence after a wake word", () => {
  /** The rig, with the VAD and the recogniser under the test's control. */
  const scripted = (
    transcript = "Yeah.",
    stopStt?: SttProvider,
    echo?: EchoGuard,
    peak?: number,
  ) => {
    let failing = false;
    let holding: Array<() => void> | null = null;
    let fire = false;
    let speech = false;
    const heard: number[] = [];
    const events: VoiceCoreEvent[] = [];
    const routed: string[] = [];
    const core = createVoiceCore({
      waitMs: () => 0,
      wake: {
        name: "fake",
        reset: () => {},
        process: () => {
          const score = fire ? 0.98 : null;
          fire = false;
          return score;
        },
      },
      vad: {
        name: "fake",
        reset: () => {},
        isSpeech: () => speech,
        ...(peak === undefined ? {} : { probability: () => (speech ? peak : 0) }),
      },
      stt: {
        name: "fake",
        transcribe: async (pcm) => {
          heard.push(pcm.length);
          if (holding !== null) {
            const held = holding;
            await new Promise<void>((resolve) => held.push(resolve));
          }
          if (failing) {
            failing = false;
            throw new Error("recogniser crashed");
          }
          return transcript;
        },
      },
      ...(stopStt === undefined ? {} : { stopStt }),
      ...(echo === undefined ? {} : { echo }),
      router: {
        route: async (effect) => {
          if ("text" in effect) routed.push(`${effect.kind}:${effect.text}`);
          return { kind: "none" };
        },
      },
    });
    core.subscribe((event) => events.push(event));
    const push = (seconds: number) => {
      for (let i = 0; i < frames(seconds); i += 1) core.pushAudio(new Int16Array(FRAME));
    };
    return {
      /** Recognition waits until `release`. */
      hold: () => {
        holding = [];
      },
      release: () => {
        const held = holding ?? [];
        holding = null;
        held.forEach((resolve) => resolve());
      },
      failNext: () => {
        failing = true;
      },
      core,
      push,
      heard,
      events,
      routed,
      wake: () => (fire = true),
      speech: (on: boolean) => (speech = on),
      says: (text: string) => (transcript = text),
    };
  };

  it("sends nothing to recognition, and leaves the window open", async () => {
    const r = scripted();
    r.wake();
    r.push(2);
    await r.core.idle();
    expect(r.heard).toEqual([]);
    expect(r.core.snapshot().state).toBe("command_window");
    expect(r.events.some((e) => e.type === "transcript")).toBe(false);
  });

  it("does not count the wake word's own tail as speech", async () => {
    const r = scripted();
    r.wake();
    r.speech(true);
    r.push(0.15);
    r.speech(false);
    r.push(1.5);
    await r.core.idle();
    expect(r.heard).toEqual([]);
  });

  it("drops a lone filler in an open window, and logs why", async () => {
    const r = scripted("Yeah.");
    r.core.activate("wake");
    await r.core.idle();
    r.speech(true);
    r.push(0.6);
    r.speech(false);
    r.push(1);
    await r.core.idle();
    expect(r.heard.length).toBe(1);
    expect(r.routed).toEqual([]);
    expect(r.events.find((e) => e.type === "dropped")).toMatchObject({
      text: "Yeah.",
      reason: "filler",
    });
  });

  it("still hears a real request straight after the wake, first word included", async () => {
    const r = scripted("Jarvis, what needs me?");
    r.wake();
    r.push(0.1);
    r.speech(true);
    r.push(1);
    r.speech(false);
    r.push(1);
    await r.core.idle();
    expect(r.heard.length).toBe(1);
    // The wake's pre-roll and the frames that fired it are in the audio.
    expect(r.heard[0]! / 16_000).toBeGreaterThan(1.1);
    expect(r.routed).toEqual(["command:what needs me?"]);
  });

  it("never types silence or drops a filler while dictating", async () => {
    const r = scripted("Dictate.");
    r.core.activate("wake");
    await r.core.idle();
    r.speech(true);
    r.push(0.6);
    r.speech(false);
    r.push(1);
    await r.core.idle();
    expect(r.core.snapshot().state).toBe("dictation");
    r.says("Yeah.");
    r.speech(true);
    r.push(0.6);
    r.speech(false);
    r.push(1);
    await r.core.idle();
    expect(r.routed).toEqual(["dictate:Yeah."]);
    r.says("");
    r.speech(true);
    r.push(0.6);
    r.speech(false);
    r.push(1);
    await r.core.idle();
    expect(r.events.some((e) => e.type === "nothing")).toBe(false);
  });

  it("says nothing for words the host set aside (another language)", async () => {
    const r = scripted(SET_ASIDE);
    r.wake();
    r.push(0.1);
    r.speech(true);
    r.push(1);
    r.speech(false);
    r.push(1);
    await r.core.idle();
    expect(r.heard.length).toBe(1);
    expect(r.events.filter((e) => e.type === "nothing" || e.type === "transcript")).toEqual([]);
  });

  describe("a stop said over Baton's voice", () => {
    const talking = async (said: string, speaking: string, stopStt?: SttProvider) => {
      const r = scripted(said, stopStt);
      r.core.noteSpoken(speaking);
      r.core.setSpeaking(true);
      r.push(0.5);
      r.speech(true);
      r.push(0.5);
      r.speech(false);
      r.push(0.6);
      await settled();
      await r.core.idle();
      return r;
    };

    it("hears it on this computer's recogniser, never the cloud one, since it hears the room", async () => {
      const local: string[] = [];
      const r = await talking("Stop.", "The folder holds three reports.", {
        name: "local",
        transcribe: async () => (local.push("heard"), "Stop."),
      });
      expect(r.events.find((e) => e.type === "stop_heard")).toMatchObject({ text: "Stop." });
      expect(local).toEqual(["heard"]);
      expect(r.heard).toEqual([]);
    });

    it("works with no wake word and no open window", async () => {
      const r = await talking("Stop.", "The folder holds three reports.");
      expect(r.events.find((e) => e.type === "stop_heard")).toMatchObject({ text: "Stop." });
      expect(r.routed).toEqual([]);
    });

    it("takes every phrase on the list, with or without a wake word", async () => {
      for (const said of [
        "Quiet.",
        "Enough.",
        "That's enough.",
        "Cancel.",
        "Shut up.",
        "Wait.",
        "Jarvis, stop.",
      ]) {
        const r = await talking(said, "A sentence about reports.");
        expect(r.events.some((e) => e.type === "stop_heard")).toBe(true);
      }
    });

    it("ignores the same word coming back through his speakers", async () => {
      const r = await talking("is to stop.", "The next step is to stop.");
      expect(r.events.some((e) => e.type === "stop_heard")).toBe(false);
      expect(r.events.find((e) => e.type === "dropped")).toMatchObject({ reason: "own voice" });
    });

    it("does not take her own command-only sentence for his", async () => {
      const r = await talking("Wait.", "Wait. That's not right.");
      expect(r.events.some((e) => e.type === "stop_heard")).toBe(false);
      expect(r.events.find((e) => e.type === "dropped")).toMatchObject({ reason: "own voice" });
    });

    it("takes his stop when she said a different command on its own", async () => {
      const r = await talking("Stop.", "Wait. Next we stop the service.");
      expect(r.events.some((e) => e.type === "stop_heard")).toBe(true);
    });

    it("labels her own words heard back as her own voice", async () => {
      const r = await talking("the folder holds", "The folder holds three reports.");
      expect(r.events.find((e) => e.type === "dropped")).toMatchObject({ reason: "own voice" });
    });

    it("says when the recogniser failed on words over her voice", async () => {
      const r = scripted("Stop.");
      r.core.noteSpoken("A sentence.");
      r.failNext();
      r.core.setSpeaking(true);
      r.push(0.5);
      r.speech(true);
      r.push(0.5);
      r.speech(false);
      r.push(0.6);
      await settled();
      expect(r.events.find((e) => e.type === "dropped")).toMatchObject({
        reason: "recognition failed",
      });
    });

    const busy = (said: string) => {
      const r = scripted(said);
      r.core.noteSpoken("A sentence.");
      r.hold();
      r.core.setSpeaking(true);
      r.push(0.5);
      for (let i = 0; i < 3; i += 1) {
        r.speech(true);
        r.push(0.5);
        r.speech(false);
        r.push(0.6);
      }
      return r;
    };

    it("keeps his latest words for when a busy recogniser is free, and lets only an older wait go", async () => {
      const r = busy("Can you hear me");
      await settled();
      // The first is being recognised, the third waits, and the second, overtaken, is let go.
      expect(r.heard).toHaveLength(1);
      expect(r.events.filter((e) => e.type === "dropped")).toEqual([
        { type: "dropped", text: "", reason: "recogniser busy" },
      ]);
      r.release();
      await settled();
      expect(r.heard).toHaveLength(2);
    });

    it("forgets what waited once a stop is heard", async () => {
      const r = busy("Stop.");
      await settled();
      r.release();
      await settled();
      expect(r.heard).toHaveLength(1);
      expect(r.events.filter((e) => e.type === "stop_heard")).toHaveLength(1);
    });

    it("recognises a waiting clip only while she is still speaking", async () => {
      const r = scripted("Can you hear me");
      r.core.noteSpoken("A sentence.");
      r.hold();
      r.core.setSpeaking(true);
      r.push(0.5);
      for (let i = 0; i < 2; i += 1) {
        r.speech(true);
        r.push(0.5);
        r.speech(false);
        r.push(0.6);
      }
      r.core.setSpeaking(false);
      r.push(2);
      r.release();
      await settled();
      expect(r.heard).toHaveLength(1);
      expect(r.events.filter((e) => e.type === "dropped").map((e) => e.reason)).toContain(
        "recogniser busy",
      );
    });

    it("takes a clip that is only the command, even when her sentence has the word", async () => {
      for (const said of ["Stop.", "Jarvis, stop."]) {
        const r = await talking(said, "The next step is to stop the service.");
        expect(r.events.some((e) => e.type === "stop_heard")).toBe(true);
      }
    });

    /** She asks `question` aloud and he says the scripted words over it; resolves with his answer or the drop. */
    const answering = async (
      said: string,
      question: string,
      options: { readonly nearEnd?: number; readonly afterHer?: boolean } = {},
    ) => {
      let nearEnd = 0;
      const r = scripted(said, undefined, {
        reference: () => {},
        reset: () => {},
        state: () => ({ delayMs: 0, erleDb: 0, converged: true }),
        // `nearEnd` frames of his voice flagged: two make a run (proof it is his, short of a barge-in), one is stray.
        process: () => ({ ready: true, nearEnd: (nearEnd -= 1) >= 0, erleDb: 20 }),
      });
      const asked = r.core.confirm(question);
      await r.core.idle();
      const dropped = new Promise<string>((resolve) =>
        r.core.subscribe((e) => e.type === "dropped" && resolve(`dropped: ${e.reason}`)),
      );
      r.core.noteSpoken(question);
      r.core.setSpeaking(true);
      r.push(0.5);
      if (options.afterHer === true) r.core.setSpeaking(false);
      nearEnd = options.nearEnd ?? 0;
      // Short enough to end inside her echo tail when he begins after she stopped.
      r.speech(true);
      r.push(0.12);
      r.speech(false);
      r.push(0.35);
      const result = await Promise.race([asked.answer, dropped]);
      asked.cancel();
      return result;
    };

    it.each([
      // [he says, her question, how it is known to be his, what counts]
      // A no over her voice is his answer: at worst nothing runs.
      ["No.", "Shall I do that? Yes or no.", {}, "no"],
      ["Jarvis, no.", "Shall I do that? Yes or no.", {}, "no"],
      // 0.1.73: his yes is taken when the echo guard heard him, or he began after she stopped.
      ["Yes, go ahead.", "Shall I clear the box?", { nearEnd: 2 }, "yes"],
      ["Jarvis, yes.", "Shall I clear the box?", { nearEnd: 2 }, "yes"],
      // One stray near-end frame is not his voice.
      ["Yes, go ahead.", "Shall I clear the box?", { nearEnd: 1 }, "dropped"],
      ["Yes.", "Shall I clear the box?", { afterHer: true }, "yes"],
      // Her own words heard back never approve: a fragment, the "Yes" of "Yes or no.", her "Yes." as "Yeah.".
      ["do that", "Shall I do that? Yes or no.", {}, "dropped"],
      ["Yes", "Shall I do that? Yes or no.", {}, "dropped"],
      ["Yes", "Shall I do that? Yes or no.", { nearEnd: 2 }, "dropped"],
      ["Yeah.", "Yes. Shall I do that?", {}, "dropped"],
      ["Yes.", "Shall I clear the box?", {}, "dropped"],
    ] as const)("%s over %j (%j) counts as %s", async (said, question, options, want) => {
      expect(await answering(said, question, options)).toMatch(new RegExp(`^${want}`));
    });

    it("types what he says over her closing line once dictation is on, without her words (LIVE-2240)", async () => {
      const r = scripted("say stop dictation when you're done. a test of dictation.");
      await r.core.setDictation(true);
      r.core.noteSpoken("Dictation's on. Say stop dictation when you're done.");
      r.core.setSpeaking(true);
      r.push(0.5);
      r.speech(true);
      r.push(0.5);
      r.speech(false);
      r.push(0.6);
      await r.core.idle();
      expect(r.routed).toEqual(["dictate:a test of dictation."]);
    });

    it("keeps every clip over her voice in a dictation, in order, however busy the recogniser", async () => {
      const r = scripted("one.");
      await r.core.setDictation(true);
      r.core.noteSpoken("A long closing line of hers.");
      r.hold();
      r.core.setSpeaking(true);
      for (const word of ["one.", "two.", "three."]) {
        r.says(word);
        r.speech(true);
        r.push(0.3);
        r.speech(false);
        r.push(0.4);
      }
      r.release();
      await r.core.idle();
      expect(r.events.some((e) => e.type === "dropped")).toBe(false);
      expect(r.routed).toHaveLength(3);
    });

    it("logs what it heard over her voice and did not act on", async () => {
      const r = await talking("Can you hear me", "A sentence about reports.");
      expect(r.events.find((e) => e.type === "dropped")).toMatchObject({
        text: "Can you hear me",
        reason: "not a stop, said over her voice",
      });
    });

    it("hears his stop at the end of a window that caught her voice first", async () => {
      const r = await talking(
        "the build passed and three tests stop",
        "The build passed and three tests ran.",
      );
      expect(r.events.find((e) => e.type === "stop_heard")).toMatchObject({ text: "stop" });
    });

    it("acts on nothing else said while it talks", async () => {
      const r = await talking("Delete the reports.", "The folder holds three reports.");
      expect(r.events.some((e) => e.type === "stop_heard")).toBe(false);
      expect(r.routed).toEqual([]);
    });

    it("cuts a window over continuous speech, so its voice cannot hide him", async () => {
      const r = scripted("Stop.");
      r.core.setSpeaking(true);
      r.speech(true);
      r.push(2.2);
      await settled();
      expect(r.heard.length).toBe(1);
    });
  });

  /** A dictation of `clips`, each [what is heard, seconds of speech, detector peak], then `end`. */
  const dictating = async (
    clips: ReadonlyArray<readonly [string, number, number]>,
    end: "check" | "none" = "check",
  ) => {
    let r: ReturnType<typeof scripted> | null = null;
    const routed: string[] = [];
    const events: VoiceCoreEvent[] = [];
    for (const [i, [text, seconds, peak]] of clips.entries()) {
      // One core for the whole dictation, so the detector's peak is the first clip's for all of them.
      if (r === null) {
        r = scripted(text, undefined, undefined, peak);
        await r.core.setDictation(true);
      }
      r.says(text);
      r.speech(true);
      r.push(seconds);
      r.speech(false);
      r.push(1.2);
      await r.core.idle();
      if (i === clips.length - 1 && end === "check") await r.core.setDictation(false);
    }
    routed.push(...(r?.routed ?? []));
    events.push(...(r?.events ?? []));
    return { routed, dropped: events.filter((e) => e.type === "dropped").map((e) => e.text) };
  };

  it.each([
    // [clips: what is heard, seconds of speech, detector peak], [what goes in], [what is dropped]
    // 0.1.73: a breath after he stops, heard as "Yeah.", at the very end: dropped (logged with its peak).
    [
      [
        ["Dear Sam.", 0.6, 0.05],
        ["Yeah.", 0.26, 0.05],
      ],
      ["Dear Sam."],
      ["Yeah."],
    ],
    // The same "yeah" mid-dictation was his: it goes in, before what followed it.
    [
      [
        ["Yeah.", 0.26, 0.05],
        ["See you then.", 0.6, 0.05],
      ],
      ["Yeah.", "See you then."],
      [],
    ],
    // His real peaks run near 0.06: a long "Okay." and a short "Yes." are words, kept.
    [[["Okay.", 0.6, 0.05]], ["Okay."], []],
    [[["Yes.", 0.26, 0.05]], ["Yes."], []],
    // Heard surely, even short: kept.
    [[["Yeah.", 0.26, 0.9]], ["Yeah."], []],
  ] as const)("dictation %j types %j and drops %j", async (clips, typed, dropped) => {
    const r = await dictating(clips);
    expect(r.routed).toEqual(typed.map((t) => `dictate:${t}`));
    expect(r.dropped).toEqual(dropped);
  });

  it("drops a weak filler before 'stop dictation', which ends it", async () => {
    const r = await dictating(
      [
        ["Dear Sam.", 0.6, 0.05],
        ["Yeah.", 0.26, 0.05],
        ["Stop dictation.", 0.6, 0.05],
      ],
      "none",
    );
    expect(r.routed).toEqual(["dictate:Dear Sam."]);
    expect(r.dropped).toEqual(["Yeah."]);
  });
});

describe("a yes or no asked aloud", () => {
  const asking = (transcript: string) => {
    let speech = false;
    const core = createVoiceCore({
      waitMs: () => 0,
      wake: { name: "fake", reset: () => {}, process: () => null },
      vad: { name: "fake", reset: () => {}, isSpeech: () => speech },
      stt: { name: "fake", transcribe: async () => transcript },
    });
    const talk = async () => {
      speech = true;
      for (let i = 0; i < frames(0.6); i += 1) core.pushAudio(new Int16Array(FRAME));
      speech = false;
      for (let i = 0; i < frames(1); i += 1) core.pushAudio(new Int16Array(FRAME));
      await core.idle();
    };
    return { core, talk };
  };

  it("takes his yes and his no", async () => {
    for (const [said, want] of [
      ["Yes.", "yes"],
      ["No.", "no"],
      // A new sentence instead of an answer lapses the question as a no, so the turn waiting on it ends.
      ["Explain how a VPN works.", "no"],
    ] as const) {
      const r = asking(said);
      const question = r.core.confirm("Run it?");
      await r.core.idle();
      await r.talk();
      expect(await question.answer).toBe(want);
    }
  });

  it("runs out to expired, so the box can still answer", async () => {
    const r = asking("");
    const question = r.core.confirm("Run it?");
    await r.core.idle();
    for (let i = 0; i < frames(16); i += 1) r.core.pushAudio(new Int16Array(FRAME));
    await r.core.idle();
    expect(await question.answer).toBe("expired");
  });

  it("forgets the question once the box has answered", async () => {
    const r = asking("Yes.");
    r.core.confirm("Run it?").cancel();
    await r.core.idle();
    expect(r.core.snapshot().machine.pending).toBeNull();
  });
});

describe("a wake word over a long reply", () => {
  it("keeps what he says next, though the next sentence starts", async () => {
    const r = rig();
    r.core.setSpeaking(true);
    r.push(1);
    r.wake();
    r.push(0.2);
    // The rest of the reply's queue ending, or one more sentence starting.
    r.core.setSpeaking(true);
    r.core.setSpeaking(false);
    r.push(16);
    await r.core.idle();
    expect(r.heard.length).toBeGreaterThan(0);
    expect(r.heard[0]! / 16_000).toBeGreaterThan(5);
  });
});

describe("a pending yes, with Baton talking over it", () => {
  const rigged = (heard: string) => {
    let fire = false;
    let speech = true;
    const effects: string[] = [];
    const core = createVoiceCore({
      waitMs: () => 0,
      wake: {
        name: "fake",
        reset: () => {},
        process: () => {
          const score = fire ? 1 : null;
          fire = false;
          return score;
        },
      },
      vad: { name: "fake", reset: () => {}, isSpeech: () => speech },
      stt: { name: "fake", transcribe: async () => heard },
      router: {
        route: async (effect) => {
          effects.push(effect.kind);
          return effect.kind === "command"
            ? { kind: "needs_confirmation", token: "t", prompt: "Sure?", workSessionId: null }
            : { kind: "none" };
        },
      },
    });
    const push = (seconds: number) => {
      for (let i = 0; i < frames(seconds); i += 1) core.pushAudio(new Int16Array(FRAME));
    };
    return {
      core,
      push,
      effects,
      wake: () => (fire = true),
      quiet: () => (speech = false),
    };
  };
  const overItsVoice = async (r: ReturnType<typeof rigged>) => {
    r.core.activate("wake");
    await r.core.idle();
    await r.core.hear("send it to backend");
    await r.core.idle();
    r.core.setSpeaking(true);
    r.push(0.5);
    r.wake();
    r.push(1);
    // He stops talking: inside the window, so the question has not run out.
    r.quiet();
    r.push(1.5);
    await r.core.idle();
  };

  it("ignores a confirm that started over its voice", async () => {
    const r = rigged("Freya, confirm.");
    await overItsVoice(r);
    expect(r.effects).not.toContain("confirmed");
  });

  it("still hears cancel", async () => {
    const r = rigged("cancel");
    await overItsVoice(r);
    expect(r.effects).toContain("cancelled");
  });
});

describe("speech that starts while he is cutting in", () => {
  it("closes the gate when his words end", async () => {
    const r = rig();
    r.core.setSpeaking(true);
    r.push(1);
    r.wake();
    r.push(0.2);
    r.core.setSpeaking(true);
    r.push(16);
    await r.core.idle();
    const turns = () => r.events.filter((e) => e.type === "transcript").length;
    const after = turns();
    r.push(16);
    await r.core.idle();
    expect(turns()).toBe(after);
  });
});

describe("cutting in by voice (docs/baton/BARGE_IN.md)", () => {
  const rigWith = (extra: {
    echo?: { process: () => { ready: boolean; nearEnd: boolean; erleDb: number } };
    headphones?: boolean;
  }) => {
    const events: VoiceCoreEvent[] = [];
    const spoken = { value: false };
    const core = createVoiceCore({
      waitMs: () => 0,
      wake: { name: "fake", reset: () => {}, process: () => null },
      vad: { name: "fake", reset: () => {}, isSpeech: () => spoken.value },
      stt: { name: "fake", transcribe: async () => "something he said" },
      ...(extra.echo === undefined
        ? {}
        : {
            echo: {
              reference: () => {},
              reset: () => {},
              state: () => ({ delayMs: 0, erleDb: 0, converged: true }),
              ...extra.echo,
            },
          }),
      ...(extra.headphones ? { speakerMode: () => "headphones" as const } : {}),
    });
    core.subscribe((event) => events.push(event));
    const push = (seconds: number) => {
      for (let i = 0; i < frames(seconds); i += 1) core.pushAudio(new Int16Array(FRAME));
    };
    return { core, push, events, spoken };
  };
  const kinds = (events: VoiceCoreEvent[]) =>
    events.flatMap((e) =>
      e.type === "barge_duck"
        ? [`duck:${e.on}`]
        : e.type === "barge_in" || e.type === "wake"
          ? [e.type]
          : [],
    );

  it("over speakers, ducks the voice at once and cuts in after 120 ms when the echo guard hears him", () => {
    let him = false;
    const r = rigWith({ echo: { process: () => ({ ready: true, nearEnd: him, erleDb: 12 }) } });
    r.core.setSpeaking(true);
    r.push(1);
    him = true;
    r.push(0.5);
    expect(kinds(r.events)).toEqual(expect.arrayContaining(["duck:true", "barge_in", "wake"]));
    expect(kinds(r.events).indexOf("duck:true")).toBeLessThan(kinds(r.events).indexOf("barge_in"));
  });

  it("over speakers, gives the voice back when it was only a blip, and never cuts in on an echo guard that is not ready", () => {
    let flag = false;
    let ready = true;
    const r = rigWith({ echo: { process: () => ({ ready, nearEnd: flag, erleDb: 12 }) } });
    r.core.setSpeaking(true);
    flag = true;
    r.push(0.05);
    flag = false;
    r.push(0.2);
    expect(kinds(r.events)).toEqual(["duck:true", "duck:false"]);
    r.events.length = 0;
    ready = false;
    flag = true;
    r.push(1);
    expect(kinds(r.events)).not.toContain("barge_in");
  });

  it("with no echo guard, speech over her voice does nothing: only a wake or stop phrase gets through", () => {
    const r = rigWith({});
    r.spoken.value = true;
    r.core.setSpeaking(true);
    r.push(2);
    expect(kinds(r.events)).not.toContain("barge_in");
  });

  it("on headphones it listens through her voice, and speech over it cuts in", () => {
    const r = rigWith({ headphones: true });
    r.core.setSpeaking(true);
    r.push(1);
    expect(kinds(r.events)).not.toContain("barge_in");
    r.spoken.value = true;
    r.push(0.5);
    expect(kinds(r.events)).toEqual(expect.arrayContaining(["duck:true", "barge_in"]));
  });
});

describe("a dictation clip's quiet tail", () => {
  it("is cut to a fifth of a second after his last loud frame, before recognition", () => {
    // Half a second of speech, then 800 ms of room noise the segmenter waited out.
    const pcm = Int16Array.from({ length: 16_000 * 1.3 }, (_, i) =>
      i < 8_000 ? Math.round(6_000 * Math.sin(i / 3)) : i % 2 === 0 ? 40 : -40,
    );
    expect(trimQuietTail(pcm).length).toBe(8_000 + 3_200);
    expect(trimQuietTail(new Int16Array(16_000)).length).toBe(16_000);
  });
});
