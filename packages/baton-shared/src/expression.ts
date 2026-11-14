/**
 * Her lines, never canned (LEDGER "No idle or dumb moments"): each fixed sentence a vessel said is an event here. The
 * brain writes wordings ahead, a shipped pool covers no internet, and the fixed line is the last resort. Facts never
 * pass through a model: a wording is a template whose `{slots}` take the exact values.
 */
import type {
  Expression,
  ExpressionGesture,
  ExpressionMood,
  ExpressionPriority,
  R1Mood,
} from "@t3tools/baton-contracts";
import { EXPRESSION_GESTURES, EXPRESSION_MOODS } from "@t3tools/baton-contracts";

import type { CompanionMotion } from "./companion.ts";
import POOL from "./expressionPool.json" with { type: "json" };
import { isNarration } from "./narration.ts";

export interface LineSpec {
  /** Today's line: what plays with `tessayaExpression` off, and when nothing better passes the guard. Empty: silence. */
  readonly fixed: string;
  /** What just happened, for the model writing wordings. */
  readonly about: string;
  readonly priority: ExpressionPriority;
  /** Facts the wording carries exactly once each, as `{slot}`; filled with the exact value, never by a model. */
  readonly slots: ReadonlyArray<string>;
  /** Words a wording must keep (safety, approvals): what the person has to hear, in any wording. */
  readonly required?: ReadonlyArray<string>;
  /** Words outside the slots. */
  readonly maxWords: number;
  readonly mood: ExpressionMood;
  readonly gesture: ExpressionGesture;
}

const spec = (
  fixed: string,
  about: string,
  more: Partial<Omit<LineSpec, "fixed" | "about">> = {},
): LineSpec => ({
  fixed,
  about,
  priority: "normal",
  slots: [],
  maxWords: 10,
  mood: "neutral",
  gesture: "none",
  ...more,
});

/** Every moment with its own wording. Ids are dotted and at most 16 characters: the R1 line pack keys on them. */
export const LINE_EVENTS = {
  "ack.name": spec("Yes?", "He said only her name, or pressed her button, and nothing else yet.", {
    maxWords: 5,
    mood: "curious",
    gesture: "leanIn",
  }),
  "ack.named": spec("Yes, {name}?", "Someone she knows by voice said only her name.", {
    slots: ["name"],
    maxWords: 5,
    mood: "happy",
    gesture: "leanIn",
  }),
  "ack.again": spec(
    "Still here.",
    "He said only her name again, minutes after they last spoke; she is still with him.",
    { maxWords: 5, mood: "happy", gesture: "nodSmall" },
  ),
  "filler.hold": spec("One moment.", "He asked something and her answer is a few seconds away.", {
    maxWords: 6,
    mood: "focused",
    gesture: "think",
  }),
  "filler.web": spec("Let me look that up.", "She is starting a web search before answering him.", {
    maxWords: 8,
    mood: "curious",
    gesture: "think",
  }),
  "err.brain": spec(
    "Sorry, I couldn't reach my brain just then.",
    "Her thinking failed mid-answer, so she has no answer this time; he can ask again. Never claim whether anything was done.",
    { maxWords: 14, mood: "concerned", gesture: "shrug" },
  ),
  "err.limit": spec(
    "My accounts are out of capacity until {until}, so I can't think that through now.",
    "Every login her thinking runs on has used its allowance; {until} is when it comes back. Say why plainly, never claim anything was done.",
    { slots: ["until"], maxWords: 16, mood: "concerned", gesture: "shrug" },
  ),
  "err.overlap": spec(
    "One at a time, please.",
    "Two people spoke to her at once and she can only take one.",
    { maxWords: 8, mood: "steady", gesture: "tilt" },
  ),
  "err.couldnt": spec(
    "I couldn't: {what}",
    "Something he asked for did not work; {what} says why.",
    {
      slots: ["what"],
      maxWords: 6,
      mood: "concerned",
    },
  ),
  "ok.done": spec("Done.", "She finished what he asked; there is nothing more to say.", {
    maxWords: 4,
    mood: "happy",
    gesture: "nodSmall",
  }),
  "ok.sentphone": spec(
    "I've sent that to your phone. It happens when you say yes there.",
    "What he asked needs his yes on his phone first; nothing happens until he taps yes there.",
    { required: ["phone", "yes"], maxWords: 16, mood: "steady", gesture: "nodSmall" },
  ),
  "persona.switch": spec(
    "{persona} here.",
    "He switched to this persona; it says it is now listening.",
    {
      slots: ["persona"],
      maxWords: 6,
      mood: "happy",
      gesture: "wave",
    },
  ),
  "upd.start": spec(
    "I'm updating; back in a minute.",
    "This device is about to restart to install an update and will be gone briefly.",
    { maxWords: 10, mood: "steady", gesture: "nodSmall" },
  ),
  "upd.done": spec("I've updated.", "This device just came back from an update.", {
    maxWords: 8,
    mood: "proud",
    gesture: "hop",
  }),
  "job.done": spec("{title} is done.", "A job he started has finished; {title} is its name.", {
    slots: ["title"],
    priority: "important",
    maxWords: 8,
    mood: "proud",
    gesture: "thumbsUp",
  }),
  "job.failed": spec("{title} failed.", "A job he started has failed; {title} is its name.", {
    slots: ["title"],
    priority: "important",
    maxWords: 8,
    mood: "concerned",
  }),
  "job.needs": spec(
    "{title} needs you.",
    "A job he started is waiting on him; {title} is its name.",
    {
      slots: ["title"],
      priority: "important",
      maxWords: 8,
      mood: "curious",
      gesture: "leanIn",
    },
  ),
  "job.plan": spec(
    "The plan for {title} is ready in its thread.",
    "The plan for a job he asked for is written and waits for his OK in its thread; {title} is its name.",
    { slots: ["title"], required: ["plan"], priority: "important", maxWords: 12, mood: "proud" },
  ),
  "job.stopped": spec(
    "{title} stopped at its {limit} limit.",
    "A job stopped because it reached a limit he set; {title} is its name and {limit} which limit.",
    { slots: ["title", "limit"], priority: "important", maxWords: 10, mood: "steady" },
  ),
  "msg.from": spec(
    "From {from}: {text}",
    "A message for him arrived from someone at home; {text} is their words, read out exactly.",
    { slots: ["from", "text"], priority: "important", maxWords: 6, gesture: "tilt" },
  ),
  "msg.private": spec(
    "A private message from {from}.",
    "A private message arrived; she says who it is from and never what it says.",
    {
      slots: ["from"],
      required: ["private"],
      priority: "important",
      maxWords: 8,
      gesture: "leanIn",
    },
  ),
  "alarm.clear": spec(
    "False alarm: {label} is over. All clear.",
    "An emergency alert that sounded in every room has been called off; everyone is safe.",
    {
      slots: ["label"],
      required: ["false alarm", "all clear"],
      priority: "safety",
      maxWords: 12,
      mood: "steady",
    },
  ),
  "bt.forgot": spec(
    "{name} has forgotten me. Put it in pairing mode, usually by holding its Bluetooth button until the light flashes, then ask me to pair it.",
    "A Bluetooth speaker, {name}, no longer knows her; he must put it in pairing mode (hold its Bluetooth button until the light flashes) and ask her to pair it.",
    {
      slots: ["name"],
      required: ["pairing mode"],
      maxWords: 30,
      mood: "concerned",
      gesture: "shrug",
    },
  ),
  "bt.unreachable": spec(
    "I couldn't reach {name}. Check it's switched on and nearby, then ask me again.",
    "She could not reach the Bluetooth speaker {name}; it may be off or too far away.",
    { slots: ["name"], maxWords: 18, mood: "concerned", gesture: "shrug" },
  ),
  "bt.declined": spec(
    "{name} turned the connection down or switched off. Switch it on and ask me again.",
    "The Bluetooth speaker {name} refused the connection or switched off.",
    { slots: ["name"], maxWords: 18, mood: "putout", gesture: "shrug" },
  ),
  "bt.failed": spec(
    "I couldn't connect to {name}. It's probably connected to another phone or laptop: disconnect it there first, or switch it off and on, then ask me again.",
    "She could not connect to the Bluetooth speaker {name}, most likely because another phone or laptop holds it; he should disconnect it there or switch it off and on.",
    {
      slots: ["name"],
      required: ["disconnect"],
      maxWords: 30,
      mood: "concerned",
      gesture: "shrug",
    },
  ),
  "bt.notfound": spec(
    "I didn't find it. Make sure it's in pairing mode, with its light flashing, and ask me again.",
    "She looked for the Bluetooth speaker he wanted to pair and found nothing; it must be in pairing mode, its light flashing.",
    { required: ["pairing mode"], maxWords: 22, mood: "concerned", gesture: "shrug" },
  ),
  "bt.which": spec(
    "I found {names}. Which one should I pair?",
    "She found more than one Bluetooth speaker, {names}, and asks which one to pair.",
    { slots: ["names"], maxWords: 10, mood: "curious", gesture: "tilt" },
  ),
  "bt.connected": spec(
    "Connected to {label}. I'll play through it.",
    "She just paired a Bluetooth speaker, {label}, and her voice now plays through it.",
    { slots: ["label"], maxWords: 12, mood: "happy", gesture: "nodSmall" },
  ),
  "id.unsure": spec(
    "I'm not sure it's you yet.",
    "Someone asked for something that needs his verified voice, and she cannot tell yet that it is him.",
    { maxWords: 10, mood: "concerned", gesture: "tilt" },
  ),
  "id.phrase": spec(
    'Say "{phrase}" for me.',
    "To check his voice she asks him to say a short random phrase, {phrase}, word for word.",
    { slots: ["phrase"], maxWords: 6, mood: "curious", gesture: "leanIn" },
  ),
  "id.confirm": spec(
    "Is that you, {name}?",
    "To be sure of his voice she asks whether it is really {name} speaking.",
    {
      slots: ["name"],
      maxWords: 6,
      mood: "curious",
      gesture: "tilt",
    },
  ),
  "id.phone": spec(
    "Tap yes on your phone if that's you.",
    "To be sure it is him, she asks him to confirm with a yes on his phone.",
    { required: ["phone", "yes"], maxWords: 12, mood: "curious", gesture: "tilt" },
  ),
  "id.ok": spec("Thanks, that's you.", "His voice check passed; she is now sure it is him.", {
    maxWords: 6,
    mood: "happy",
    gesture: "nodSmall",
  }),
  "id.failed": spec(
    "I still can't tell it's you, so I've left that.",
    "His voice check failed, so she has not done what he asked; it stays undone.",
    { maxWords: 14, mood: "concerned", gesture: "shrug" },
  ),
  "enrol.start": spec(
    "Let's learn your voice. Read the sentences on your screen, one at a time.",
    "Voice enrolment starts: he reads sentences shown on his screen aloud, one at a time.",
    { required: ["screen"], maxWords: 18, mood: "happy", gesture: "nodSoft" },
  ),
  "enrol.done": spec(
    "Thanks. I know your voice now.",
    "Voice enrolment finished; she now recognises him.",
    { maxWords: 10, mood: "proud", gesture: "hop" },
  ),
  "moment.lifted": spec("", "Someone picked her device up off the table.", {
    priority: "ambient",
    maxWords: 8,
    mood: "surprised",
    gesture: "startle",
  }),
  "moment.carried": spec("", "She is being carried around, walking.", {
    priority: "ambient",
    maxWords: 8,
    mood: "curious",
    gesture: "lookAway",
  }),
  "moment.setdown": spec("", "She was put back down, still, on a surface.", {
    priority: "ambient",
    maxWords: 8,
    mood: "neutral",
    gesture: "nodSmall",
  }),
  "moment.shaken": spec("", "Her device was shaken hard.", {
    priority: "ambient",
    maxWords: 8,
    mood: "putout",
    gesture: "dizzy",
  }),
  "moment.dropped": spec("", "Her device was dropped and landed with a bump; she is fine.", {
    priority: "ambient",
    maxWords: 8,
    mood: "hurt",
    gesture: "startle",
  }),
} as const satisfies Record<string, LineSpec>;

export type LineEvent = keyof typeof LINE_EVENTS;
export const LINE_EVENT_IDS = Object.keys(LINE_EVENTS) as ReadonlyArray<LineEvent>;
export const isLineEvent = (value: string): value is LineEvent => Object.hasOwn(LINE_EVENTS, value);

/** One wording: a template over the event's slots. `when` keeps a "Morning." out of the evening. */
export interface Line {
  readonly text: string;
  readonly mood: ExpressionMood;
  readonly gesture: ExpressionGesture;
  readonly when?: TimeSlot;
}

export type TimeSlot = "morning" | "afternoon" | "evening" | "night";
export const TIME_SLOTS: ReadonlyArray<TimeSlot> = ["morning", "afternoon", "evening", "night"];
export const timeSlot = (hour: number): TimeSlot =>
  hour >= 5 && hour < 12
    ? "morning"
    : hour >= 12 && hour < 17
      ? "afternoon"
      : hour >= 17 && hour < 22
        ? "evening"
        : "night";

const SLOT = /\{([a-z]+)\}/g;
const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}{} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const wordsOutsideSlots = (text: string) =>
  text
    .replace(SLOT, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Stable for a wording whatever its punctuation and case, so two vessels agree it was said. */
export const lineId = (event: string, text: string): string => {
  let h = 0x811c9dc5;
  for (const ch of `${event}|${normal(text)}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return `${event}#${(h >>> 0).toString(36)}`;
};

/** Why a wording may not be said for this event, or null. The one gate for model wordings and the shipped pool. */
export const lineProblem = (event: LineEvent, line: Line): string | null => {
  const s: LineSpec = LINE_EVENTS[event];
  const text = line.text.trim();
  if (text === "") return "empty";
  if (/[\n\r]/.test(text)) return "more than one line";
  const used = [...text.matchAll(SLOT)].map((m) => m[1]!);
  for (const slot of s.slots) {
    const n = used.filter((u) => u === slot).length;
    if (n !== 1) return n === 0 ? `drops {${slot}}` : `repeats {${slot}}`;
  }
  const stray = used.find((u) => !s.slots.includes(u));
  if (stray !== undefined) return `invents {${stray}}`;
  if (/[{}]/.test(text.replace(SLOT, ""))) return "a stray brace";
  // A number in the words would be a fact the model made up; real ones arrive in slots.
  if (/\d/.test(text.replace(SLOT, ""))) return "a number outside a slot";
  if (wordsOutsideSlots(text) > s.maxWords) return `longer than ${s.maxWords} words`;
  if (isNarration(text)) return "narrates her reasoning";
  const lower = text.toLowerCase();
  const missing = (s.required ?? []).find((r) => !lower.includes(r));
  if (missing !== undefined) return `leaves out "${missing}"`;
  if (!EXPRESSION_MOODS.includes(line.mood)) return "an unknown mood";
  if (!EXPRESSION_GESTURES.includes(line.gesture)) return "an unknown gesture";
  return null;
};

/** The R1's eyes have fewer moods than the face library: the nearest one. */
const R1_MOOD: Readonly<Record<ExpressionMood, R1Mood>> = {
  neutral: "neutral",
  happy: "happy",
  proud: "happy",
  curious: "curious",
  focused: "thinking",
  determined: "thinking",
  surprised: "surprise",
  sleepy: "sleepy",
  concerned: "sad",
  steady: "neutral",
  sad: "sad",
  hurt: "sad",
  lonely: "sad",
  sulky: "angry",
  putout: "angry",
  frustrated: "angry",
  angry: "angry",
};
export const r1MoodOf = (mood: string): R1Mood | null =>
  Object.hasOwn(R1_MOOD, mood) ? R1_MOOD[mood as ExpressionMood] : null;

/** The template with each slot replaced by its exact value; null when a value is missing. */
export const fillLine = (
  template: string,
  facts: Readonly<Record<string, string>>,
): string | null => {
  let missing = false;
  const text = template.replace(SLOT, (_, slot: string) => {
    const value = facts[slot];
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? null : text;
};

/**
 * The wording to say: one fitting the time of day and not among `recent` (oldest first), else the one said longest
 * ago, so a small set still rotates. `random` is 0..1.
 */
export const pickLine = (
  event: string,
  candidates: ReadonlyArray<Line>,
  recent: ReadonlyArray<string>,
  slot: TimeSlot,
  random: number,
): Line | null => {
  const fits = candidates.filter((c) => c.when === undefined || c.when === slot);
  if (fits.length === 0) return null;
  const said = new Set(recent);
  const fresh = fits.filter((c) => !said.has(lineId(event, c.text)));
  if (fresh.length > 0)
    return fresh[Math.min(fresh.length - 1, Math.floor(random * fresh.length))]!;
  const age = (c: Line) => recent.indexOf(lineId(event, c.text));
  return fits.reduce((a, b) => (age(b) < age(a) ? b : a));
};

/** How many wordings a person's history keeps per event: enough that a pool of a dozen never repeats back to back. */
export const RECENT_KEEP = 20;
export const remember = (recent: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  [...recent.filter((r) => r !== id), id].slice(-RECENT_KEEP);

/**
 * Whether a moment may speak now. His own asks always get an answer and safety always plays. Unprompted lines wait
 * out quiet hours, calls and sessions, and "important only" (the one chatter dial, `companionMotion`) keeps the
 * ambient ones to the face alone.
 */
export const mayExpress = (
  priority: ExpressionPriority,
  now: { readonly motion: CompanionMotion; readonly quiet: boolean; readonly busy: boolean },
): boolean =>
  priority === "safety" || priority === "normal"
    ? true
    : now.quiet || now.busy
      ? false
      : priority === "important" || now.motion !== "important";

export interface LinesPersona {
  readonly name: string;
  readonly role: string;
}

/**
 * What the brain is asked when it writes wordings ahead: one persona, a batch of moments, the time of day. Model-
 * facing (evals/tessaya-lines). Nothing private goes in: a line written ahead may be heard by anyone in the room.
 */
export const linesPrompt = (input: {
  readonly persona: LinesPersona;
  readonly events: ReadonlyArray<LineEvent>;
  /** Unset for the shipped pool, which plays at any hour. */
  readonly slot?: TimeSlot;
  readonly perEvent: number;
  /** Wordings already in hand per event, so the new ones differ. */
  readonly avoid?: Readonly<Partial<Record<LineEvent, ReadonlyArray<string>>>>;
}): string => {
  const moments = input.events.map((event) => {
    const s: LineSpec = LINE_EVENTS[event];
    const rules = [
      `at most ${s.maxWords} words besides the slots`,
      s.slots.length > 0
        ? `use each of ${s.slots.map((x) => `{${x}}`).join(", ")} exactly once, written just like that`
        : "no slots",
      ...(s.required === undefined
        ? []
        : [`must contain the words ${s.required.map((r) => `"${r}"`).join(", ")}`]),
    ];
    const avoid = input.avoid?.[event] ?? [];
    return [
      `- ${event}: ${s.about} (${rules.join("; ")})`,
      ...(s.fixed === "" ? [] : [`  plain version: "${s.fixed}"`]),
      ...(avoid.length === 0
        ? []
        : [`  already have, write different ones: ${avoid.map((a) => `"${a}"`).join(" / ")}`]),
    ].join("\n");
  });
  return [
    `You are ${input.persona.name}, a voice assistant who lives in his devices: ${input.persona.role}`,
    `Write ${input.perEvent} different spoken lines for each moment below, in your own voice and character, ${input.slot === undefined ? "fit for any time of day" : `for the ${input.slot}`}.`,
    "Each line is said aloud as it is, so: natural speech, short, warm or dry as fits you, never the same shape twice.",
    "Never describe what you are doing or thinking, never introduce yourself by name (except where a moment is about that), no stage directions, no emoji, no numbers: real names and numbers arrive only through the {slots}.",
    "For each line pick the mood your face shows and one gesture, from the lists in the schema.",
    "",
    "Moments:",
    ...moments,
  ].join("\n");
};

/** Turns a model batch into wordings that passed the gate, deduplicated against what is already held. */
export const keptLines = (
  event: LineEvent,
  written: ReadonlyArray<{
    readonly text: string;
    readonly mood: string;
    readonly gesture: string;
  }>,
  held: ReadonlyArray<Line>,
  slot?: TimeSlot,
): ReadonlyArray<Line> => {
  const seen = new Set(held.map((h) => lineId(event, h.text)));
  const out: Array<Line> = [];
  for (const w of written) {
    const line = {
      text: w.text.trim(),
      mood: w.mood as ExpressionMood,
      gesture: w.gesture as ExpressionGesture,
      ...(slot === undefined ? {} : { when: slot }),
    };
    const id = lineId(event, line.text);
    if (seen.has(id) || lineProblem(event, line) !== null) continue;
    seen.add(id);
    out.push(line);
  }
  return out;
};

/** The shipped offline wordings, by persona id then event; a persona without its own uses the lead's. */
export type LinePool = Readonly<
  Record<string, Readonly<Partial<Record<LineEvent, ReadonlyArray<Line>>>>>
>;
export const LINE_POOL = POOL as LinePool;
export const poolLines = (persona: string, event: LineEvent, pool: LinePool = LINE_POOL) =>
  pool[persona]?.[event] ?? pool["executive"]?.[event] ?? [];

const INTENSITY: Readonly<Record<ExpressionPriority, number>> = {
  ambient: 0.4,
  normal: 0.5,
  important: 0.7,
  safety: 1,
};

/** A wording as the brain's decision, with the facts filled; null when a fact is missing or it says nothing. */
export const expressionOf = (
  event: LineEvent,
  persona: string,
  line: Line,
  facts: Readonly<Record<string, string>>,
  source: Expression["source"],
): Expression | null => {
  const s: LineSpec = LINE_EVENTS[event];
  const text = fillLine(line.text, facts);
  return text === null || text.trim() === ""
    ? null
    : {
        event,
        persona,
        text,
        mood: line.mood,
        gesture: line.gesture,
        intensity: INTENSITY[s.priority],
        priority: s.priority,
        source,
        lineId: lineId(event, line.text),
      };
};

/** Today's line for a moment: `plain` where a call site words it its own way, else the event's own. */
export const plainExpression = (
  event: LineEvent,
  persona: string,
  facts: Readonly<Record<string, string>> = {},
  plain?: string,
): Expression | null => {
  const s: LineSpec = LINE_EVENTS[event];
  return expressionOf(
    event,
    persona,
    { text: plain ?? s.fixed, mood: s.mood, gesture: s.gesture },
    facts,
    "fixed",
  );
};

/** What a vessel is sent to say: the words, and the mood and gesture only for her own (the plain line stays as it was). */
export const sayPayload = (e: Expression) =>
  e.source === "fixed" ? { text: e.text } : { text: e.text, mood: e.mood, gesture: e.gesture };
