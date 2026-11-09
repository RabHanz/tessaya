import { describe, expect, it } from "vite-plus/test";

import {
  dictationCaption,
  frameLevel,
  createSpeechGain,
  IDLE_TURN,
  isCancelPhrase,
  reduceTurn,
  isDismissPhrase,
  turnHoldsEscape,
  turnLimitMs,
  turnView,
  type TurnEvent,
  type TurnState,
} from "./voiceTurn.ts";

const play = (events: ReadonlyArray<TurnEvent>, start: TurnState = IDLE_TURN) =>
  events.reduce(reduceTurn, start);

describe("the cue after a wake word", () => {
  it("goes listening, thinking, speaking, then away by itself", () => {
    const afterWake = play([{ type: "wake", word: "Alfred" }]);
    expect(afterWake.phase).toBe("listening");
    const heard = reduceTurn(afterWake, { type: "heard", text: "what needs me" });
    expect(heard).toMatchObject({ phase: "thinking", caption: "what needs me" });
    const speaking = reduceTurn(heard, { type: "speaking", active: true });
    expect(speaking.phase).toBe("speaking");
    const after = reduceTurn(speaking, { type: "speaking", active: false });
    expect(after.phase).toBe("listening");
  });

  it("says plainly that the wake word is needed when nothing was heard", () => {
    const state = play([{ type: "wake", word: null }, { type: "window_closed" }]);
    expect(turnView(state)).toMatchObject({
      label: "Didn't catch that",
      caption: "Say the wake word",
    });
  });

  it("does not call a heard turn a failure when its window closes", () => {
    const state = play([
      { type: "wake", word: null },
      { type: "heard", text: "hi" },
      { type: "window_closed" },
    ]);
    expect(state.phase).toBe("thinking");
  });

  it("clears on dismissal from any phase", () => {
    const closed: ReadonlyArray<TurnEvent> = [
      { type: "wake", word: null },
      { type: "dismissed" },
      { type: "window_closed" },
      { type: "dismissed" },
    ];
    expect(play(closed).phase).toBe("idle");
  });

  it("shows nothing at rest, whatever arrives", () => {
    expect(play([{ type: "heard", text: "background" }]).phase).toBe("idle");
    expect(play([{ type: "failed", message: "x" }]).phase).toBe("idle");
  });

  it("clears a turn that ends with nothing to say", () => {
    const state = play([
      { type: "wake", word: null },
      { type: "heard", text: "stop" },
      { type: "finished" },
    ]);
    expect(state.phase).toBe("listening");
  });

  it("keeps speech on screen until it finishes", () => {
    const state = play([
      { type: "wake", word: null },
      { type: "speaking", active: true },
      { type: "finished" },
    ]);
    expect(state.phase).toBe("speaking");
  });
});

describe("the pill while a window is open", () => {
  const open: ReadonlyArray<TurnEvent> = [
    { type: "wake", word: "Alfred" },
    { type: "heard", text: "what's this" },
  ];

  it("goes back to Listening after each thing while the window is open", () => {
    let state = play([...open, { type: "speaking", active: true }]);
    expect(turnView(state)?.label).toBe("Speaking");
    state = reduceTurn(state, { type: "speaking", active: false });
    expect(turnView(state)?.label).toBe("Listening");
    state = play([{ type: "activity", label: "Looking" }], state);
    expect(turnView(state)?.label).toBe("Looking");
    state = reduceTurn(state, { type: "activity", label: null });
    expect(turnView(state)?.label).toBe("Listening");
    expect(reduceTurn(state, { type: "dismissed" }).phase).toBe("idle");
  });

  it("shows Finishing from the end of his speech, then the words, and a closed window's end once", () => {
    let state = play([{ type: "wake", word: "Alfred" }, { type: "thinking" }]);
    expect(turnView(state)).toMatchObject({ label: "Finishing" });
    state = reduceTurn(state, { type: "heard", text: "what needs me" });
    expect(turnView(state)).toMatchObject({ label: "Thinking", caption: "what needs me" });
    state = reduceTurn(state, { type: "window_closed" });
    state = reduceTurn(state, { type: "finished" });
    expect(turnView(state)).toMatchObject({ label: "Not listening", caption: "Say the wake word" });
    expect(turnLimitMs(state.phase)).toBeLessThan(turnLimitMs("listening"));
    expect(reduceTurn(state, { type: "dismissed" }).phase).toBe("idle");
    // A follow-up in a window that stayed open shows Finishing too, with no wake word.
    expect(play([{ type: "thinking" }]).phase).toBe("thinking");
  });

  it("recognises a spoken cancel once the wake word is stripped", () => {
    for (const said of ["cancel", "Never mind.", "scratch that", "forget it", "cancel that!"]) {
      expect(isCancelPhrase(said)).toBe(true);
    }
    for (const said of ["cancel the build", "what's the weather", "don't cancel it"]) {
      expect(isCancelPhrase(said)).toBe(false);
    }
  });

  it("shows the end after speech when the window closed under it", () => {
    const state = play([
      ...open,
      { type: "speaking", active: true },
      { type: "window_closed" },
      { type: "speaking", active: false },
    ]);
    expect(state.phase).toBe("ended");
  });

  it("leaves when words were set aside", () => {
    expect(play([...open, { type: "resume" }]).phase).toBe("listening");
  });

  it("says Didn't catch that for an unconfirmed wake only while Listening", () => {
    const listening = play([{ type: "wake", word: "Tessaya" }, { type: "unconfirmed" }]);
    expect(turnView(listening)).toMatchObject({ label: "Didn't catch that" });
    expect(play([...open, { type: "unconfirmed" }]).phase).toBe("listening");
    const speaking = play([...open, { type: "speaking", active: true }, { type: "unconfirmed" }]);
    expect(speaking.phase).toBe("speaking");
    expect(play([{ type: "unconfirmed" }]).phase).toBe("idle");
  });

  it("holds Dictating through each chunk, and leaves after", () => {
    let state = play([...open, { type: "dictating", caption: "Say stop dictating" }]);
    expect(turnView(state)?.wave).toBe("live");
    // Writing it out or tidying sweeps, so the main process stops reading bands from the microphone.
    const tidying = reduceTurn(state, { type: "dictating", caption: "Tidying…", tidying: true });
    expect(turnView(tidying)?.wave).toBe("sweep");
    expect(turnView(reduceTurn(tidying, { type: "dictating", caption: "Pasted" }))?.wave).toBe(
      "live",
    );
    state = play(
      [
        { type: "heard", text: "Dear Sam" },
        { type: "thinking" },
        { type: "done", label: "typed" },
        { type: "finished" },
      ],
      state,
    );
    expect(turnView(state)).toMatchObject({ label: "Dictating", caption: "typed" });
    expect(reduceTurn(state, { type: "wake", word: "Alfred" }).phase).toBe("dictating");
    state = reduceTurn(state, { type: "dictating", caption: null });
    expect(state.phase).toBe("listening");
  });

  it("stays Dictating through her voice, her work, a dismissal or a failure, until dictation itself ends (LIVE-2240)", () => {
    const start = play([...open, { type: "dictating", caption: "Into Notepad" }]);
    for (const event of [
      { type: "speaking", active: true },
      { type: "speaking", active: false },
      { type: "activity", label: "Looking" },
      { type: "dismissed" },
      { type: "failed", message: "Didn't catch that" },
      { type: "window_closed" },
      { type: "finished" },
    ] as const)
      expect(reduceTurn(start, event).phase).toBe("dictating");
    expect(reduceTurn(start, { type: "trouble", message: "Mic gone" }).phase).toBe("error");
    expect(reduceTurn(start, { type: "dictating", caption: null }).phase).toBe("listening");
  });

  it.each([
    ["Notepad", "", 'Into Notepad · say "stop dictation"'],
    [null, "", 'Say "stop dictation" to insert'],
    ["Notepad", "Dear Sam", "Into Notepad · Dear Sam"],
    ["Notepad", "one two three four five six seven", "Into Notepad · …three four five six seven"],
  ] as const)("captions dictation into %s with %j", (into, said, caption) => {
    expect(dictationCaption(into, said)).toBe(caption);
  });

  it("leaves when a dismissal ends a spoken turn", () => {
    const state = play([...open, { type: "speaking", active: true }, { type: "dismissed" }]);
    expect(state.phase).toBe("idle");
  });
});

describe("the pill's other states", () => {
  it("names the word that woke it, then what it heard", () => {
    const woken = play([{ type: "wake", word: "Freya" }]);
    expect(turnView(woken)).toMatchObject({ label: "Listening", caption: "Freya" });
    expect(turnView(reduceTurn(woken, { type: "heard", text: "what's this" }))).toMatchObject({
      label: "Thinking",
      caption: "what's this",
    });
  });

  it("says so when the microphone is dead, without ending the turn", () => {
    const state = play([{ type: "wake", word: null }, { type: "silent" }]);
    expect(state.phase).toBe("listening");
    expect(state.caption).toContain("Not hearing");
  });

  it("shows a typed answer's speech and work with no wake word", () => {
    expect(play([{ type: "speaking", active: true }]).phase).toBe("speaking");
    const driving = play([{ type: "activity", label: "Driving", caption: "Step 1 of 3" }]);
    expect(turnView(driving)).toMatchObject({ label: "Driving", caption: "Step 1 of 3" });
    expect(reduceTurn(driving, { type: "activity", label: null }).phase).toBe("idle");
  });

  it("raises trouble with no turn running, briefly confirms, and goes", () => {
    const trouble = play([{ type: "trouble", message: "Mic reconnecting" }]);
    expect(turnView(trouble)?.label).toBe("Mic reconnecting");
    expect(turnLimitMs("error")).toBeLessThan(turnLimitMs("listening"));
    expect(play([{ type: "done", label: "Pasted" }]).label).toBe("Pasted");
  });

  it("does not let a voice turn end dictation or a mute", () => {
    expect(play([{ type: "dictating", caption: "Esc cancels" }, { type: "finished" }]).phase).toBe(
      "dictating",
    );
  });
});

describe("who gets Esc", () => {
  it("is his apps' unless Baton's voice window is up", () => {
    for (const phase of ["listening", "thinking", "speaking", "working"] as const) {
      expect(turnHoldsEscape({ ...IDLE_TURN, phase })).toBe(true);
    }
    for (const phase of ["idle", "done", "error", "ended", "muted"] as const) {
      expect(turnHoldsEscape({ ...IDLE_TURN, phase })).toBe(false);
    }
  });

  it("is taken when the window opens and given back when it is dismissed or closes", () => {
    const held = (events: ReadonlyArray<TurnEvent>) => turnHoldsEscape(play(events));
    const open: ReadonlyArray<TurnEvent> = [
      { type: "wake", word: null },
      { type: "heard", text: "hi" },
    ];
    expect(held(open)).toBe(true);
    expect(
      held([...open, { type: "speaking", active: true }, { type: "speaking", active: false }]),
    ).toBe(true);
    expect(held([...open, { type: "dismissed" }])).toBe(false);
    expect(held([...open, { type: "window_closed" }, { type: "finished" }])).toBe(false);
  });
});

describe("dismissal read whole", () => {
  const dismiss = [
    "stop",
    "Stop.",
    "dismiss",
    "Nothing, dismiss.",
    "never mind",
    "Never mind.",
    "That's all, thanks",
    "Okay, that will be all tanks.",
    "Okay, thanks, that will be all.",
    "Scratch that, that's all.",
    "that'll be all",
    "no thanks",
    "goodbye",
    "thank you",
  ];
  const asks = [
    "tell me how to stop a Windows service",
    "that's all I wanted to add, now write it up",
    "can you stop the server",
    "thanks, now open the settings",
    "nothing here works, dismiss all the windows",
    "stop the tests",
    "okay",
    "what's on my screen",
    "no I meant the other one",
    "",
  ];
  it.each(dismiss)("ends on %j with no model", (said) => expect(isDismissPhrase(said)).toBe(true));
  it.each(asks)("leaves %j to the assistant", (said) => expect(isDismissPhrase(said)).toBe(false));
});

describe("frameLevel", () => {
  it("is zero for silence and capped for a full frame", () => {
    expect(frameLevel(new Int16Array(160))).toBe(0);
    expect(frameLevel(new Int16Array(160).fill(32767))).toBe(1);
  });
  it("normalises to his own speech: a -41 dBFS and a -12 dBFS speaker fill the bars alike, and pauses fall back", () => {
    // A frame's level from its peak in dBFS, as frameLevel gives it.
    const level = (db: number) => 1.4 * Math.sqrt(10 ** (db / 20));
    // Syllables around his median, with pauses, over a room 26 dB under his speech.
    const syllables = [0, -4, 3, -8, -2, 5, -6, -12, 1, -3];
    const talk = (median: number, floor: number) =>
      Array.from({ length: 400 }, (_, i) =>
        i % 40 < 30 ? median + syllables[i % syllables.length]! : floor + ((i * 7) % 5) - 2,
      );
    const run = (median: number) => {
      const gain = createSpeechGain();
      const frames = talk(median, median - 26);
      const shown = frames.map((db) => gain(level(db)));
      const speech = shown.slice(200).filter((_, i) => (i + 200) % 40 < 30);
      const sorted = [...speech].sort((a, b) => a - b);
      return {
        mean: speech.reduce((s, x) => s + x, 0) / speech.length,
        p90: sorted[Math.floor(sorted.length * 0.9)]!,
        pinned: speech.filter((x) => x >= 1).length / speech.length,
        // The last pause, 10 frames in.
        pause: shown[399]!,
      };
    };
    const quiet = run(-41);
    const hot = run(-12);
    expect(Math.abs(quiet.mean - hot.mean)).toBeLessThan(0.1);
    expect(Math.abs(quiet.p90 - hot.p90)).toBeLessThan(0.1);
    // Lively, never flat, never pinned at the top.
    expect(quiet.mean).toBeGreaterThan(0.5);
    expect(hot.pinned).toBeLessThan(0.3);
    expect(quiet.pause).toBeLessThan(0.1);
    expect(hot.pause).toBeLessThan(0.1);
    // The room alone, a few dB either way, never lifts the bars.
    const room = createSpeechGain();
    const roomShown = Array.from({ length: 200 }, (_, i) => room(level(-67 + ((i * 3) % 7) - 3)));
    expect(Math.max(...roomShown.slice(20))).toBe(0);
  });
});
