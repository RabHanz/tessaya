/**
 * What she says, rewritten for the voice before it is synthesised: names and acronyms respelled, and things
 * written for the eye (a link, a path, a version, a time zone, an ISO date, an emoji) put the way a person says
 * them. The text on screen and in her echo checks stays as written; only the voice hears this.
 */

/** Built in. Acronyms match only in capitals ("PR", never "pr" in "print"); names match in any case. */
const RESPELLINGS: Readonly<Record<string, string>> = {
  // How he says them (British): tess-AY-uh, FRAY-uh.
  Tessaya: "Tess-ay-uh",
  Freya: "Fray-uh",
  Baton: "Batton",
  T3: "T three",
  VPN: "V P N",
  VPNs: "V P Ns",
  CI: "C I",
  PR: "P R",
  PRs: "P Rs",
  URL: "U R L",
  URLs: "U R Ls",
  API: "A P I",
  APIs: "A P Is",
  SQL: "S Q L",
  GMT: "G M T",
  UTC: "U T C",
};

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

/** Whole words from both lists; his own win over the built-in ones. One pass, so nothing is respelled twice. */
const respell = (text: string, his: Readonly<Record<string, string>>): string => {
  const table = new Map<string, string>();
  const anyCase = new Map<string, string>();
  for (const [word, said] of [...Object.entries(RESPELLINGS), ...Object.entries(his)]) {
    const key = word.trim();
    if (key === "" || typeof said !== "string") continue;
    if (caseMatters(key)) table.set(key, said);
    else anyCase.set(key.toLowerCase(), said);
  }
  const words = [...table.keys(), ...anyCase.keys()].sort((a, b) => b.length - a.length);
  if (words.length === 0) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${words.map(escape).join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return text.replace(
    pattern,
    (found) => table.get(found) ?? anyCase.get(found.toLowerCase()) ?? found,
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

/** A reply as the voice should say it. `his` is his own list (word → how to say it) from the voice settings. */
export const pronounce = (text: string, his: Readonly<Record<string, string>> = {}): string =>
  respell(
    text
      // A link reads as its words; a bare address as its site.
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\bhttps?:\/\/(?:www\.)?([^/\s)]+)[^\s)]*/gi, (_, host: string) => dots(host))
      .replace(/\bwww\.([^/\s)]+)[^\s)]*/gi, (_, host: string) => dots(host))
      // A path reads as the file it names: "apps/desktop/src/core.ts" is "core dot ts".
      .replace(
        /(?:[A-Za-z]:\\|~?\/)?(?:[\w.-]+[\\/])+([\w-]+\.[A-Za-z0-9]{1,5})\b/g,
        (_, file: string) => dots(file),
      )
      .replace(/(?:^|\s)(?:[A-Za-z]:\\|~\/|\/)(?:[\w.-]+[\\/]?)+/g, (path) => {
        const last = path.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? "";
        return ` ${dots(last)}`;
      })
      // A version: "0.1.73" is "0 point 1 point 73" (a plain decimal is read well already).
      .replace(/\bv?(\d+(?:\.\d+){2,})\b/g, (_, version: string) =>
        version.split(".").join(" point "),
      )
      // A time zone: "GMT+5" is "G M T plus 5".
      .replace(
        /\b(GMT|UTC)\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?\b/g,
        (_, zone: string, sign: string, hours: string, minutes?: string) =>
          `${zone} ${sign === "+" ? "plus" : "minus"} ${Number(hours)}${minutes !== undefined && minutes !== "00" ? ` ${minutes}` : ""}`,
      )
      // An ISO date, the British way: "2026-11-07" is "7 November 2026".
      .replace(
        /\b(\d{4})-(\d{2})-(\d{2})\b/g,
        (whole, year: string, month: string, day: string) => {
          const name = MONTHS[Number(month) - 1];
          return name === undefined || Number(day) < 1 || Number(day) > 31
            ? whole
            : `${Number(day)} ${name} ${year}`;
        },
      )
      // A time: "14:00" is "14 hundred", "9:05" is "9 oh 5", "9:30" is "9 30".
      .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hours: string, minutes: string) =>
        minutes === "00"
          ? `${Number(hours)} ${Number(hours) > 12 ? "hundred" : "o'clock"}`
          : minutes.startsWith("0")
            ? `${Number(hours)} oh ${minutes[1]}`
            : `${Number(hours)} ${minutes}`,
      )
      // Emoji and the joiners between them say nothing.
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
      .replace(/\s+([.,!?;:])/g, "$1")
      // Markdown the voice would read out: table rules, strikethrough, list bullets.
      .replace(/[|~]/g, " ")
      .replace(/^\s*[-•]\s+/gm, ""),
    his,
  );
