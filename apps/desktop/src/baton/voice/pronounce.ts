/**
 * What she says, rewritten for the voice before it is synthesised: names and acronyms respelled, and things
 * written for the eye (a link, a path, a version, a time, a date, an emoji) put the way he says them (British).
 * The text on screen stays as written; only the voice hears this.
 */

/**
 * How her name is said: tess-AY-uh (tɛsˈeɪə), the middle syllable stressed and rhyming with "say". "Tessayya" is his
 * pick by ear (pronounce-4, candidate 4); his own pronounce list still wins over it.
 */
const TESSAYA_SAID = "Tessayya";

/** Built in. Acronyms match only in capitals ("PR", never "pr" in "print"); names match in any case. */
const RESPELLINGS: Readonly<Record<string, string>> = {
  // How he says it (British): FRAY-uh.
  Freya: "Fray-uh",
  Tessaya: TESSAYA_SAID,
  Baton: "Batton",
  T3: "T three",
  // Pocket TTS already says VPN, CI, API, URL and SQL as letters (0.1.73 round trip); "C I" was heard as "See I".
  PR: "P R",
  PRs: "P Rs",
  GMT: "G M T",
  UTC: "U T C",
};
/** Built-in words matched only as written: the product, never "she passed the baton". */
const AS_WRITTEN = new Set(["Baton"]);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Two capitals, or a capital and a digit ("PR", "T3"): an acronym, matched only as written. */
const caseMatters = (word: string): boolean => /[A-Z].*[A-Z0-9]|[0-9].*[A-Z]/.test(word);

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "github.com" → "github dot com". */
const dots = (text: string): string => text.split(".").filter(Boolean).join(" dot ");

/** File extensions the way he says them (0.1.74); any other is spelled as letters. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  md: "M D",
  ts: "T S",
  tsx: "T S X",
  json: "jason",
  yaml: "yammel",
  yml: "yammel",
  webmanifest: "web manifest",
  sqlite: "S Q lite",
  exe: "exe",
  ps1: "P S one",
  mjs: "M J S",
  png: "P N G",
  svg: "S V G",
  html: "H T M L",
  css: "C S S",
  py: "pie",
  rs: "R S",
  toml: "tomel",
  lock: "lock",
  env: "env",
  log: "log",
  zip: "zip",
};
const sayExtension = (ext: string): string =>
  EXTENSIONS[ext.toLowerCase()] ?? ext.toUpperCase().split("").join(" ");

/** A file as said: its name ("SECURITY" as the word), "dot", and its extension ("index.test.ts": "index dot test dot T S"). */
const sayFile = (file: string): string => {
  // A short ALL-CAPS name is an acronym, spelled ("PR" is "P R"); a longer one is a word ("SECURITY" is "security").
  const word = (part: string) =>
    /^[A-Z]{2,3}$/.test(part)
      ? part.split("").join(" ")
      : /^[A-Z][A-Z0-9_-]+$/.test(part)
        ? part.toLowerCase()
        : part;
  // A dotfile is all name: ".env.local" is "dot env dot local".
  if (file.startsWith("."))
    return `dot ${file.slice(1).split(".").filter(Boolean).map(word).join(" dot ")}`;
  const at = file.lastIndexOf(".");
  const name = file.slice(0, Math.max(0, at)).split(".").filter(Boolean).map(word).join(" dot ");
  return `${name === "" ? "" : `${name} `}dot ${sayExtension(file.slice(at + 1))}`;
};
const KNOWN = Object.keys(EXTENSIONS).concat(["js", "txt", "csv"]).join("|");

/** Whole words from both lists; his own win over the built-in ones. One pass, so nothing is respelled twice. */
const respell = (text: string, his: Readonly<Record<string, string>>): string => {
  const exact = new Map<string, string>();
  const anyCase = new Map<string, string>();
  const add = (key: string, said: string, asWritten: boolean) => {
    exact.delete(key);
    anyCase.delete(key.toLowerCase());
    if (asWritten) exact.set(key, said);
    else anyCase.set(key.toLowerCase(), said);
  };
  for (const [word, said] of Object.entries(RESPELLINGS))
    add(word, said, caseMatters(word) || AS_WRITTEN.has(word));
  for (const [word, said] of Object.entries(his)) {
    const key = word.trim();
    if (key !== "" && typeof said === "string") add(key, said, caseMatters(key));
  }
  const words = [...exact.keys(), ...anyCase.keys()].sort((a, b) => b.length - a.length);
  if (words.length === 0) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${words.map(escape).join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return text.replace(
    pattern,
    (found) => exact.get(found) ?? anyCase.get(found.toLowerCase()) ?? found,
  );
};

/** "14:00" is "2 pm", "00:00" "midnight", "9:05" "9 oh 5"; a 12-hour time keeps his am or pm. */
const clock = (hours: number, minutes: string, meridiem?: string): string => {
  const after =
    minutes === "00" ? "" : minutes.startsWith("0") ? ` oh ${minutes[1]}` : ` ${minutes}`;
  if (meridiem !== undefined)
    return `${hours}${after} ${meridiem.toLowerCase().replace(/\./g, "")}`;
  if (after === "" && hours === 0) return "midnight";
  if (after === "" && hours === 12) return "noon";
  if (hours > 12) return `${hours - 12}${after} pm`;
  return `${hours === 0 ? 12 : hours}${after}${hours === 0 ? " am" : ""}`;
};

/** Accents or another script: not English, so its numbers and times are left as they are. */
const notEnglish = (text: string): boolean =>
  /[À-ÖØ-öø-ÿĀ-ž]|[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text);

/** Times, dates, zones, versions and addresses written in figures, said the way he says them. */
const figures = (text: string): string =>
  text
    // A time zone: "GMT+5" is "G M T plus 5".
    .replace(
      /\b(GMT|UTC)\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?\b/g,
      (_, zone: string, sign: string, hours: string, minutes?: string) =>
        `${zone} ${sign === "+" ? "plus" : "minus"} ${Number(hours)}${minutes !== undefined && minutes !== "00" ? ` ${minutes}` : ""}`,
    )
    // A date, the British way: "2026-11-07" and "07.11.2026" are "7 November 2026".
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, year: string, month: string, day: string) =>
      date(whole, day, month, year),
    )
    .replace(
      /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g,
      (whole, day: string, month: string, year: string) => date(whole, day, month, year),
    )
    // An address: "192.168.1.1" is said with "dot".
    .replace(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g, (ip: string) =>
      ip.split(".").every((part) => Number(part) <= 255) ? ip.split(".").join(" dot ") : ip,
    )
    // A version: "v0.1.73" is "version 0 point 1 point 73" (a plain decimal is read well already).
    .replace(
      /\b(v)?(\d{1,3}\.\d{1,3}\.\d{1,4})\b/gi,
      (_, v: string | undefined, version: string) =>
        `${v === undefined ? "" : "version "}${version.split(".").join(" point ")}`,
    )
    // A span of times: "10:30-11:00" is "10 30 to 11".
    .replace(
      /\b([01]?\d|2[0-3]):([0-5]\d)\s*[-–]\s*([01]?\d|2[0-3]):([0-5]\d)\b/g,
      (_, h1: string, m1: string, h2: string, m2: string) =>
        `${clock(Number(h1), m1)} to ${clock(Number(h2), m2)}`,
    )
    .replace(
      /\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*([ap](?:\.m\.|m))(?![a-z]))?/gi,
      (_, hours: string, minutes: string, meridiem?: string) =>
        clock(Number(hours), minutes, meridiem),
    )
    .replace(/~\s*(\d)/g, "about $1");

const date = (whole: string, day: string, month: string, year: string): string => {
  const name = MONTHS[Number(month) - 1];
  return name === undefined || Number(day) < 1 || Number(day) > 31
    ? whole
    : `${Number(day)} ${name} ${year}`;
};

/** A reply as the voice should say it. `his` is his own list (word → how to say it) from the voice settings. */
export const pronounce = (text: string, his: Readonly<Record<string, string>> = {}): string => {
  const written = text
    // A link reads as its words; a bare address as its site, its sentence's punctuation kept.
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)[^\s]*[^\s.,;:!?)]/gi, (url) =>
      dots(url.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").split(/[/?#]/)[0] ?? ""),
    )
    // A path reads as only the file it names ("apps/desktop/src/core.ts" is "core dot T S"), its folders dropped,
    // dot-folders too; a drive or root may have spaces in its folders. The file needs a letter in its name and its
    // extension: "1/2.5" is a number.
    .replace(
      /(?:[A-Za-z]:\\(?:[^\\\n]+\\)*|~?\/(?:[^/\n]+\/)*|(?:[\w.-]+[\\/])+)(\.[A-Za-z][\w-]*(?:\.[\w-]+)*|[\w-]*[A-Za-z][\w-]*(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,15})\b/g,
      (_, file: string) => sayFile(file),
    )
    // A whole file name with a known extension, or a dotfile on its own (".env").
    .replace(
      new RegExp(
        `\\b[A-Za-z][\\w-]*(?:\\.[\\w-]+)*\\.(?:${KNOWN})\\b|(?<![\\w.])\\.(?:${KNOWN})\\b`,
        "gi",
      ),
      (file: string) => sayFile(file),
    );
  return (
    respell(notEnglish(written) ? written : figures(written), his)
      // Emoji, keycaps and the joiners between them say nothing.
      .replace(/[0-9#*]\u{FE0F}?\u{20E3}\s?/gu, "")
      .replace(/(?:\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3})+\s?/gu, "")
      .replace(/\s+([.,!?;:])/g, "$1")
      // Markdown the voice would read out: table rules, strikethrough, list bullets.
      .replace(/[|~]/g, " ")
      .replace(/^\s*[-•]\s+/gm, "")
      .replace(/[ \t]{2,}/g, " ")
  );
};

/** His list as saved: only word → text pairs, anything else in the file is left out. */
export const pronounceFrom = (saved: unknown): Readonly<Record<string, string>> =>
  saved === null || typeof saved !== "object" || Array.isArray(saved)
    ? {}
    : Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, string] =>
            entry[0].trim() !== "" && typeof entry[1] === "string" && entry[1].trim() !== "",
        ),
      );
