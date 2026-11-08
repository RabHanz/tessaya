import { describe, expect, it } from "vite-plus/test";

import {
  beforeSpokenStop,
  classifyDictation,
  isBareStop,
  keyDictationCommand,
  staysLocal,
} from "./dictation.ts";

const idle = { dictating: false };
const on = { dictating: true };

describe("classifyDictation", () => {
  it("takes the specification's own dictation sentence", () => {
    // §14's worked example: the user is in Gmail compose and says this.
    const command = classifyDictation(
      "Dictate: Thanks, I'll send the revised version tomorrow.",
      idle,
    );
    expect(command.kind).toBe("start");
    if (command.kind !== "start") return;
    // The words go into somebody's email, so they keep their capitals.
    expect(command.text).toBe("Thanks, I'll send the revised version tomorrow.");
  });

  it("drops the full stop speech-to-text puts after the command", () => {
    // Speech-to-text hears "dictate. Thanks, …" (wake word already stripped); the "." must not be pasted.
    const command = classifyDictation("Dictate. Thanks, I will send it.", idle);
    expect(command).toEqual({ kind: "start", text: "Thanks, I will send it." });
  });

  it("starts with no text when the user only asks for the mode", () => {
    const command = classifyDictation("dictate", idle);
    expect(command).toEqual({ kind: "start", text: null });
  });

  it("stops on the specification's phrase, in either mode", () => {
    expect(classifyDictation("stop dictating", on).kind).toBe("stop");
    expect(classifyDictation("Stop dictating.", idle).kind).toBe("stop");
    expect(classifyDictation("I'm done dictating", on).kind).toBe("stop");
    expect(classifyDictation("end dictation please", on).kind).toBe("stop");
  });

  it("keeps a stop phrase unmistakable", () => {
    for (const words of ["stop", "I'm done", "finish the report", "stop dictating the letter"]) {
      expect(classifyDictation(words, on)).toEqual({ kind: "text", text: words });
    }
  });

  it("types what came before the stop phrase in the same breath", () => {
    expect(classifyDictation("See you Friday. Stop dictating.", on)).toEqual({
      kind: "stop",
      text: "See you Friday.",
    });
  });

  it("starts on the ways he says it", () => {
    for (const words of ["I want to dictate", "let me dictate", "start dictation"]) {
      expect(classifyDictation(words, idle)).toEqual({ kind: "start", text: null });
    }
  });

  it("treats ordinary speech as text while the mode is on, and as an instruction when it is off", () => {
    // §12.3: dictation and agent routing must stay distinguishable, and the
    // mode is what distinguishes them.
    expect(classifyDictation("what needs me", idle)).toEqual({ kind: "not_dictation" });
    expect(classifyDictation("What needs me", on)).toEqual({
      kind: "text",
      text: "What needs me",
    });
  });

  it("keeps dictated words on the client", () => {
    // The rule this module exists for: an environment has no business
    // receiving the contents of somebody's email.
    expect(staysLocal(classifyDictation("dictate: the contract is attached", idle))).toBe(true);
    expect(staysLocal(classifyDictation("hello there", on))).toBe(true);
    expect(staysLocal(classifyDictation("tell claude to run the tests", idle))).toBe(false);
  });

  it("does not mistake a sentence about dictation for dictation", () => {
    for (const said of [
      "tell claude the dictation is broken",
      "Dictation is broken, can you look at it?",
      "Dictation apps, which one's best?",
      "Dictate a reply to Sam saying I'm late.",
    ]) {
      expect(classifyDictation(said, idle).kind, said).toBe("not_dictation");
    }
  });

  it("is case-insensitive and tolerates curly apostrophes", () => {
    const command = classifyDictation("DICTATE — I’ll be late", idle);
    expect(command.kind).toBe("start");
  });
});

describe("how he actually says it (voice-turns, 1 Nov)", () => {
  it("starts on mis-hearings and stated intent, only as the whole utterance", () => {
    for (const said of [
      "Dictator.",
      "I meant to dictate.",
      "I want to dictate",
      "dick tate",
      "dictation mode",
      "start dictation",
      "take dictation",
      "let's dictate",
      "can you dictate",
      "dictate this",
      "go into dictation",
      "switch to dictation",
      "dictated",
      "Dictates.",
    ]) {
      expect(classifyDictation(said, idle)).toEqual({ kind: "start", text: null });
    }
    for (const said of ["the dictator of Rome", "I read about a dictator yesterday"]) {
      expect(classifyDictation(said, idle).kind).toBe("not_dictation");
    }
  });

  it("knows a bare stop, and never takes a longer phrase for one", () => {
    for (const said of ["Stop", "stop.", "please stop", "never mind", "Be quiet."]) {
      expect(isBareStop(said)).toBe(true);
    }
    for (const said of [
      "stop dictating",
      "stop the tests",
      "stop the build please",
      "don't stop",
    ]) {
      expect(isBareStop(said)).toBe(false);
    }
  });
});

describe("a spoken command during a key or button dictation", () => {
  it("is only a whole stop dictation: cancels and corrections are his words", () => {
    expect(keyDictationCommand("Stop dictation.")).toBe("stop");
    expect(keyDictationCommand("stop dictating")).toBe("stop");
    // Nothing spoken discards: these stay text, and the clean-up resolves a self-correction.
    for (const words of ["cancel", "Cancel that.", "scratch that", "no wait", "never mind"])
      expect(keyDictationCommand(words)).toBeNull();
    expect(keyDictationCommand("we should stop the build")).toBeNull();
    expect(keyDictationCommand("")).toBeNull();
  });

  it("is taken off what was pasted, with anything said after it", () => {
    expect(beforeSpokenStop("Send the report today. Stop dictation.")).toBe(
      "Send the report today.",
    );
    expect(beforeSpokenStop("Send the report, stop dictation, thanks")).toBe("Send the report");
    expect(beforeSpokenStop("Send the report today")).toBe("Send the report today");
    // Dictated content that says cancel or scratch that is kept as it is.
    expect(beforeSpokenStop("Cancel the order, scratch that, move it to Friday")).toBe(
      "Cancel the order, scratch that, move it to Friday",
    );
  });

  it("keeps his case, apostrophes and lines when stop dictation ends the words", () => {
    expect(
      classifyDictation("Don’t send it\nyet, Sam. Stop dictation.", { dictating: true }),
    ).toEqual({
      kind: "stop",
      text: "Don’t send it\nyet, Sam.",
    });
    expect(classifyDictation("Call  Ana  now stop dictation", { dictating: true })).toEqual({
      kind: "stop",
      text: "Call  Ana  now",
    });
  });
});
