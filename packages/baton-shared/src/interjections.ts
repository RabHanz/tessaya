/**
 * Pocket TTS takes no tags, so interjections are respelled per voice and a stage direction ("*sighs*") becomes a sound
 * spliced in by `speechSplice.ts`, never words. Gemini gets its own tag (`<sigh>`) instead. His picks by ear go into
 * INTERJECTION_PICKS; his own pronounce list still wins.
 */

export const NONVERBALS = [
  "sigh",
  "laugh",
  "chuckle",
  "giggle",
  "scoff",
  "gasp",
  "groan",
  "breath",
  "cough",
  "yawn",
  "sniff",
  "gesture",
] as const;
export type Nonverbal = (typeof NONVERBALS)[number];

export type Sound =
  /** Said in the same voice, quieter by `gain` (0..1). */
  | { readonly kind: "say"; readonly text: string; readonly gain: number }
  /** A soft breath of this length, at a level matched to the speech around it. */
  | { readonly kind: "breath"; readonly ms: number }
  /** Silence: a gesture, or a sound this voice cannot make. */
  | { readonly kind: "pause"; readonly ms: number };

export interface Respelling {
  readonly say: string;
  /** Silence after it, for a "hmm" that thinks before going on. */
  readonly pauseMs?: number;
}

/** What the words inside a direction mean. A direction whose first word is not here stays as written (emphasis). */
const DIRECTION_WORDS: ReadonlyArray<readonly [RegExp, Nonverbal]> = [
  [/^(sighs?|sighing|exhales?|exhaling)$/, "sigh"],
  [/^(laughs?|laughing|laughter|lol)$/, "laugh"],
  [/^(chuckles?|chuckling)$/, "chuckle"],
  [/^(giggles?|giggling)$/, "giggle"],
  [/^(scoffs?|scoffing|snorts?|snorting|huffs?)$/, "scoff"],
  [/^(gasps?|gasping)$/, "gasp"],
  [/^(groans?|groaning|grumbles?)$/, "groan"],
  [/^(breathes?|breath|inhales?|inhaling|deep)$/, "breath"],
  [/^(coughs?|coughing|clears?|ahem)$/, "cough"],
  [/^(yawns?|yawning)$/, "yawn"],
  [/^(sniffs?|sniffles?|sniffing)$/, "sniff"],
  [
    /^(smiles?|smiling|grins?|grinning|nods?|nodding|winks?|shrugs?|waves?|pauses?|beat)$/,
    "gesture",
  ],
];

/** Until he picks by ear: what each sound is in a Pocket voice. */
const NONVERBAL_DEFAULTS: Readonly<Record<Nonverbal, Sound>> = {
  sigh: { kind: "breath", ms: 520 },
  laugh: { kind: "say", text: "Ha ha.", gain: 0.75 },
  chuckle: { kind: "say", text: "Heh heh.", gain: 0.65 },
  giggle: { kind: "say", text: "Hee hee.", gain: 0.65 },
  scoff: { kind: "say", text: "Pfft.", gain: 0.7 },
  gasp: { kind: "breath", ms: 240 },
  groan: { kind: "say", text: "Uhhh.", gain: 0.6 },
  breath: { kind: "breath", ms: 420 },
  cough: { kind: "pause", ms: 200 },
  yawn: { kind: "pause", ms: 250 },
  sniff: { kind: "pause", ms: 200 },
  gesture: { kind: "pause", ms: 220 },
};

/** Gemini's own tags (its speech-generation docs); a gesture is a short pause. */
const GEMINI_TAGS: Readonly<Record<Nonverbal, string>> = {
  sigh: "<sigh>",
  laugh: "<laugh>",
  chuckle: "<laugh>",
  giggle: "<giggle>",
  scoff: "<short pause>",
  gasp: "<gasp>",
  groan: "<sigh>",
  breath: "<breath>",
  cough: "<cough>",
  yawn: "<yawn>",
  sniff: "<short pause>",
  gesture: "<short pause>",
};

/** Each interjection: its id, how it is written (any case, stretched letters too), and how Pocket says it until he picks. */
export const INTERJECTIONS: ReadonlyArray<readonly [string, RegExp, Respelling]> = [
  ["mm-hmm", /^(m+-?h+m+|mhm+)$/, { say: "Mm hm" }],
  ["uh-huh", /^uh-?huh$/, { say: "Uh huh" }],
  ["uh-oh", /^uh-?oh$/, { say: "Uh oh" }],
  // "Hmmm" sends Eve into a 13-second babble on a long line (recogniser check, 2026-11-12); "Hmm" is safe.
  ["hmm", /^(h+m{2,}|hm)$/, { say: "Hmm" }],
  ["ugh", /^u+g+h+$/, { say: "Uhhgh" }],
  ["ah", /^a+h+$/, { say: "Ahh" }],
  ["oh", /^o+h+$/, { say: "Oh" }],
  ["aww", /^a+w+$/, { say: "Awww" }],
  ["ooh", /^o{2,}h*$/, { say: "Oooh" }],
  ["whoa", /^w+h*o+a+h*$/, { say: "Whoah" }],
  ["phew", /^p+h+e+w+$/, { say: "Phew" }],
  ["tsk", /^(tsk)+(-tsk)*$/, { say: "Tut tut" }],
  ["huh", /^h+u+h+$/, { say: "Huh" }],
  ["meh", /^m+e+h+$/, { say: "Meh" }],
  ["yay", /^y+a+y+$/, { say: "Yay" }],
  ["oops", /^o+p+s+$/, { say: "Oops" }],
  ["haha", /^(ha){2,}h?$/, { say: "Ha ha" }],
  ["heh", /^h+e+h+$/, { say: "Heh" }],
  ["um", /^u+m+$/, { say: "Umm" }],
  ["erm", /^e+r+m+$/, { say: "Erm" }],
  ["shh", /^s+h{2,}$/, { say: "Shh" }],
  ["eww", /^e+w{2,}$/, { say: "Eww" }],
];

/**
 * His picks by ear, per voice: an interjection id → its respelling, or a nonverbal → its sound. Empty until he
 * chooses on the interjection audition page; a voice with no pick uses the defaults above.
 */
export const INTERJECTION_PICKS: Readonly<
  Record<string, Readonly<Record<string, Respelling | Sound>>>
> = {};

export type SpeechPiece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "sound"; readonly nonverbal: Nonverbal; readonly sound: Sound };

const nonverbalOf = (inside: string): Nonverbal | null => {
  const first =
    inside
      .trim()
      .toLowerCase()
      .split(/\s+/)[0]
      ?.replace(/[^a-z]/g, "") ?? "";
  for (const [pattern, nonverbal] of DIRECTION_WORDS) if (pattern.test(first)) return nonverbal;
  return null;
};

// *sighs*, _laughs_, (sighs), [laughs softly], <sigh>: short, and only when the first word is a known one.
const DIRECTION =
  /\*([^*\n]{1,40})\*|_([^_\n]{1,40})_|\(([^()\n]{1,40})\)|\[([^[\]\n]{1,40})\]|<([^<>\n]{1,40})>/g;
const WORD = /[A-Za-z]+(?:-[A-Za-z]+)?/g;

const isSound = (pick: Respelling | Sound | undefined): pick is Sound =>
  pick !== undefined && "kind" in pick;

const respellWords = (
  text: string,
  voice: string,
  his: Readonly<Record<string, string>>,
): ReadonlyArray<SpeechPiece> => {
  const pieces: SpeechPiece[] = [];
  const mine = new Set(Object.keys(his).map((k) => k.toLowerCase()));
  let at = 0;
  let out = "";
  // "mm hmm", "uh huh", "uh oh" and "tsk tsk" are one interjection each.
  const joined = text.replace(/\b(m+|uh|tsk) (h+m+|huh|oh|tsk)\b/gi, "$1-$2");
  for (const m of joined.matchAll(WORD)) {
    const word = m[0];
    const found = INTERJECTIONS.find(([, pattern]) => pattern.test(word.toLowerCase()));
    if (found === undefined || mine.has(word.toLowerCase())) continue;
    const [id, , fallback] = found;
    const pick = INTERJECTION_PICKS[voice]?.[id];
    const spelling = pick !== undefined && !isSound(pick) ? pick : fallback;
    const end = m.index + word.length;
    // A picked "Hmm…" before his own comma or full stop keeps only one of them.
    const say = /^[\s]*[.,!?;:…]/.test(joined.slice(end))
      ? spelling.say.replace(/[.,!?;:…]+$/, "")
      : spelling.say;
    out += joined.slice(at, m.index) + say;
    at = end;
    if (spelling.pauseMs !== undefined && spelling.pauseMs > 0) {
      pieces.push({ kind: "text", text: out });
      pieces.push({
        kind: "sound",
        nonverbal: "gesture",
        sound: { kind: "pause", ms: spelling.pauseMs },
      });
      out = "";
    }
  }
  pieces.push({ kind: "text", text: out + joined.slice(at) });
  return pieces;
};

/**
 * A reply as pieces to say: text (interjections respelled for this voice, his own words left for `pronounce`) and the
 * sounds that stand for its stage directions. For a Gemini voice the directions become its tags inside the text.
 */
export const speechPieces = (
  text: string,
  voice: string,
  options: {
    readonly engine?: "pocket" | "gemini";
    readonly his?: Readonly<Record<string, string>>;
  } = {},
): ReadonlyArray<SpeechPiece> => {
  const his = options.his ?? {};
  const gemini = options.engine === "gemini";
  const raw: SpeechPiece[] = [];
  let at = 0;
  for (const m of text.matchAll(DIRECTION)) {
    const inside = m.slice(1).find((g) => g !== undefined) ?? "";
    const nonverbal = nonverbalOf(inside);
    if (nonverbal === null) continue;
    const before = text.slice(at, m.index);
    at = m.index + m[0].length;
    if (gemini) {
      raw.push({ kind: "text", text: `${before}${GEMINI_TAGS[nonverbal]}` });
      continue;
    }
    raw.push({ kind: "text", text: before });
    const pick = INTERJECTION_PICKS[voice]?.[nonverbal];
    raw.push({
      kind: "sound",
      nonverbal,
      sound: isSound(pick) ? pick : NONVERBAL_DEFAULTS[nonverbal],
    });
  }
  raw.push({ kind: "text", text: text.slice(at) });
  const pieces: SpeechPiece[] = [];
  for (const piece of raw) {
    // Gemini says interjections well as written; only Pocket needs them respelled.
    const parts = piece.kind === "text" && !gemini ? respellWords(piece.text, voice, his) : [piece];
    for (const part of parts) {
      const last = pieces.at(-1);
      if (part.kind === "text" && last?.kind === "text") {
        pieces[pieces.length - 1] = { kind: "text", text: last.text + part.text };
      } else pieces.push(part);
    }
  }
  return pieces
    .map((p) => (p.kind === "text" ? { ...p, text: p.text.replace(/\s+/g, " ").trim() } : p))
    .filter((p) => p.kind === "sound" || /[\p{L}\p{N}]/u.test(p.text));
};

export const hasDirection = (text: string): boolean =>
  [...text.matchAll(DIRECTION)].some(
    (m) => nonverbalOf(m.slice(1).find((g) => g !== undefined) ?? "") !== null,
  );

/** The reply with its directions taken out, for the screen's echo check and the OS voice. */
export const withoutDirections = (text: string): string =>
  text
    .replace(DIRECTION, (whole, ...groups: Array<string | undefined>) =>
      nonverbalOf(groups.slice(0, 5).find((g) => g !== undefined) ?? "") === null ? whole : " ",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
