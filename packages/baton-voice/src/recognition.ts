/**
 * Who she is talking to across one session, for every vessel (the R1's loop, the desktop, the phone): confidence that
 * builds over a session's turns, a quiet "I know you" at most once, and a step-up instead of a silent refusal when an
 * act needs to know who is speaking and she can't tell yet. Pure rules: each vessel keeps one `RecognitionSession` per
 * conversation and feeds it each turn's speaker.
 */
import { CAMPLUS_POLICY, type SpeakerIdentity } from "./speaker.ts";

/** A conversation this long silent is over: the next turn starts a new session and earns recognition again. */
export const SESSION_IDLE_MS = 10 * 60_000;
/** This much of one person's speech, scored together, counts like one long clip at the "act" level. */
const ACCUMULATED_ACT_MS = 4_000;

export interface RecognitionSession {
  /** The member the session's voice matched ("owner" or a saved person's id); null: nobody yet. */
  readonly member: string | null;
  readonly name: string | null;
  /** Verified once (on a turn's own audio, or enough of their speech together): sticky until a mismatch. */
  readonly verified: boolean;
  /** Their turns' scores, weighted by how long each was, and how much speech that is. */
  readonly scoreMs: number;
  readonly evidenceMs: number;
  /** Each said or shown at most once a session. */
  readonly cued: boolean;
  readonly named: boolean;
  readonly explained: boolean;
  readonly at: number;
}

export const NEW_SESSION = (at: number): RecognitionSession => ({
  member: null,
  name: null,
  verified: false,
  scoreMs: 0,
  evidenceMs: 0,
  cued: false,
  named: false,
  explained: false,
  at,
});

const memberOf = (s: SpeakerIdentity): string | null =>
  s.kind === "owner" || s.kind === "saved" ? s.personId : null;

/**
 * The session after one turn heard for `ms` of speech. The same person's turns add up (longer audio matches better)
 * and once verified the session stays theirs; a short turn too brief to judge keeps it as it is; a different voice, a
 * guest, or their own voice scoring under the listen cut-off starts over, so nobody inherits another's recognition.
 */
export const accumulate = (
  session: RecognitionSession | null,
  heard: SpeakerIdentity,
  ms: number,
  now: number,
): RecognitionSession => {
  const s = session === null || now - session.at > SESSION_IDLE_MS ? NEW_SESSION(now) : session;
  const member = memberOf(heard);
  if (heard.kind === "unverified" || heard.inherited) return { ...s, at: now };
  const mismatch =
    heard.kind === "guest" ||
    (s.member !== null && member !== s.member) ||
    (heard.confidence ?? 0) < CAMPLUS_POLICY.single.listen;
  const base = mismatch ? NEW_SESSION(now) : s;
  if (member === null) return { ...base, at: now };
  const scoreMs = base.scoreMs + (heard.confidence ?? 0) * ms;
  const evidenceMs = base.evidenceMs + ms;
  const together =
    evidenceMs >= ACCUMULATED_ACT_MS && scoreMs / evidenceMs >= CAMPLUS_POLICY.averaged.act;
  return {
    ...base,
    member,
    name: heard.name ?? base.name,
    verified: base.verified || heard.verified || together,
    scoreMs,
    evidenceMs,
    at: now,
  };
};

/** What to show and say this turn: the glance and their name once a session, only once they're verified. */
export const cueOf = (
  s: RecognitionSession,
): {
  readonly session: RecognitionSession;
  readonly glance: boolean;
  readonly name: string | null;
} => {
  if (!s.verified || s.member === null) return { session: s, glance: false, name: null };
  return {
    session: { ...s, cued: true, named: s.named || s.name !== null },
    glance: !s.cued,
    name: s.named ? null : s.name,
  };
};

/** Two everyday words, so a recording can't answer: different each time it is asked. */
const WORDS = [
  "amber",
  "river",
  "copper",
  "meadow",
  "lantern",
  "harbour",
  "velvet",
  "orchard",
  "maple",
  "pebble",
  "silver",
  "candle",
  "willow",
  "thunder",
  "garden",
  "violet",
  "marble",
  "falcon",
  "breeze",
  "cedar",
];
export const phraseFrom = (random: () => number): string =>
  `${WORDS[Math.floor(random() * WORDS.length)]!} ${WORDS[Math.floor(random() * WORDS.length)]!}`;

export type StepUp =
  | { readonly kind: "none" }
  /** A personal vessel: "Is that you, Maya?", answered in a voice that must match them at the listen cut-off. */
  | { readonly kind: "confirm"; readonly name: string; readonly explain: boolean }
  /** A shared vessel: repeat a short random phrase: more of their voice, and nothing a recording can say. */
  | { readonly kind: "phrase"; readonly phrase: string; readonly explain: boolean }
  /** Nobody to name yet: a tap on their phone instead. */
  | { readonly kind: "phone"; readonly explain: boolean };

/**
 * What she does when an act needs to know who is speaking: nothing when the session is verified; otherwise one ask,
 * explained the first time in a session ("I'm not sure it's you yet"). The act waits for the answer and then runs.
 */
export const stepUpFor = (
  s: RecognitionSession,
  vessel: { readonly shared: boolean },
  random: () => number,
): { readonly session: RecognitionSession; readonly step: StepUp } => {
  if (s.verified) return { session: s, step: { kind: "none" } };
  const explain = !s.explained;
  const session = { ...s, explained: true };
  if (vessel.shared)
    return { session, step: { kind: "phrase", phrase: phraseFrom(random), explain } };
  return s.name === null
    ? { session, step: { kind: "phone", explain } }
    : { session, step: { kind: "confirm", name: s.name, explain } };
};

/** Her words for the first time in a session she has to check. */
export const NOT_SURE_YET = "I'm not sure it's you yet.";

/** What she asks for a step-up; NOT_SURE_YET goes first when `explain`. Null when nothing is needed. */
export const stepUpLine = (step: StepUp): string | null => {
  if (step.kind === "none") return null;
  const ask =
    step.kind === "phrase"
      ? `Say "${step.phrase}" for me.`
      : step.kind === "confirm"
        ? `Is that you, ${step.name}?`
        : "Tap yes on your phone if that's you.";
  return step.explain ? `${NOT_SURE_YET} ${ask}` : ask;
};

/** Their reply to her step-up: the phrase she gave (its words in order), or a yes to "is that you?". */
export const answersStepUp = (step: StepUp, text: string): boolean => {
  const said = text
    .toLowerCase()
    .replace(/[^a-z' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (step.kind === "phrase") return ` ${said} `.includes(` ${step.phrase} `);
  if (step.kind === "confirm")
    return /^(?:yes|yeah|yep|yup|it's me|it is me|that's me|correct)\b/.test(said);
  return false;
};
