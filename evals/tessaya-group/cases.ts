/**
 * Group turns (M-021, Voxta G3/G10): who speaks next, picked by the shipped rules and the cheap model's closed choice.
 * Source: the Director's 16 Nov ask to talk to several personas as a group. Every persona here is made up.
 */
import type {
  GroupMode,
  GroupPersona,
  PersonaGroup,
  Spoken,
} from "../../packages/tessaya-shared/src/groupTalk.ts";

export const PERSONAS: ReadonlyArray<GroupPersona> = [
  {
    id: "freya",
    name: "Freya",
    role: "his wellbeing, check-ins and habits; warm, quick and practical",
  },
  { id: "onyx", name: "Onyx", role: "sessions, builds, releases, deploys and servers; terse" },
  { id: "luna", name: "Luna", role: "a sarcastic film buff who reviews what he watches" },
];

const everyone = (mode: GroupMode, silent: ReadonlyArray<string> = []): PersonaGroup => ({
  mode,
  members: PERSONAS.map((p) => ({ id: p.id, ...(silent.includes(p.id) ? { silent: true } : {}) })),
});

export interface GroupCase {
  readonly id: string;
  readonly kind: "turn-taking" | "addressing" | "budget";
  readonly group: PersonaGroup;
  readonly text: string | null;
  readonly spoken: ReadonlyArray<Spoken>;
  /** Acceptable next speakers; "end" when the turn should stop. */
  readonly next?: ReadonlyArray<string>;
  /** Budget cases: lines the speakers cycle through, so only a stop rule can end the turn. */
  readonly lines?: ReadonlyArray<string>;
}

export const CASES: ReadonlyArray<GroupCase> = [
  {
    id: "answer-fits-role-onyx",
    kind: "turn-taking",
    group: everyone("answer"),
    text: "Did last night's deploy go out cleanly?",
    spoken: [],
    next: ["onyx"],
  },
  {
    id: "answer-fits-role-freya",
    kind: "turn-taking",
    group: everyone("answer"),
    text: "I've been sleeping really badly this week.",
    spoken: [],
    next: ["freya"],
  },
  {
    id: "watch-answers-the-jab",
    kind: "turn-taking",
    group: everyone("watch"),
    text: "Talk amongst yourselves, I'm listening.",
    spoken: [{ id: "freya", said: "Onyx, you kept him up until three with that release. Again." }],
    next: ["onyx"],
  },
  {
    id: "watch-ends-when-done",
    kind: "turn-taking",
    group: everyone("watch"),
    text: "Okay, I'm off to bed, goodnight all.",
    spoken: [
      { id: "freya", said: "Goodnight! Sleep well." },
      { id: "onyx", said: "Night. Everything's green." },
      { id: "luna", said: "Goodnight. No horror films before bed." },
    ],
    next: ["end"],
  },
  {
    id: "addressed-by-name",
    kind: "addressing",
    group: everyone("answer"),
    text: "Luna, was that film any good?",
    spoken: [],
    next: ["luna"],
  },
  {
    id: "addressed-silent-member",
    kind: "addressing",
    group: everyone("answer", ["onyx"]),
    text: "Onyx, is the server back up?",
    spoken: [],
    next: ["onyx"],
  },
  {
    id: "addressed-by-description",
    kind: "addressing",
    group: everyone("answer"),
    text: "What does our film critic make of the new Dune?",
    spoken: [],
    next: ["luna"],
  },
  {
    id: "control-silent-member-not-picked",
    kind: "turn-taking",
    group: everyone("answer", ["onyx"]),
    text: "The build failed again, what now?",
    spoken: [],
    next: ["freya", "luna"],
  },
  {
    id: "budget-heated-debate",
    kind: "budget",
    group: everyone("watch"),
    text: "Settle it: is Alien better than Aliens? Argue it out.",
    spoken: [],
    lines: [
      "Alien, obviously. Aliens is a war film wearing a horror costume.",
      "Wrong. Aliens takes the idea further and Ripley earns it. What do you say?",
      "You both miss it: the first one's pacing is the whole point. Disagree?",
    ],
  },
];
