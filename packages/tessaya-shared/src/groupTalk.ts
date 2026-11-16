/**
 * Group conversations (M-021, Voxta G3 + G10): him and several personas in one conversation. Pure rules shared by the
 * server's loop and its eval: who speaks next, when a turn stops, and what each speaker is told about the others.
 * A speaker hears the others only by name, one-line role and what they said aloud: never their brief, memory or secrets.
 */
import * as Schema from "effect/Schema";

import type { Trait } from "./osPack.ts";

/** "answer": only answer him, one reply a turn (more when he names several); "watch": they talk among themselves. */
export type GroupMode = "answer" | "watch";

export interface GroupMember {
  readonly id: string;
  /** Present but silent (Voxta's canSpeak=false): listens, speaks only when he names it. */
  readonly silent?: boolean | undefined;
}

export interface PersonaGroup {
  readonly members: ReadonlyArray<GroupMember>;
  readonly mode: GroupMode;
}

/** What one persona may know of another: what anyone in the room would. */
export interface GroupPersona {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly traits?: Readonly<Partial<Record<Trait, number>>>;
}

export interface Spoken {
  readonly id: string;
  readonly said: string;
}

/** Hard caps per user turn: speakers, and the tokens they say between them. */
export const SPEAKERS_PER_TURN: Readonly<Record<GroupMode, number>> = { answer: 3, watch: 6 };
export const TOKENS_PER_TURN = 1_200;
/** A choice the cheap model is less sure of than this is no choice. */
export const CHOICE_FLOOR = 0.5;
export const MAX_MEMBERS = 6;

/** shortcut: four characters a token, close enough for a budget; use the provider's count if one ever bills by it. */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The members he speaks to by name, in the order he names them: "Freya, what do you think?", "what do you think,
 * Luna?", "Freya and Luna, ...". A name only mentioned ("I told Freya yesterday") is not addressing.
 */
export const addressedIn = (
  text: string,
  group: PersonaGroup,
  personas: ReadonlyArray<GroupPersona>,
): ReadonlyArray<string> => {
  const found: Array<{ readonly id: string; readonly at: number }> = [];
  for (const m of group.members) {
    const name = personas.find((p) => p.id === m.id)?.name;
    if (name === undefined) continue;
    const n = escape(name);
    const re = new RegExp(
      `(?:^|[.!?]\\s+|\\b(?:hey|ask|and|you|over to)\\s+)${n}\\b(?=\\s*(?:[,?!.:]|and\\b|$))|,\\s*${n}\\s*[?!.]?\\s*$`,
      "iu",
    );
    const hit = re.exec(text.trim());
    if (hit !== null) found.push({ id: m.id, at: hit.index });
  }
  return found.toSorted((a, b) => a.at - b.at).map((f) => f.id);
};

export type Step =
  | { readonly next: string }
  | { readonly ask: ReadonlyArray<string> }
  | { readonly stop: "budget" | "tokens" | "done" };

/** Who may be picked next: the members who speak, not the one who just did. */
const candidatesOf = (group: PersonaGroup, spoken: ReadonlyArray<Spoken>) => {
  const last = spoken.at(-1)?.id;
  return group.members.filter((m) => m.silent !== true && m.id !== last).map((m) => m.id);
};

/**
 * The next step of one user turn: a speaker without asking (he named them, or only one could answer), ask the cheap
 * model among `ask`, or stop. `text` null is a turn with no words of his (watch mode carrying on).
 */
export const nextStep = (input: {
  readonly group: PersonaGroup;
  readonly personas: ReadonlyArray<GroupPersona>;
  readonly text: string | null;
  readonly spoken: ReadonlyArray<Spoken>;
}): Step => {
  const { group, spoken } = input;
  if (spoken.length >= SPEAKERS_PER_TURN[group.mode]) return { stop: "budget" };
  if (spoken.reduce((n, s) => n + tokensOf(s.said), 0) >= TOKENS_PER_TURN)
    return { stop: "tokens" };
  const addressed = input.text === null ? [] : addressedIn(input.text, group, input.personas);
  const pending = addressed.filter((id) => !spoken.some((s) => s.id === id));
  if (pending.length > 0) return { next: pending[0]! };
  if (group.mode === "answer" && spoken.length > 0) return { stop: "done" };
  const candidates = candidatesOf(group, spoken);
  if (candidates.length === 0) return { stop: "done" };
  if (spoken.length === 0 && candidates.length === 1) return { next: candidates[0]! };
  return { ask: candidates };
};

/**
 * The cheap model's pick, checked: a choice outside the list, below the floor or a failed call is no choice. His own
 * words always get one reply (the first candidate); after that, no choice ends the turn.
 */
export const stepFromChoice = (
  input: { readonly text: string | null; readonly spoken: ReadonlyArray<Spoken> },
  candidates: ReadonlyArray<string>,
  answer: { readonly next: string; readonly confidence: number } | null,
): Step => {
  const owed = input.text !== null && input.spoken.length === 0 && candidates.length > 0;
  if (
    answer === null ||
    answer.confidence < CHOICE_FLOOR ||
    answer.next === "end" ||
    !candidates.includes(answer.next)
  )
    return owed ? { next: candidates[0]! } : { stop: "done" };
  return { next: answer.next };
};

/** The closed choice the cheap model returns: one of the candidates or "end", and how sure it is. */
export const choiceSchema = (candidates: ReadonlyArray<string>) =>
  Schema.Struct({
    next: Schema.Literals([...candidates, "end"]),
    confidence: Schema.Number,
  });

const nameOf = (personas: ReadonlyArray<GroupPersona>, id: string) =>
  personas.find((p) => p.id === id)?.name ?? id;

const heardLines = (personas: ReadonlyArray<GroupPersona>, spoken: ReadonlyArray<Spoken>) =>
  spoken.map((s) => `${nameOf(personas, s.id)}: ${JSON.stringify(s.said.slice(0, 400))}`);

/** The prompt for who speaks next: names, roles, his words and this turn so far. No briefs, no memory. */
export const choicePrompt = (input: {
  readonly group: PersonaGroup;
  readonly personas: ReadonlyArray<GroupPersona>;
  readonly text: string | null;
  readonly spoken: ReadonlyArray<Spoken>;
  readonly candidates: ReadonlyArray<string>;
}): string =>
  [
    "Pick who speaks next in a group conversation between him and these personas, or end.",
    `Who may speak: ${input.candidates.map((id) => `${id} (${nameOf(input.personas, id)}: ${input.personas.find((p) => p.id === id)?.role ?? ""})`).join("; ")}.`,
    input.group.mode === "watch"
      ? "He asked them to talk among themselves: pick whoever would naturally answer the last line; end when the exchange has run its course or someone would only repeat."
      : "He only wants an answer: pick the one whose role fits what he said best.",
    input.text === null ? "He said nothing new." : `He said: ${JSON.stringify(input.text)}`,
    ...(input.spoken.length === 0
      ? []
      : ["Said so far this turn:", ...heardLines(input.personas, input.spoken)]),
    'Answer next (one id, or "end") and confidence from 0 to 1.',
  ].join("\n");

/** How a speaker's dials let it treat the others: disagree, tease, take a side. */
const stanceLine = (traits: GroupPersona["traits"]): string => {
  const sass = traits?.sass ?? 0.3;
  const play = traits?.play ?? 0.4;
  const warmth = traits?.warmth ?? 0.6;
  return [
    sass >= 0.6
      ? "Disagree openly when you do, and take a side."
      : sass <= 0.25
        ? "Disagree gently, if at all."
        : "Say so when you disagree.",
    play >= 0.6 ? "Tease the others when it fits." : "",
    warmth >= 0.75 ? "Build on what the others said when you agree." : "",
  ]
    .filter((l) => l !== "")
    .join(" ");
};

/** The room's mood (MA-021): how each other member visibly seems, and the speaker's jealousy dial. Faces only. */
const roomMoodLines = (input: {
  readonly personas: ReadonlyArray<GroupPersona>;
  readonly speaker: string;
  readonly spoken: ReadonlyArray<Spoken>;
  readonly moods?: Readonly<Record<string, string>> | undefined;
  readonly jealousy?: number | undefined;
}): ReadonlyArray<string> => {
  const nameOf = (id: string) => input.personas.find((p) => p.id === id)?.name ?? id;
  const seem = Object.entries(input.moods ?? {})
    .filter(([id, label]) => id !== input.speaker && label !== "neutral")
    .map(([id, label]) => `${nameOf(id)} seems ${label}`);
  const first = input.spoken[0]?.id;
  const jealousy = input.jealousy ?? 0;
  return [
    seem.length === 0
      ? ""
      : `How the others seem right now: ${seem.join("; ")}. Read the room: turn a gentle word or an invitation to anyone who seems low and match anyone bright, without ever saying how they seem or sound.`,
    first !== undefined && first !== input.speaker && jealousy > 0.05
      ? `He asked ${nameOf(first)} before you: let a ${jealousy >= 0.5 ? "playful touch" : "faint hint"} of jealousy about that show, once and lightly, never as a reproach.`
      : "",
  ];
};

/** What the speaking persona is told of the group: the others by name and role, and what was said aloud this turn. */
export const groupLine = (input: {
  readonly group: PersonaGroup;
  readonly personas: ReadonlyArray<GroupPersona>;
  readonly speaker: string;
  readonly spoken: ReadonlyArray<Spoken>;
  /** Each member's visible mood (its face's label), from the one mood service. */
  readonly moods?: Readonly<Record<string, string>> | undefined;
  /** The speaker's jealousy dial, 0 to 1 (off by default). */
  readonly jealousy?: number | undefined;
}): string => {
  const me = input.personas.find((p) => p.id === input.speaker);
  const others = input.group.members
    .filter((m) => m.id !== input.speaker)
    .map((m) => {
      const p = input.personas.find((x) => x.id === m.id);
      return p === undefined
        ? null
        : `${p.name} (${p.role})${m.silent === true ? ", listening" : ""}`;
    })
    .filter((l) => l !== null);
  return [
    `This is a group conversation: him, you (${me?.name ?? input.speaker}) and ${others.join("; ")}. Speak only as yourself, in a line or two, never for the others, and never start with your own name.`,
    stanceLine(me?.traits),
    ...roomMoodLines(input),
    ...(input.spoken.length === 0
      ? []
      : ["Said so far this turn:", ...heardLines(input.personas, input.spoken)]),
  ]
    .filter((l) => l !== "")
    .join("\n");
};

/** Where a group speaker's words begin in a vessel's reply text: its voice and eyes switch there. */
export const speakerMark = (id: string): string => `[as:${id}]`;
const SPEAKER_MARK = /\[as:([^\]\s]{1,80})\]/;

/** Reply text split at its first speaker mark; null when it has none. */
export const atSpeakerMark = (
  text: string,
): { readonly before: string; readonly id: string; readonly after: string } | null => {
  const m = SPEAKER_MARK.exec(text);
  return m === null
    ? null
    : { before: text.slice(0, m.index), id: m[1]!, after: text.slice(m.index + m[0].length) };
};
