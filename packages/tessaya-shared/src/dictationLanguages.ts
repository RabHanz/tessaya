/**
 * Dictation languages. The multilingual speech model (Parakeet v3) recognises these 25 European
 * languages and can tell which one is being spoken; the fast English model recognises English only.
 * Anything else is not supported by either, and the window says so rather than pretending.
 */
export const PARAKEET_V3_LANGUAGES: ReadonlyArray<readonly [code: string, name: string]> = [
  ["bg", "Bulgarian"],
  ["hr", "Croatian"],
  ["cs", "Czech"],
  ["da", "Danish"],
  ["nl", "Dutch"],
  ["en", "English"],
  ["et", "Estonian"],
  ["fi", "Finnish"],
  ["fr", "French"],
  ["de", "German"],
  ["el", "Greek"],
  ["hu", "Hungarian"],
  ["it", "Italian"],
  ["lv", "Latvian"],
  ["lt", "Lithuanian"],
  ["mt", "Maltese"],
  ["pl", "Polish"],
  ["pt", "Portuguese"],
  ["ro", "Romanian"],
  ["ru", "Russian"],
  ["sk", "Slovak"],
  ["sl", "Slovenian"],
  ["es", "Spanish"],
  ["sv", "Swedish"],
  ["uk", "Ukrainian"],
];

export type SpeechModelChoice = "v3" | "fast";

/** The languages he speaks, as saved: none means detect any. An older single `language` carries over. */
export const languagesFromSaved = (
  saved: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> => {
  const known = (code: unknown): code is string =>
    typeof code === "string" && PARAKEET_V3_LANGUAGES.some(([c]) => c === code);
  if (Array.isArray(saved["languages"])) return [...new Set(saved["languages"].filter(known))];
  if (saved["language"] === null) return [];
  return known(saved["language"]) ? [saved["language"]] : ["en"];
};

/** The hint the recogniser is given: only one language can be forced. */
export const recogniserHint = (languages: ReadonlyArray<string>): string | null =>
  languages.length === 1 ? languages[0]! : null;

export const languageName = (code: string): string =>
  PARAKEET_V3_LANGUAGES.find(([c]) => c === code)?.[1] ?? code;

/** A language typed into the list ("French", "fr"), or undefined when the model has no such language. */
export const languageCode = (model: SpeechModelChoice, typed: string): string | undefined => {
  const t = typed.trim().toLowerCase();
  const found = PARAKEET_V3_LANGUAGES.find(([c, n]) => c === t || n.toLowerCase() === t)?.[0];
  return model === "fast" && found !== "en" ? undefined : found;
};

/**
 * Words common in one language and rare in the others, for telling which one a short transcript is in.
 * Parakeet v3 takes no language hint, so English said in a British accent can come back Dutch, Swedish
 * or Portuguese; this is how that is caught.
 */
const WORDS: Readonly<Record<string, string>> = {
  en: "the and is are you what to of it that this my can me be do not have will with your how was",
  nl: "ik weet niet het een maar ook zijn wij jij hij zij dit wel nog geen hoe waar wie zeg zegt heb mij mijn jou naar nee dank jullie",
  sv: "det och jag inte vad nej hej har ska som att bara säger är också",
  da: "ikke jeg og hvad hvor deg også",
  de: "ich nicht und ist das ein eine nein wir aber auch doch sagt weiß bitte danke",
  fr: "je oui est et cest suis pas une les des mais avec merci bonjour",
  es: "pero sí hola gracias tengo está estoy",
  pt: "eu deixa tentar não obrigado você isso mas",
  it: "sono che non grazie ciao della questo anche perché",
  pl: "nie tak jest się że jak mam dziękuję",
};
const LISTS = Object.entries(WORDS).map(
  ([code, words]) => [code, new Set(words.split(" "))] as const,
);

/** The language a transcript reads as, or null when it cannot be told (short, mixed, names). */
export const heardLanguage = (text: string): string | null => {
  if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
  if (/\p{Script=Greek}/u.test(text)) return "el";
  const words = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  let best: string | null = null;
  let top = 0;
  let tied = false;
  for (const [code, list] of LISTS) {
    const n = words.filter((w) => list.has(w)).length;
    if (n > top) [best, top, tied] = [code, n, false];
    else if (n === top && n > 0) tied = true;
  }
  // Two words of a short sentence can both be English loans ("Las Vegas"): one hit decides only from three words.
  const enough = top >= 2 || words.length >= 3;
  return best !== null && !tied && enough && top * 2 >= words.length ? best : null;
};

/** The language it was heard in when that is not one of his (Cyrillic counts as any of its three). */
export const outsideLanguages = (text: string, languages: ReadonlyArray<string>): string | null => {
  const heard = heardLanguage(text);
  if (heard === null || languages.length === 0) return null;
  const family = heard === "ru" ? ["ru", "uk", "bg"] : [heard];
  return family.some((c) => languages.includes(c)) ? null : heard;
};

export const LANGUAGE_HINT =
  "Add the languages you speak; with none, any is detected. With one, anything heard in another language is set aside; with several, only those are kept. The multilingual model recognises 25 European languages (Bulgarian to Ukrainian, listed below) and can detect which you speak. It does not recognise Chinese, Japanese, Korean, Arabic, Hindi or other languages, and it has no regional spellings such as British English. The fast model is English only.";
