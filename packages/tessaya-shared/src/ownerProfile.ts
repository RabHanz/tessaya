/**
 * The voice of the owner (PERSONA-TEAM §4): his own profile of how he thinks, decides, speaks and works, kept in his
 * pack's `owner/` folder (`voice.md` whole, `likes.md` the short slice, `docs/<name>.md` his documents whole). Like
 * the rest of the pack it is his data, never in the repository or the installer; with no folder every line is empty.
 */
import type { Persona } from "./osPack.ts";

export const OWNER_DIR = "owner";
/**
 * Every voice turn pays for these, so they stay small: about 1,000 and 170 tokens. Only `full` personas carry the
 * profile, and the rules he accepts land at its end, so a cap at its first length cut his newest words first.
 */
export const OWNER_VOICE_CHARS = 4_000;
export const OWNER_LIKES_CHARS = 700;
/** What one read of his documents returns at most. */
export const OWNER_DOC_CHARS = 6_000;

export interface OwnerFiles {
  readonly voice?: string;
  readonly likes?: string;
  /** His documents by file stem. */
  readonly docs: Readonly<Record<string, string>>;
}

/** How much of him a persona carries (`owner:` in its file): the whole profile, the slice, or nothing. */
export type OwnerReach = "full" | "brief" | "none";

export const ownerReachOf = (field: string | undefined): OwnerReach | undefined => {
  const v = (field ?? "").trim().toLowerCase();
  return v === "full" || v === "brief" || v === "none" ? v : undefined;
};

const clip = (text: string | undefined, max: number) => (text ?? "").trim().slice(0, max);

/**
 * The persona's line about him, for a turn with him (never a guest's): the profile for `full`, the slice for the rest,
 * which document names it can open, and how a correction is kept. `tools` names this surface's own tools.
 */
export const ownerLine = (
  persona: Pick<Persona, "owner"> | null,
  files: OwnerFiles,
  tools: { readonly doc: string; readonly remember: string },
): string => {
  const reach = persona?.owner ?? "brief";
  if (reach === "none") return "";
  const whole = (files.voice ?? "").trim();
  const voice =
    whole.length <= OWNER_VOICE_CHARS
      ? whole
      : `${whole.slice(0, OWNER_VOICE_CHARS)} (cut here: his profile is longer than ${OWNER_VOICE_CHARS} characters, so its end does not reach you; tell him owner/voice.md needs shortening)`;
  const likes = clip(files.likes, OWNER_LIKES_CHARS);
  const docs = Object.keys(files.docs).toSorted();
  const parts =
    reach === "full" && voice !== ""
      ? [
          `how he thinks, decides, speaks and works, in his own profile (you know this; when you write or decide for him, do it as he would, in his words): ${voice}`,
          `when he corrects how you sound, think or decide, keep it with ${tools.remember} in his words, so you are closer to him next time.`,
        ]
      : likes === ""
        ? []
        : [`how he likes things done: ${likes}`];
  if (docs.length > 0)
    parts.push(
      `his own documents, which you have read and can open: ${docs.join(", ")}. when one bears on what he asks, or he asks about one, read the part you need with ${tools.doc} before answering.`,
    );
  return parts.join("\n");
};

interface Heading {
  readonly level: number;
  readonly title: string;
  readonly at: number;
}

const headingsOf = (text: string): ReadonlyArray<Heading> => {
  const out: Array<Heading> = [];
  const re = /^(#{1,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text))
    out.push({ level: m[1]!.length, title: m[2]!.trim(), at: m.index });
  return out;
};

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** The heading whose title holds every word asked for; the shortest title wins, so "principles" finds the section. */
const sectionOf = (headings: ReadonlyArray<Heading>, asked: string): Heading | undefined => {
  const want = words(asked);
  if (want.length === 0) return undefined;
  return headings
    .filter((h) => {
      const have = new Set(words(h.title));
      return want.every((w) => have.has(w));
    })
    .toSorted((a, b) => a.level - b.level || a.title.length - b.title.length)[0];
};

const contents = (name: string, text: string) =>
  `${name}: ${headingsOf(text)
    .filter((h) => h.level <= 3)
    .map((h) => h.title)
    .join("; ")}`;

/**
 * One read of his documents: with no name, what there is and their sections; with a name, that document whole when it
 * fits, else its sections to pick from; with a section too, that section to the next heading at its level or above.
 */
export const ownerDoc = (
  docs: Readonly<Record<string, string>>,
  input: { readonly name?: string | undefined; readonly section?: string | undefined },
): string => {
  const names = Object.keys(docs).toSorted();
  if (names.length === 0) return "He has kept no documents here.";
  const asked = (input.name ?? "").trim().toLowerCase();
  const name =
    names.find((n) => n.toLowerCase() === asked) ??
    names.find((n) => asked !== "" && n.toLowerCase().includes(asked));
  if (name === undefined)
    return `His documents and their sections:\n${names.map((n) => contents(n, docs[n]!)).join("\n")}`.slice(
      0,
      OWNER_DOC_CHARS,
    );
  const text = docs[name]!;
  const headings = headingsOf(text);
  const section = (input.section ?? "").trim();
  if (section === "")
    return text.length <= OWNER_DOC_CHARS
      ? text
      : `${contents(name, text)}\nAsk again with one of these sections.`.slice(0, OWNER_DOC_CHARS);
  const found = sectionOf(headings, section);
  if (found === undefined)
    return `No section of ${name} matches "${section}". ${contents(name, text)}`.slice(
      0,
      OWNER_DOC_CHARS,
    );
  const end = headings.find((h) => h.at > found.at && h.level <= found.level)?.at ?? text.length;
  const body = text.slice(found.at, end).trim();
  return body.length <= OWNER_DOC_CHARS
    ? body
    : `${body.slice(0, OWNER_DOC_CHARS)}\n(cut here: ask for one of its smaller sections)`;
};
