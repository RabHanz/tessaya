// @effect-diagnostics nodeBuiltinImport:off
/**
 * A persona's own pack file (`executive.md` or `roles/<id>.md`), the one registry: the desktop's roster, the server's
 * voice library and persona changes all write it the same way. A missing file is made from the default first; clearing
 * a field he never set leaves no file behind. Retiring sets `retired: yes`, so the bin is the files that say so.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DEFAULT_PACK_FILES,
  FRONT_MATTER,
  isRetired,
  splitFront,
  TRAITS,
  traitsOf,
  type Trait,
  withFrontField,
} from "./osPack.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const personaFileOf = (packDir: string, personaId: string): string | null =>
  personaId === "executive"
    ? NodePath.join(packDir, "executive.md")
    : NAME.test(personaId)
      ? NodePath.join(packDir, "roles", `${personaId}.md`)
      : null;

const defaultText = (personaId: string): string =>
  personaId === "executive"
    ? DEFAULT_PACK_FILES.executive
    : (DEFAULT_PACK_FILES.roles[personaId] ?? "");

/** His file, or the default's text when he has none. */
const currentText = (file: string, personaId: string): string => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return defaultText(personaId);
  }
};

/** False for an id that is not a pack file. */
export const setPersonaField = (
  packDir: string,
  personaId: string,
  key: string,
  value: string | null,
): boolean => {
  const file = personaFileOf(packDir, personaId);
  if (file === null) return false;
  if (!NodeFS.existsSync(file)) {
    if (value === null) return true;
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, `${defaultText(personaId)}\n`, { flag: "wx" });
  }
  NodeFS.writeFileSync(file, withFrontField(NodeFS.readFileSync(file, "utf8"), key, value));
  return true;
};

/** What he sets on a persona; a field left out stays as it is, null takes it out. */
export interface PersonaDraft {
  readonly name?: string;
  readonly wake?: string | null;
  readonly voice?: string | null;
  readonly cloudVoice?: string | null;
  /** One of his saved clones' ids; `voice` stays the fallback where a clone cannot be spoken. */
  readonly cloneVoice?: string | null;
  /** One line of who it is and how it sounds. */
  readonly role?: string;
  /** Its personality, backstory and relationship to him: the brief its turns read. */
  readonly about?: string;
  readonly character?: string | null;
  readonly eyes?: string | null;
  /** Dials 0 to 1, merged over the ones it has. */
  readonly traits?: Readonly<Partial<Record<Trait, number>>>;
  readonly guilt?: number | null;
  /** Its brain: any provider's model name (routing picks the login), and effort. */
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly private?: boolean;
  /** Lines it may open with when first woken each day; empty or null takes them out. */
  readonly greetings?: ReadonlyArray<string> | null;
}

export const ABOUT_MAX = 4_000;
const LINE = /^[^\r\n]{0,200}$/;
const PERSONA_NAME = /^[\p{L}][\p{L}\p{N} '.-]{0,39}$/u;

/** Why the draft cannot be written, or null: one line per field keeps the file's front-matter intact. */
export const draftProblem = (draft: PersonaDraft): string | null => {
  if (draft.name !== undefined && !PERSONA_NAME.test(draft.name.trim()))
    return "A name is one to forty letters.";
  for (const [key, value] of Object.entries(draft))
    if (key !== "about" && typeof value === "string" && !LINE.test(value))
      return `The ${key} must be one short line.`;
  if (draft.about !== undefined && draft.about.length > ABOUT_MAX)
    return "The description is too long.";
  if (draft.about !== undefined && /^\s*---/.test(draft.about))
    return "The description cannot start with ---.";
  if ((draft.greetings?.length ?? 0) > 8) return "At most eight greetings.";
  for (const g of draft.greetings ?? [])
    if (!/^[^\r\n]{1,400}$/.test(g.trim()))
      return "Each greeting is one line of up to 400 letters.";
  for (const value of Object.values(draft.traits ?? {}))
    if (!(typeof value === "number" && value >= 0 && value <= 1))
      return "Each dial is between 0 and 1.";
  if (
    draft.guilt != null &&
    !(Number.isInteger(draft.guilt) && draft.guilt >= 0 && draft.guilt <= 3)
  )
    return "Guilt is 0 to 3.";
  return null;
};

const traitsLine = (traits: Readonly<Partial<Record<Trait, number>>>): string | null => {
  const parts = TRAITS.flatMap((t) => (traits[t] === undefined ? [] : [`${t} ${traits[t]}`]));
  return parts.length === 0 ? null : parts.join(", ");
};

/** The text with the draft applied over `text`; `about` replaces the brief. */
export const withDraft = (text: string, draft: PersonaDraft): string => {
  const { fields } = splitFront(text);
  const set: Array<readonly [string, string | null | undefined]> = [
    ["name", draft.name?.trim()],
    ["wake", draft.wake === undefined ? undefined : draft.wake?.trim() || null],
    ["voice", draft.voice === undefined ? undefined : draft.voice?.trim().toLowerCase() || null],
    [
      "cloud voice",
      draft.cloudVoice === undefined ? undefined : draft.cloudVoice?.trim().toLowerCase() || null,
    ],
    [
      "clone voice",
      draft.cloneVoice === undefined ? undefined : draft.cloneVoice?.trim().toLowerCase() || null,
    ],
    ["role", draft.role?.trim()],
    ["character", draft.character === undefined ? undefined : draft.character?.trim() || null],
    ["eyes", draft.eyes === undefined ? undefined : draft.eyes?.trim() || null],
    [
      "traits",
      draft.traits === undefined
        ? undefined
        : traitsLine({ ...traitsOf(fields["traits"]), ...draft.traits }),
    ],
    [
      "guilt",
      draft.guilt === undefined ? undefined : draft.guilt === null ? null : String(draft.guilt),
    ],
    ["model", draft.model === undefined ? undefined : draft.model?.trim() || null],
    ["effort", draft.effort === undefined ? undefined : draft.effort?.trim().toLowerCase() || null],
    ["private", draft.private === undefined ? undefined : draft.private ? "yes" : null],
    [
      "greetings",
      draft.greetings === undefined
        ? undefined
        : draft.greetings === null || draft.greetings.length === 0
          ? null
          : JSON.stringify(draft.greetings.map((g) => g.trim())),
    ],
  ];
  let out = text;
  for (const [key, value] of set) if (value !== undefined) out = withFrontField(out, key, value);
  if (draft.about === undefined) return out;
  const head = FRONT_MATTER.exec(out)?.[0] ?? "";
  return `${head.endsWith("\n") || head === "" ? head : `${head}\n`}${draft.about.trim()}\n`;
};

/** His file merged over the default's, field by field, as the roster reads it. */
const mergedText = (file: string, personaId: string): string => {
  const base = splitFront(defaultText(personaId));
  let mine: { readonly fields: Readonly<Record<string, string>>; readonly body: string } = {
    fields: {},
    body: "",
  };
  try {
    mine = splitFront(NodeFS.readFileSync(file, "utf8"));
  } catch {
    // the default alone
  }
  const lines = Object.entries({ ...base.fields, ...mine.fields }).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${mine.body === "" ? base.body : mine.body}\n`;
};

/** A free file stem for a new persona's name ("Luna Rae" → `luna-rae`, then `luna-rae-2`). */
export const personaIdFor = (name: string, taken: ReadonlySet<string>): string => {
  const stem =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "persona";
  let id = stem;
  for (let n = 2; taken.has(id) || id === "executive"; n++) id = `${stem}-${n}`;
  return id;
};

/** The ids every role file or default already uses, retired ones included. */
export const takenIds = (packDir: string): Set<string> => {
  const ids = new Set(Object.keys(DEFAULT_PACK_FILES.roles));
  try {
    for (const f of NodeFS.readdirSync(NodePath.join(packDir, "roles")))
      if (f.endsWith(".md")) ids.add(f.slice(0, -3));
  } catch {
    // no role files of his yet
  }
  return ids;
};

/** A new face from his draft; returns its id. Never overwrites a file. */
export const createPersona = (
  packDir: string,
  draft: PersonaDraft & { readonly name: string },
): string => {
  const id = personaIdFor(draft.name, takenIds(packDir));
  const file = personaFileOf(packDir, id)!;
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, withDraft("", draft), { flag: "wx" });
  return id;
};

/** His draft over a persona's file (made from the default when he has none). False for an id that is not a pack file. */
export const editPersona = (packDir: string, personaId: string, draft: PersonaDraft): boolean => {
  const file = personaFileOf(packDir, personaId);
  if (file === null) return false;
  const dials = splitFront(mergedText(file, personaId)).fields["traits"];
  const full =
    draft.traits === undefined
      ? draft
      : { ...draft, traits: { ...traitsOf(dials), ...draft.traits } };
  const text = withDraft(currentText(file, personaId), full);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
  return true;
};

/** A copy under a new name: same dials, voice, brain and brief; no wake word (one word wakes one face) and not retired. */
export const duplicatePersona = (packDir: string, fromId: string, name: string): string | null => {
  const from = personaFileOf(packDir, fromId);
  if (from === null || fromId === "executive") return null;
  const text = mergedText(from, fromId);
  if (splitFront(text).fields["name"] === undefined) return null;
  const id = personaIdFor(name, takenIds(packDir));
  const copy = withFrontField(
    withFrontField(withDraft(text, { name }), "wake", null),
    "retired",
    null,
  );
  NodeFS.writeFileSync(personaFileOf(packDir, id)!, copy, { flag: "wx" });
  return id;
};

/** Into the bin or back out; the lead never retires. False for an id that is not a role. */
export const setRetired = (packDir: string, personaId: string, retired: boolean): boolean =>
  personaId !== "executive" &&
  setPersonaField(packDir, personaId, "retired", retired ? "yes" : null);

/** His bin: each retired persona's id and name. */
export const retiredPersonas = (
  packDir: string,
): ReadonlyArray<{ readonly id: string; readonly name: string }> =>
  [...takenIds(packDir)].flatMap((id) => {
    let text: string;
    try {
      text = NodeFS.readFileSync(personaFileOf(packDir, id)!, "utf8");
    } catch {
      return [];
    }
    const { fields } = splitFront(text);
    const name = fields["name"] ?? splitFront(defaultText(id)).fields["name"] ?? "";
    return isRetired(fields) && name !== "" ? [{ id, name }] : [];
  });
