/**
 * What he says to stop her mid-reply, on every surface (13 Nov: he could not stop or dismiss her while she spoke).
 * Over her own voice only these count, so her playback and the room cannot start a turn; her name counts too, but
 * that is each surface's own name check. A user's own phrases extend the list (voice settings).
 */
const DISMISS = [
  "dismissed",
  "dismiss",
  "that's all",
  "that will be all",
  "that'll be all",
  "that would be all",
  "that'd be all",
  "go to sleep",
  "goodbye",
  "good night",
  "stop listening",
];
/** "Dismissed" as the recogniser writes it ("This best.", 08:27; "This miss.", 09:11, 15 Nov): the whole line only. */
const MISHEARD_DISMISS = /^(?:okay |ok )?(?:this|dis) ?(?:miss|missed|mist|best)$/;
const STOP = [
  "stop",
  "stop talking",
  "stop it",
  "enough",
  "that's enough",
  "be quiet",
  "quiet",
  "shush",
  "shut up",
  "never mind",
  "nevermind",
  "cancel",
  "hold on",
];

const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** What may stand beside a stop in the same breath ("okay, stop", "stop, stop", "enough, thanks", "no, stop now"). */
const STOP_FILLER = new Set(
  "okay ok no please thanks thank you now just hey right alright stop enough quiet already".split(
    " ",
  ),
);

/** A word right before the phrase that makes it talk, not a command: "I'll stop", "fair enough", "it's quiet" (15 Nov). */
const NOT_A_COMMAND = new Set(
  "i i'll i'd i'm we we'll you'll they he she it it's is was to don't didn't not can't won't will would should could gonna the a bus too so very really fair good big long close keep".split(
    " ",
  ),
);

/**
 * The phrase that makes the line a "dismiss" or a "stop" (with a few words around it at most: "okay, stop",
 * "stop, stop", "enough, thanks"), else null. A long sentence that merely contains "stop" is not one.
 */
export const stopMatch = (
  text: string,
  extra: ReadonlyArray<string> = [],
): { readonly intent: "dismiss" | "stop"; readonly phrase: string } | null => {
  const said = plain(text);
  if (said === "" || said.split(" ").length > 5) return null;
  const has = (phrase: string) => {
    const p = plain(phrase);
    if (p === "") return false;
    const at = ` ${said} `.indexOf(` ${p} `);
    return at >= 0 && !NOT_A_COMMAND.has(said.slice(0, at).trim().split(" ").at(-1) ?? "");
  };
  if (MISHEARD_DISMISS.test(said)) return { intent: "dismiss", phrase: "dismissed" };
  const dismiss = DISMISS.find(has);
  if (dismiss !== undefined) return { intent: "dismiss", phrase: dismiss };
  // A stop is the whole line, give or take a filler: "stop talking about work" and "stop that and tell me the time" are
  // requests she follows, not a stop (19 Nov, 04:56: she went to rest on "Stop talking about her work").
  const stop = [...STOP, ...extra]
    .toSorted((a, b) => b.length - a.length)
    .find(
      (phrase) =>
        has(phrase) &&
        ` ${said} `
          .replace(` ${plain(phrase)} `, " ")
          .split(" ")
          .every((w) => w === "" || STOP_FILLER.has(w)),
    );
  return stop === undefined ? null : { intent: "stop", phrase: stop };
};

export const stopIntent = (
  text: string,
  extra: ReadonlyArray<string> = [],
): "dismiss" | "stop" | null => stopMatch(text, extra)?.intent ?? null;

/** The room brain's own "he is done": the end of a reply that closes the conversation, never said (15 Nov). */
export const REST_MARK = "[rest]";
/** The room brain's "this turn is a private moment" (a persona layer answered): never said, and the turn is never kept. */
export const PRIVATE_MARK = "[private]";

/**
 * The model's way to end the conversation, on every vessel: the fixed phrases above are only the fast path (18 Nov).
 * Evals: evals/tessaya-room/liveCases.ts (the end-* cases).
 */
export const CONVERSATION_END = {
  name: "conversation_end",
  description:
    'End this conversation: you go quiet and stop listening until he wakes you again. Call it when he is done talking to you, however he puts it ("we\'re done for now", "go to sleep", "okay, bye", "dismissed", "stop", "that\'s enough, thanks", "good night"). Not when he is done with something else ("I\'m done with that file", "bye to that idea", "stop the music"): answer that as usual. Call it straight away with your goodbye in goodbye, and write nothing else.',
  input_schema: {
    type: "object",
    properties: {
      goodbye: {
        type: "string",
        description:
          "A short goodbye that fits the moment, a few words; leave it out to end in silence.",
      },
    },
  },
} as const;
