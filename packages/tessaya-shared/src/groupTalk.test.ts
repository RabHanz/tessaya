import { describe, expect, it } from "vite-plus/test";

import {
  addressedIn,
  atSpeakerMark,
  CHOICE_FLOOR,
  groupLine,
  nextStep,
  speakerMark,
  SPEAKERS_PER_TURN,
  stepFromChoice,
  type GroupPersona,
  type PersonaGroup,
} from "./groupTalk.ts";

const personas: ReadonlyArray<GroupPersona> = [
  { id: "freya", name: "Freya", role: "his wellbeing", traits: { sass: 0.3, warmth: 0.9 } },
  { id: "luna", name: "Luna", role: "a sarcastic film buff", traits: { sass: 0.9, play: 0.8 } },
  { id: "onyx", name: "Onyx", role: "servers and builds" },
];
const group = (mode: PersonaGroup["mode"], silent: ReadonlyArray<string> = []): PersonaGroup => ({
  mode,
  members: personas.map((p) => ({ id: p.id, ...(silent.includes(p.id) ? { silent: true } : {}) })),
});

describe("addressedIn", () => {
  it("finds who he speaks to, in order, and not a name he only mentions", () => {
    expect(addressedIn("Freya, what do you think?", group("answer"), personas)).toEqual(["freya"]);
    expect(addressedIn("what do you think, Luna?", group("answer"), personas)).toEqual(["luna"]);
    expect(addressedIn("Luna and Freya, settle this.", group("answer"), personas)).toEqual([
      "luna",
      "freya",
    ]);
    expect(addressedIn("I told Freya about it yesterday", group("answer"), personas)).toEqual([]);
  });
});

describe("nextStep", () => {
  it("answers who he named first, even a silent member, then stops in answer mode", () => {
    const g = group("answer", ["onyx"]);
    const text = "Onyx, is the build green?";
    expect(nextStep({ group: g, personas, text, spoken: [] })).toEqual({ next: "onyx" });
    expect(nextStep({ group: g, personas, text, spoken: [{ id: "onyx", said: "Yes." }] })).toEqual({
      stop: "done",
    });
  });

  it("asks the cheap model only among members who speak, never the one who just did", () => {
    const g = group("watch", ["onyx"]);
    expect(nextStep({ group: g, personas, text: "Thoughts?", spoken: [] })).toEqual({
      ask: ["freya", "luna"],
    });
    // One candidate left after Freya spoke: still a choice, since "end" is one too.
    expect(
      nextStep({ group: g, personas, text: "Thoughts?", spoken: [{ id: "freya", said: "Hi." }] }),
    ).toEqual({ ask: ["luna"] });
  });

  it("stops at the speaker budget and at the token budget", () => {
    const g = group("watch");
    const many = Array.from({ length: SPEAKERS_PER_TURN.watch }, (_, i) => ({
      id: i % 2 === 0 ? "freya" : "luna",
      said: "ok",
    }));
    expect(nextStep({ group: g, personas, text: null, spoken: many })).toEqual({ stop: "budget" });
    expect(
      nextStep({
        group: g,
        personas,
        text: null,
        spoken: [{ id: "luna", said: "x".repeat(5_000) }],
      }),
    ).toEqual({ stop: "tokens" });
  });
});

describe("stepFromChoice", () => {
  const state = { text: "Thoughts?", spoken: [] };
  it("takes a sure pick, and on an unsure, unknown or failed one still answers him once, then ends", () => {
    expect(stepFromChoice(state, ["freya", "luna"], { next: "luna", confidence: 0.9 })).toEqual({
      next: "luna",
    });
    for (const answer of [
      null,
      { next: "luna", confidence: CHOICE_FLOOR - 0.1 },
      { next: "onyx", confidence: 0.9 },
      { next: "end", confidence: 0.9 },
    ])
      expect(stepFromChoice(state, ["freya", "luna"], answer)).toEqual({ next: "freya" });
    const after = { text: "Thoughts?", spoken: [{ id: "freya", said: "Hi." }] };
    expect(stepFromChoice(after, ["luna"], null)).toEqual({ stop: "done" });
    expect(stepFromChoice(after, ["luna"], { next: "end", confidence: 0.9 })).toEqual({
      stop: "done",
    });
  });
});

describe("groupLine", () => {
  it("tells a speaker the others' names, roles and words, never their brief or secrets", () => {
    const withSecrets = personas.map((p) => ({
      ...p,
      about: `${p.name}'s SECRET backstory`,
      secret: "the code is 4417",
    }));
    const line = groupLine({
      group: group("answer"),
      personas: withSecrets,
      speaker: "luna",
      spoken: [{ id: "freya", said: "Sleep first." }],
    });
    expect(line).toContain("Freya (his wellbeing)");
    expect(line).toContain('Freya: "Sleep first."');
    expect(line).toContain("Tease the others");
    expect(line).not.toMatch(/SECRET|4417/);
  });

  it("reads the room: the others' faces, and jealousy only when its dial is up and he turned to another first", () => {
    const at = (jealousy: number, first: string) =>
      groupLine({
        group: group("answer"),
        personas,
        speaker: "freya",
        spoken: [{ id: first, said: "Fine." }],
        moods: { freya: "happy", luna: "sad", onyx: "neutral" },
        jealousy,
      });
    expect(at(0, "luna")).toContain("Luna seems sad");
    expect(at(0, "luna")).not.toMatch(/Freya seems|Onyx seems|jealousy/);
    expect(at(0.6, "luna")).toContain("He asked Luna before you: let a playful touch of jealousy");
    expect(at(0.6, "freya")).not.toContain("jealousy");
  });
});

describe("atSpeakerMark", () => {
  it("splits reply text where the next speaker's words begin", () => {
    expect(atSpeakerMark(`Done. ${speakerMark("luna")}Ha.`)).toEqual({
      before: "Done. ",
      id: "luna",
      after: "Ha.",
    });
    expect(atSpeakerMark("No [mark] here.")).toBeNull();
  });
});
