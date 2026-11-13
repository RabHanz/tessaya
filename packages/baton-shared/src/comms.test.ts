import { describe, expect, it } from "vite-plus/test";

import type { CommsNote } from "@t3tools/baton-contracts";

import {
  breaksQuiet,
  commsCaps,
  fallbackForms,
  inQuietHours,
  noteCardOf,
  parseAddress,
  renderNote,
  trimForms,
} from "./comms.ts";

const note = (over: Partial<CommsNote> = {}): CommsNote => ({
  id: "n1",
  kind: "text",
  from: "sara",
  fromLabel: "Sara",
  fromVessel: null,
  to: ["person:omid"],
  text: "I'm running late",
  forms: {
    glance: { emoji: "⏰", words: "Running late" },
    spoken: "From Sara: I'm running late",
    mood: "neutral",
  },
  urgency: "normal",
  private: false,
  replyTo: null,
  tag: null,
  audio: null,
  createdAt: "2026-11-14T00:00:00.000Z",
  deliverAt: null,
  expiresAt: null,
  ...over,
});
const device = (kind: string, values: Record<string, unknown> = {}) => ({
  kind,
  values: Object.entries(values).map(([itemId, value]) => ({ itemId, value, at: "" })),
});
const shared = { personal: false, forName: "Omid" };
const own = { personal: true, forName: "Omid" };

describe("comms addresses and forms", () => {
  it("parses every address kind and refuses anything else", () => {
    expect(parseAddress("all")).toEqual({ kind: "all" });
    expect(parseAddress("person:Sara")).toEqual({ kind: "person", id: "sara" });
    expect(parseAddress("group:kids")).toEqual({ kind: "group", id: "kids" });
    expect(parseAddress("room:living-room")).toEqual({ kind: "room", id: "living-room" });
    expect(parseAddress("vessel:r1-3d57b3")).toEqual({ kind: "vessel", id: "r1-3d57b3" });
    for (const bad of ["", "sara", "person:", "person:a b", "team:x", "person:a:b"])
      expect(parseAddress(bad)).toBeNull();
  });

  it("falls back to the first emoji and four words, and caps a model's glance", () => {
    expect(fallbackForms("Dinner 🍽️ is ready, come down now", "Mum")).toEqual({
      glance: { emoji: "🍽️", words: "Dinner is ready, come" },
      spoken: "From Mum: Dinner 🍽️ is ready, come down now",
      mood: "neutral",
    });
    expect(fallbackForms("on my way", "Sara").glance.emoji).toBe("💬");
    expect(
      trimForms({
        glance: { emoji: "not an emoji", words: "one two three four five" },
        spoken: "x",
        mood: "happy",
      }).glance,
    ).toEqual({ emoji: "💬", words: "one two three four" });
  });
});

describe("commsCaps", () => {
  it("takes a manifest's values over its kind's defaults; an unknown kind can do nothing", () => {
    expect(commsCaps(device("r1")).display).toBe("eyes-round");
    // The R1's live light is not firmware-locked yet: no mic opens to a person until its manifest says so.
    expect(commsCaps(device("r1")).live).toBeNull();
    expect(
      commsCaps(device("r1", { "live.indicator": "eyes+led", "audio.aec": "full" })),
    ).toMatchObject({
      live: ["eyes", "led"],
      aec: "full",
    });
    expect(commsCaps(device("r1", { "live.indicator": "blink" })).live).toBeNull();
    expect(commsCaps(device("r1", { "live.indicator": "eyes+blink" })).live).toBeNull();
    expect(commsCaps(device("phone")).push).toBe(true);
    expect(commsCaps(device("toaster"))).toMatchObject({
      display: "none",
      audioOut: false,
      live: null,
    });
    expect(
      commsCaps(device("toaster", { "audio.out": true, "display.kind": "led" })),
    ).toMatchObject({ display: "led", audioOut: true });
  });
});

describe("renderNote", () => {
  const r1 = commsCaps(device("r1"));
  const phone = commsCaps(device("phone"));
  const desktop = commsCaps(device("desktop"));
  const speaker = commsCaps(device("speaker", { "audio.out": true }));
  const unknown = commsCaps(device("toaster"));

  it.each([
    [
      "R1",
      r1,
      shared,
      { sound: "message", voice: { say: "From Sara: I'm running late" }, push: null },
    ],
    [
      "phone",
      phone,
      own,
      { sound: "message", voice: null, push: { title: "Sara", body: "⏰ I'm running late" } },
    ],
    ["desktop", desktop, own, { sound: "message", voice: null, push: null }],
    [
      "speaker only",
      speaker,
      shared,
      { sound: "message", voice: { say: "From Sara: I'm running late" }, card: null },
    ],
    [
      "unknown",
      unknown,
      shared,
      { sound: "message", voice: null, eyes: null, card: null, push: null },
    ],
  ] as const)("%s", (_name, caps, context, expected) => {
    expect(renderNote(note(), caps, context)).toMatchObject(expected);
  });

  it("shows the R1 who sent it and the glance", () => {
    expect(renderNote(note(), r1, shared).eyes).toMatchObject({
      initial: "S",
      emoji: "⏰",
      words: "Running late",
    });
  });

  it("plays the sender's own recording for a voice note", () => {
    expect(renderNote(note({ kind: "voice", audio: "clip-1" }), r1, shared).voice).toEqual({
      clip: "clip-1",
    });
  });

  it("holds a private note's body on a shared vessel until that voice is verified there", () => {
    const held = renderNote(note({ private: true }), r1, shared);
    expect(held).toMatchObject({ held: true, voice: { say: "A message for Omid from Sara." } });
    expect(renderNote(note({ private: true }), r1, { ...shared, verified: true }).held).toBe(false);
    expect(renderNote(note({ private: true }), phone, own).held).toBe(false);
  });

  it("rings urgent, announces a broadcast aloud, and keeps a reaction silent", () => {
    expect(renderNote(note({ urgency: "urgent" }), r1, shared).sound).toBe("ring_urgent");
    expect(renderNote(note({ kind: "announce" }), desktop, own)).toMatchObject({
      sound: "announce",
      voice: { say: "From Sara: I'm running late" },
    });
    expect(renderNote(note({ kind: "reaction", text: "❤️" }), r1, shared)).toMatchObject({
      sound: null,
      voice: null,
    });
  });

  it("plays a long note's first sentence on a shared vessel and offers the rest", () => {
    const spoken = `From Sara: The car is outside. ${"word ".repeat(60)}`;
    const long = note({ forms: { ...note().forms, spoken } });
    expect(renderNote(long, r1, shared).voice).toEqual({
      say: "From Sara: The car is outside. Want the rest?",
    });
  });
});

describe("quiet hours", () => {
  // 2026-11-14 17:30 UTC is 22:30 in Karachi (GMT+5) and 17:30 in London.
  const at = Date.UTC(2026, 10, 14, 17, 30);
  it("reads the window in its own zone and wraps past midnight", () => {
    expect(inQuietHours(at, { from: "22:00", to: "07:00", timeZone: "Asia/Karachi" })).toBe(true);
    expect(inQuietHours(at, { from: "22:00", to: "07:00", timeZone: "Europe/London" })).toBe(false);
    expect(inQuietHours(at, { from: "13:00", to: "18:00", timeZone: "Europe/London" })).toBe(true);
    expect(inQuietHours(at, null)).toBe(false);
    expect(inQuietHours(at, { from: "22:00", to: "07:00", timeZone: "Nowhere/Else" })).toBe(false);
  });
  it("lets only an adult's urgent note through", () => {
    expect(breaksQuiet("urgent", "adult")).toBe(true);
    expect(breaksQuiet("urgent", "owner")).toBe(true);
    expect(breaksQuiet("urgent", "child")).toBe(false);
    expect(breaksQuiet("soon", "owner")).toBe(false);
  });
});

describe("noteCardOf", () => {
  it("reads a rendered note's card and sound, and refuses anything else", () => {
    const plan = renderNote(note(), commsCaps(device("desktop")), own);
    expect(noteCardOf({ id: "n1", plan })).toEqual({
      id: "n1",
      title: "Sara",
      body: "I'm running late",
      emoji: "⏰",
      sound: "message",
    });
    expect(noteCardOf({ id: "n1", plan: { ...plan, sound: "boom" } })?.sound).toBeNull();
    for (const bad of [
      null,
      "x",
      { id: 1, plan },
      { id: "n1" },
      { id: "n1", plan: { card: null } },
    ])
      expect(noteCardOf(bad)).toBeNull();
  });
});
