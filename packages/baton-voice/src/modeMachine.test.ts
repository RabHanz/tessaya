import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TIMINGS,
  initialVoiceState,
  isLoneBreath,
  reduceVoice,
  namedWake,
  stripWake,
  type VoiceEvent,
  type VoiceMachineState,
} from "./modeMachine.ts";

const play = (
  events: ReadonlyArray<VoiceEvent>,
  start: VoiceMachineState = initialVoiceState(),
) => {
  let state = start;
  const effects = [];
  for (const event of events) {
    const step = reduceVoice(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
};

describe("voice mode machine (§12.3)", () => {
  it("takes any configured word, with no Hey, off the front of what was heard", () => {
    const timings = { ...DEFAULT_TIMINGS, wakeWords: ["Sebastian", "Alfred", "Freya"] };
    let state = initialVoiceState();
    const heard = reduceVoice(state, { type: "wake", at: 0 }, timings);
    state = heard.state;
    const { effects } = reduceVoice(
      state,
      { type: "utterance", text: "Alfred, what needs me?", at: 10 },
      timings,
    );
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "command", text: "what needs me?" }),
    );
  });

  it("sleeping ignores speech without a wake", () => {
    const { state, effects } = play([
      { type: "utterance", text: "what is VantageOS doing", at: 0 },
    ]);
    expect(state.mode).toBe("sleeping");
    expect(effects).toEqual([
      { kind: "ignored", text: "what is VantageOS doing", reason: "asleep" },
    ]);
  });

  it("wake opens the command window; a command moves to conversation", () => {
    const { state, effects } = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "Hey Jarvis, what's VantageOS doing?", at: 1000 },
    ]);
    expect(state.mode).toBe("conversation");
    expect(effects).toEqual([
      { kind: "command", text: "what's VantageOS doing?", inheritedTarget: null },
    ]);
  });

  it("follow-ups inherit the target without a repeated wake, until the timeout", () => {
    const { state, effects } = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "what's VantageOS doing", at: 1000 },
      { type: "set_target", workSessionId: "ws-1", at: 1100 },
      { type: "utterance", text: "tell it to run the other test too", at: 5000 },
      { type: "tick", at: 5000 + DEFAULT_TIMINGS.conversationMs + 1 },
      {
        type: "utterance",
        text: "then have codex review it",
        at: 5000 + DEFAULT_TIMINGS.conversationMs + 2,
      },
    ]);
    expect(effects[1]).toEqual({
      kind: "command",
      text: "tell it to run the other test too",
      inheritedTarget: "ws-1",
    });
    expect(state.mode).toBe("sleeping");
    expect(state.conversationTarget).toBeNull();
    expect(effects[2]).toMatchObject({ kind: "ignored", reason: "asleep" });
  });

  it("the command window closes on its own if nothing is said", () => {
    const { state } = play([
      { type: "wake", at: 0 },
      { type: "tick", at: DEFAULT_TIMINGS.commandWindowMs + 1 },
    ]);
    expect(state.mode).toBe("sleeping");
  });

  it("a name said alone keeps the command window, not a conversation's 30 s", () => {
    // 0.1.72: after "Freya." alone, a keep_open queued while it was recognised ran after it and held 30 s.
    const { state } = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "Jarvis.", at: 1_000 },
      { type: "keep_open", at: 1_200 },
      { type: "tick", at: 1_200 + DEFAULT_TIMINGS.commandWindowMs + 1 },
    ]);
    expect(state.mode).toBe("sleeping");
  });

  it("'that's all' ends the conversation", () => {
    const { state } = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "what needs me", at: 10 },
      { type: "utterance", text: "that's all", at: 20 },
    ]);
    expect(state.mode).toBe("sleeping");
  });

  it("direct-session sends plain speech to the session, and a wake still opens a command", () => {
    const start = initialVoiceState(true);
    const { state, effects } = play(
      [
        { type: "utterance", text: "also run the migration tests", at: 0 },
        { type: "wake", at: 100 },
        { type: "utterance", text: "what needs me", at: 200 },
        { type: "tick", at: 200 + DEFAULT_TIMINGS.conversationMs + 1 },
      ],
      start,
    );
    expect(effects[0]).toEqual({ kind: "session_message", text: "also run the migration tests" });
    expect(effects[1]).toMatchObject({ kind: "command", text: "what needs me" });
    expect(state.mode).toBe("direct_session");
  });

  it("toggling direct-session moves the resting mode only", () => {
    let { state } = play([{ type: "set_direct_session", enabled: true, at: 0 }]);
    expect(state.mode).toBe("direct_session");
    ({ state } = play([{ type: "set_direct_session", enabled: false, at: 1 }], state));
    expect(state.mode).toBe("sleeping");
  });

  it("dictation is its own effect and only 'stop dictating' leaves it", () => {
    const { state, effects } = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "Jarvis, dictate: Thanks, I'll send it tomorrow.", at: 10 },
      { type: "utterance", text: "Tell Claude to deploy.", at: 20 },
      { type: "tick", at: 10 * DEFAULT_TIMINGS.conversationMs },
      { type: "utterance", text: "Best, Rab", at: 10 * DEFAULT_TIMINGS.conversationMs + 1 },
      { type: "utterance", text: "stop dictating", at: 10 * DEFAULT_TIMINGS.conversationMs + 2 },
    ]);
    expect(
      effects.filter((e) => e.kind === "dictate").map((e) => ("text" in e ? e.text : "")),
    ).toEqual(["Thanks, I'll send it tomorrow.", "Tell Claude to deploy.", "Best, Rab"]);
    expect(effects.some((e) => e.kind === "command" || e.kind === "session_message")).toBe(false);
    expect(state.mode).toBe("conversation");
  });

  it("goes talk, dictation, talk with no second wake word", () => {
    const { state, effects } = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "what needs me", at: 10 },
      { type: "utterance", text: "I want to dictate", at: 20 },
      { type: "utterance", text: "Dear Sam, stop by on Friday.", at: 30 },
      { type: "utterance", text: "That is all for now. Stop dictating.", at: 40 },
      { type: "utterance", text: "open my downloads", at: 50 },
    ]);
    // The pill says it ended and the words landed; she says nothing over them.
    expect(effects.map((e) => e.kind)).toEqual(["command", "dictate", "dictate", "command"]);
    expect(effects[2]).toMatchObject({ text: "That is all for now." });
    expect(state.mode).toBe("conversation");
  });

  it("types a plain done while dictating, and a wake-word stop leaves", () => {
    const words = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "dictate", at: 10 },
      { type: "utterance", text: "I'm done.", at: 30 },
    ]);
    expect(words.state.mode).toBe("dictation");
    expect(words.effects.map((e) => e.kind)).toEqual(["dictate"]);
    const named = play(
      [{ type: "utterance", text: "Jarvis, stop dictating.", at: 40 }],
      words.state,
    );
    expect(named.state.mode).toBe("conversation");
    expect(named.effects).toEqual([]);
  });

  it("closes the window on a short thanks, but not while asleep", () => {
    for (const text of ["Thanks.", "thank you", "go to sleep", "Cheers"]) {
      const { state, effects } = play([
        { type: "wake", at: 0 },
        { type: "utterance", text: "what needs me", at: 10 },
        { type: "utterance", text, at: 20 },
      ]);
      expect(state.mode).toBe("sleeping");
      expect(effects.map((e) => e.kind)).toEqual(["command"]);
    }
  });

  it("keeps a window open while Baton talks past its deadline", () => {
    const start = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "explain this", at: 10 },
    ]);
    const late = DEFAULT_TIMINGS.conversationMs + 5_000;
    expect(
      play(
        [
          { type: "keep_open", at: 20_000 },
          { type: "tick", at: late },
        ],
        start.state,
      ).state.mode,
    ).toBe("conversation");
    expect(play([{ type: "tick", at: late }], start.state).state.mode).toBe("sleeping");
  });

  it("a confirmation is answered by a later 'confirm', never by the wake word", () => {
    const { effects } = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "start work on scheduler with codex", at: 10 },
      { type: "request_confirmation", token: "t1", prompt: "Start work? Say confirm.", at: 20 },
      { type: "utterance", text: "hey jarvis", at: 30 },
      { type: "utterance", text: "confirm", at: 40 },
    ]);
    const kinds = effects.map((e) => e.kind);
    expect(kinds).toEqual(["command", "speak", "ignored", "confirmed"]);
  });

  it("a confirmation expires and can be declined or superseded", () => {
    const expired = play([
      { type: "wake", at: 0 },
      { type: "request_confirmation", token: "t1", prompt: "?", at: 0 },
      { type: "utterance", text: "confirm", at: DEFAULT_TIMINGS.confirmationMs + 1 },
    ]);
    expect(expired.effects.map((e) => e.kind)).toEqual(["speak", "cancelled", "command"]);

    const declined = play([
      { type: "wake", at: 0 },
      { type: "request_confirmation", token: "t1", prompt: "?", at: 0 },
      { type: "utterance", text: "no", at: 10 },
    ]);
    expect(declined.effects).toContainEqual({ kind: "cancelled", token: "t1", reason: "declined" });

    const superseded = play([
      { type: "wake", at: 0 },
      { type: "request_confirmation", token: "t1", prompt: "?", at: 0 },
      { type: "utterance", text: "what needs me", at: 10 },
    ]);
    expect(superseded.effects.map((e) => e.kind)).toEqual(["speak", "cancelled", "command"]);
  });

  it("hears a yes or a no by the whole sentence, and gives anything mixed to the assistant", () => {
    const answer = (text: string) =>
      play([
        { type: "wake", at: 0 },
        { type: "request_confirmation", token: "t1", prompt: "Type it?", at: 0 },
        { type: "utterance", text, at: 10 },
      ]).effects.slice(1);
    for (const yes of ["yeah go on then", "Yes please.", "yep", "sure, go for it", "OK, do it"]) {
      expect(answer(yes), yes).toEqual([{ kind: "confirmed", token: "t1" }]);
    }
    for (const no of ["nah", "No, not now.", "don't"]) {
      expect(answer(no)[0], no).toEqual({ kind: "cancelled", token: "t1", reason: "declined" });
    }
    for (const other of ["no, send it to Sam instead", "don't forget to cc me, yes"]) {
      expect(answer(other), other).toEqual([
        { kind: "cancelled", token: "t1", reason: "superseded" },
        expect.objectContaining({ kind: "command", text: other }),
      ]);
    }
  });
});

describe("stop while dictating", () => {
  it("starts and stops from the assistant the way his own words do", () => {
    const asked = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "type into that box", at: 10 },
      { type: "set_dictation", on: true, at: 20 },
    ]);
    expect(asked.state.mode).toBe("dictation");
    const typed = reduceVoice(asked.state, {
      type: "utterance",
      text: "This is a test of dictation.",
      at: 30,
    });
    expect(typed.effects).toContainEqual({ kind: "dictate", text: "This is a test of dictation." });
    const off = reduceVoice(typed.state, { type: "set_dictation", on: false, at: 40 });
    expect(off.state.mode).toBe("conversation");
  });

  it("is only 'stop dictation': the wake word and stop are words he dictates (LIVE-2240)", () => {
    const timings = { ...DEFAULT_TIMINGS, wakeWords: ["Freya"] };
    const start = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "dictator", at: 10 },
    ]);
    expect(start.state.mode).toBe("dictation");
    const typed = play([{ type: "utterance", text: "stop the tests", at: 20 }], start.state);
    expect(typed.effects).toContainEqual({ kind: "dictate", text: "stop the tests" });
    const word = reduceVoice(start.state, { type: "utterance", text: "Stop.", at: 30 }, timings);
    expect(word.state.mode).toBe("dictation");
    expect(word.effects).toContainEqual({ kind: "dictate", text: "Stop." });
    const namedStop = reduceVoice(
      start.state,
      { type: "utterance", text: "Freya, stop.", at: 30 },
      timings,
    );
    expect(namedStop.state.mode).toBe("dictation");
    expect(namedStop.effects).toContainEqual({ kind: "dictate", text: "Freya, stop." });
    for (const text of ["Stop dictation.", "Freya, stop dictating.", "stop dictating"]) {
      const stopped = reduceVoice(start.state, { type: "utterance", text, at: 30 }, timings);
      expect(stopped.state.mode).toBe("conversation");
      expect(stopped.effects.some((e) => e.kind === "dictate")).toBe(false);
    }
    // The wake word said mid-dictation is an ordinary word: it is typed with the rest.
    const named = reduceVoice(
      start.state,
      { type: "utterance", text: "Freya, see you Friday", at: 40 },
      timings,
    );
    expect(named.state.mode).toBe("dictation");
    expect(named.effects).toContainEqual({ kind: "dictate", text: "Freya, see you Friday" });
  });
});

describe("the name a sentence starts with", () => {
  it("is found exactly or as recognition writes it, and is none without a name", () => {
    const names = ["Freya", "Tessaya", "Alfred"];
    expect(namedWake("Alfred, open it", names)).toBe("Alfred");
    expect(namedWake("To say yeah, what time is it", names)).toBe("Tessaya");
    expect(namedWake("what time is it", names)).toBe(null);
    // 0.1.68: a US voice's "Tessaya" came back as these, and rode Freya's window.
    expect(namedWake("Teseat, what time is it?", names)).toBe("Tessaya");
    expect(namedWake("Teseot, what time is it?", names)).toBe("Tessaya");
    expect(stripWake("Teseat, what time is it?", names)).toBe("what time is it?");
    // A spelling of the name at the start only, as one word: "the seat" is not her.
    expect(namedWake("the seat, what time is it", names)).toBe(null);
  });

  it("keeps dictating through 'Tessa, stop.': in dictation the name is a word", () => {
    const timings = { ...DEFAULT_TIMINGS, wakeWords: ["Freya", "Tessaya"] };
    let state = initialVoiceState();
    for (const event of [
      { type: "set_dictation", on: true, at: 0 },
      { type: "utterance", text: "Tessa, stop.", at: 1_000 },
    ] as const)
      state = reduceVoice(state, event, timings).state;
    expect(state.mode).toBe("dictation");
  });

  it.each([
    // 0.1.72: David's "Tessaya" came back as these, fired Freya's model and ran as Freya.
    ["Tessiot, what time is it?", "Tessaya"],
    ["Tessayot what time is it?", "Tessaya"],
    ["Tessiah", "Tessaya"],
    // "Tessa" is a name of its own: it is her only when spoken to, by a comma, a question or a request after it.
    ["Tessa, what time is it?", "Tessaya"],
    ["Tessa what time is it", "Tessaya"],
    ["Tessa", "Tessaya"],
    ["Tessa said she would call me later", null],
    ["Tessa is coming at eight", null],
    ["Tessa's car is outside", null],
    ["Tess, can you send it", null],
    ["Tessie what time is it", null],
  ] as const)("reads %j as %s", (text, name) => {
    expect(namedWake(text, ["Freya", "Tessaya", "Alfred"])).toBe(name);
  });
});

describe("a name recognition wrote as other words", () => {
  const timings = { ...DEFAULT_TIMINGS, wakeWords: ["Tessaya", "Alfred"] };

  it("is still the name: 'To say yeah, dictate.' starts dictation from the conversation", () => {
    const talking = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "Hey Jarvis, what's on my screen?", at: 10 },
    ]);
    const { state } = reduceVoice(
      talking.state,
      { type: "utterance", text: "To say yeah, dictate.", at: 20 },
      timings,
    );
    expect(state.mode).toBe("dictation");
  });

  it("is not found in a sentence that only starts with a sound-alike ending on 'you'", () => {
    for (const said of ["To see you later, call me", "Nice to see you", "Free, you know"])
      expect(stripWake(said, ["Tessaya", "Freya"])).toBe(said);
    expect(stripWake("To say yeah, dictate.", ["Tessaya"])).toBe("dictate.");
    // One word must be the name or a listed spelling, not merely sound like it.
    const names = ["Tessaya", "Freya", "Alfred"];
    for (const said of ["Prayer time", "Frayed", "Fryer", "Alfred's car", "Half red"])
      expect(stripWake(said, names)).toBe(said);
    expect(stripWake("al fred, open it", names)).toBe("open it");
  });

  it("keeps a first word that only sounds like a name when dictation stops", () => {
    const start = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "dictate", at: 10 },
    ]);
    const { effects } = reduceVoice(
      start.state,
      { type: "utterance", text: "Frayed edges, stop dictating", at: 20 },
      { ...DEFAULT_TIMINGS, wakeWords: ["Freya"] },
    );
    expect(effects).toContainEqual({ kind: "dictate", text: "Frayed edges" });
  });

  it("is never cut from what he dictates", () => {
    const start = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "dictate", at: 10 },
    ]);
    const { effects } = reduceVoice(
      start.state,
      { type: "utterance", text: "Desire to win matters.", at: 20 },
      timings,
    );
    expect(effects).toContainEqual({ kind: "dictate", text: "Desire to win matters." });
  });
});

describe("a spoken cancel", () => {
  it("closes the window and drops what was waiting, with no wake word", () => {
    const { state } = play([
      { type: "wake", at: 0 },
      { type: "utterance", text: "never mind", at: 100 },
    ]);
    expect(state.mode).toBe("sleeping");
  });
});

describe("isLoneBreath", () => {
  it("drops only a hum or a breath, never a word he could mean", () => {
    for (const text of ["Um.", "uhh", "Mm-hm?", "Hmm", "er"])
      expect(isLoneBreath(text), text).toBe(true);
    for (const text of ["Yeah.", "Okay", "um, send it", "no", ""])
      expect(isLoneBreath(text), text).toBe(false);
  });
});
