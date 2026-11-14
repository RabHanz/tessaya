import { describe, expect, it } from "vite-plus/test";

import {
  rememberOutside,
  teachShouldLook,
  TEACH_LOOK_ANYWAY,
  captureSize,
  dangerousCommand,
  isPasteKeys,
  keysRefusal,
  missingDisplaysNote,
  pickSource,
  pointable,
  needsCaptureApproval,
  parseReply,
  parseScreenIntent,
  screenDifference,
  screensDifference,
  shotFor,
  toDesktop,
  type ScreenShot,
} from "./screenCompanion.ts";

// Two displays: a 2560×1440 laptop panel at 150 % (1707×960 DIP) left of a 1920×1080 monitor.
const laptop: ScreenShot = {
  screen: 1,
  width: 1280,
  height: 720,
  cursorHere: true,
  bounds: { x: 0, y: 0, width: 1707, height: 960 },
};
const monitor: ScreenShot = {
  screen: 2,
  width: 1280,
  height: 720,
  cursorHere: false,
  bounds: { x: 1707, y: 0, width: 1920, height: 1080 },
};
const shots = [laptop, monitor];

describe("parseReply", () => {
  it("takes farzaa's tag off the end and keeps the spoken text", () => {
    const r = parseReply(
      "see that source control menu up top? click that. [POINT:285,11:source control]",
    );
    expect(r.spoken).toBe("see that source control menu up top? click that.");
    expect(r.point).toEqual({
      x: 285,
      y: 11,
      label: "source control",
      screen: null,
      confidence: null,
    });
    expect(r.done).toBe(false);
  });

  it("reads the screen suffix and [POINT:none]", () => {
    expect(parseReply("over there [POINT:400,300:terminal:screen2]").point).toEqual({
      x: 400,
      y: 300,
      label: "terminal",
      screen: 2,
      confidence: null,
    });
    const none = parseReply("html is the skeleton of a page. [POINT:none]");
    expect(none.point).toBeNull();
    expect(none.spoken).toBe("html is the skeleton of a page.");
  });

  it("accepts a tag without a label, and the last of several", () => {
    expect(parseReply("[POINT:1,2] no wait [POINT:30,40:save]").point?.x).toBe(30);
    expect(parseReply("here [POINT:5,6]").point).toEqual({
      x: 5,
      y: 6,
      label: null,
      screen: null,
      confidence: null,
    });
  });

  it("marks a finished lesson", () => {
    const r = parseReply("that's it, you're exporting. tip: shift-e does it next time. [DONE]");
    expect(r.done).toBe(true);
    expect(r.spoken).not.toContain("[DONE]");
  });
});

describe("coordinates", () => {
  it("scales screenshot pixels to the display and offsets by its origin", () => {
    expect(toDesktop({ x: 640, y: 360 }, laptop)).toEqual({ x: 854, y: 480 });
    expect(toDesktop({ x: 0, y: 0 }, monitor)).toEqual({ x: 1707, y: 0 });
    expect(toDesktop({ x: 1280, y: 720 }, monitor)).toEqual({ x: 3627, y: 1080 });
  });

  it("clamps points outside the image", () => {
    expect(toDesktop({ x: 5000, y: -3 }, laptop)).toEqual({ x: 1707, y: 0 });
  });

  it("picks the named screen, else the cursor's", () => {
    expect(shotFor(shots, 2)).toBe(monitor);
    expect(shotFor(shots, null)).toBe(laptop);
    expect(shotFor(shots, 9)).toBe(laptop);
  });

  it("caps the long edge at 1568 and never upscales", () => {
    expect(captureSize(2560, 1440)).toEqual({ width: 1568, height: 882 });
    expect(captureSize(1080, 1920)).toEqual({ width: 882, height: 1568 });
    expect(captureSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("measures how much of the screen changed", () => {
    const a = new Uint8Array(100).fill(10);
    const b = a.slice();
    expect(screenDifference(a, b)).toBe(0);
    b.fill(200, 0, 25);
    expect(screenDifference(a, b)).toBe(0.25);
    expect(screenDifference(a, new Uint8Array(4))).toBe(1);
    // A change on either display counts in full, and a display appearing counts as everything.
    const quiet = new Uint8Array(4);
    expect(screensDifference([quiet, a], [quiet, b])).toBe(0.25);
    expect(screensDifference([quiet, a], [a])).toBe(1);
  });
});

describe("parseScreenIntent", () => {
  it.each([
    ["what's this error?", "look"],
    ["look at my screen and tell me what's wrong", "look"],
    ["where is the export button", "look"],
    ["look: why is this red", "look"],
    ["teach me how to make a pivot table", "teach"],
    ["show me how to add a filter", "teach"],
    ["walk me through setting up a webhook", "teach"],
    ["how do I export this step by step", "teach"],
    ["drive: rename this file to final", "drive"],
    ["take over and fill in the form", "drive"],
    ["can you open the downloads folder for me", "drive"],
    ["do it for me", "drive"],
  ])("%s → %s", (text, kind) => {
    expect(parseScreenIntent(text, false)?.kind).toBe(kind);
  });

  it.each([
    "show me the scheduler session",
    "what needs me?",
    "tell it: run the tests",
    "start a session on VantageOS",
    "next",
    "Look, can you tell the build session to rerun the tests?",
  ])("leaves %s to Baton's grammar", (text) => {
    expect(parseScreenIntent(text, false)).toBeNull();
  });

  it("takes next and repeat only while a lesson or drive runs, and a bare stop always", () => {
    expect(parseScreenIntent("next", true)).toEqual({ kind: "next" });
    expect(parseScreenIntent("I did it.", true)).toEqual({ kind: "next" });
    expect(parseScreenIntent("stop", true)).toEqual({ kind: "stop" });
    expect(parseScreenIntent("say that again", true)).toEqual({ kind: "repeat" });
    expect(parseScreenIntent("stop", false)).toEqual({ kind: "stop" });
    expect(parseScreenIntent("next", false)).toBeNull();
    expect(parseScreenIntent("stop the tests", false)).toBeNull();
  });
});

describe("pointing only at what it can vouch for", () => {
  it("takes a label with a colon in it and never leaves the tag in the words", () => {
    const reply = parseReply("It says 7:20. [POINT:1517,864:7:20 PM:screen1:0.9]");
    expect(reply.spoken).toBe("It says 7:20.");
    expect(reply.point).toMatchObject({ label: "7:20 PM", screen: 1, confidence: 0.9 });
  });

  it("reads confidence and refuses a low or missing one", () => {
    const sure = parseReply("There. [POINT:10,20:Save:screen2:0.9]").point;
    expect(sure).toMatchObject({ label: "Save", screen: 2, confidence: 0.9 });
    expect(pointable(sure)).toBe(true);
    expect(pointable(parseReply("Maybe. [POINT:10,20:Save:screen2:0.4]").point)).toBe(false);
    expect(pointable(parseReply("Old. [POINT:10,20:Save]").point)).toBe(false);
    expect(pointable(parseReply("I can't see one. [POINT:none]").point)).toBe(false);
  });
});

describe("needsCaptureApproval", () => {
  const base = { policy: "ask" as const, allowedUntil: 0, sessionApproved: false, now: 1000 };
  it("asks by default, and not inside an approved lesson, an hour's allowance, or always", () => {
    expect(needsCaptureApproval(base)).toBe(true);
    expect(needsCaptureApproval({ ...base, sessionApproved: true })).toBe(false);
    expect(needsCaptureApproval({ ...base, allowedUntil: 2000 })).toBe(false);
    expect(needsCaptureApproval({ ...base, policy: "always" })).toBe(false);
  });
});

describe("capture sources for two displays", () => {
  const sources = [{ display_id: "11" }, { display_id: "22" }];
  it("finds the second display by its id, and by position where the system reports none", () => {
    expect(pickSource(sources, 22, 0)).toEqual({ display_id: "22" });
    expect(pickSource([{ display_id: "" }, { display_id: "" }], 99, 1)).toEqual({ display_id: "" });
    expect(pickSource(sources, 33, 2)).toBeUndefined();
  });
  it("says so when a display gave no picture", () => {
    expect(missingDisplaysNote(2, 2)).toBeNull();
    expect(missingDisplaysNote(1, 2)).toContain("Only 1 of 2 displays");
  });
});

describe("a waiting lesson looks only after the desktop changed", () => {
  it("looks on a change, stays still while nothing changes, and looks anyway now and then", () => {
    let state = teachShouldLook({ seen: null, quiet: 0 }, 5);
    expect(state.look).toBe(true);
    const looks: boolean[] = [];
    for (let i = 0; i < TEACH_LOOK_ANYWAY; i += 1) {
      state = teachShouldLook(state, 5);
      looks.push(state.look);
    }
    expect(looks.filter(Boolean)).toHaveLength(1);
    expect(looks.at(-1)).toBe(true);
    expect(teachShouldLook(state, 6).look).toBe(true);
    // No sidecar count: every poll looks, as on macOS and Linux.
    expect(teachShouldLook({ seen: null, quiet: 0 }, null).look).toBe(true);
    expect(teachShouldLook({ seen: null, quiet: 3 }, null).look).toBe(true);
  });
});

describe("keys are judged when they are sent, not only when they were allowed", () => {
  const notepad = { window: 1, label: "notepad.exe: notes.txt", shell: false };
  const shell = { window: 2, label: "powershell.exe: Windows PowerShell", shell: true };
  const send = (over: Partial<Parameters<typeof keysRefusal>[0]>) =>
    keysRefusal({ allowed: notepad, now: notepad, paste: false, clipboard: null, ...over });

  it("sends into the window they were allowed for", () => {
    expect(send({})).toBeNull();
    expect(send({ allowed: null })).toBeNull();
  });

  it("stops when he switched windows since, or when it cannot tell where they go", () => {
    expect(send({ now: { window: 3, label: "notepad.exe: other.txt" } })).toMatch(/changed/);
    expect(send({ now: null })).toMatch(/couldn't tell/);
    // No handles on this platform: the title decides.
    expect(send({ allowed: { label: "a", shell: false }, now: { label: "b" } })).toMatch(/changed/);
  });

  it("reaches a command line only when that was the window allowed, and never pastes into one", () => {
    expect(send({ allowed: null, now: shell })).toMatch(/command line/);
    expect(send({ allowed: shell, now: shell })).toBeNull();
    // Her own click landed in a command line: the window moved along, the agreement did not.
    expect(send({ allowed: { ...shell, shell: false }, now: shell })).toMatch(/command line/);
    expect(send({ allowed: shell, now: shell, paste: true })).toMatch(/paste into a command line/);
    // An editor that can hold a terminal is not one.
    expect(send({ allowed: null, now: { window: 4, label: "Code.exe: main.ts" } })).toBeNull();
  });

  it("pastes only while the clipboard holds what it held when he said yes", () => {
    const allowed = { ...notepad, clipboard: "hello" };
    expect(send({ allowed, paste: true, clipboard: "hello" })).toBeNull();
    expect(send({ allowed, paste: true, clipboard: "rm -rf ~" })).toMatch(/clipboard changed/);
    expect(send({ allowed, paste: false, clipboard: "anything" })).toBeNull();
  });

  it("knows the paste chords", () => {
    expect(isPasteKeys(["ctrl", "v"])).toBe(true);
    expect(isPasteKeys(["Shift", "Insert"])).toBe(true);
    expect(isPasteKeys(["ctrl", "c"])).toBe(false);
  });

  it("reads a long command line in linear time", () => {
    // Quadratic, this took half a minute and the test would time out.
    expect(dangerousCommand("del ".repeat(10_000))).toBe(false);
  });
});

describe("words that are not his", () => {
  it("are remembered, the oldest dropped past the cap", () => {
    const said = new Set<string>();
    for (const t of ["a", "b", "c"]) rememberOutside(said, t, 2);
    expect([...said]).toEqual(["b", "c"]);
  });
});
