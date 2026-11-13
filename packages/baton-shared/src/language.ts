/**
 * Whether a transcript is mostly another language: an English recogniser writes Dutch or Portuguese from a TV as
 * half-words and their own function words (13 Nov, 10:35: "Ik heb… Foi já gente. Quem quer essa trilha?"). Shared,
 * so every vessel can keep a room's other languages out of her turns.
 */
const FOREIGN = new Set([
  // Dutch
  "ik",
  "heb",
  "mijn",
  "het",
  "een",
  "niet",
  "wat",
  "zijn",
  "jij",
  "maar",
  "ook",
  "voor",
  "nie",
  "dit",
  "wij",
  "hij",
  "zij",
  // Portuguese and Spanish
  "que",
  "quem",
  "quer",
  "essa",
  "esse",
  "isso",
  "não",
  "nao",
  "você",
  "voce",
  "gente",
  "foi",
  "está",
  "esta",
  "muito",
  "para",
  "uma",
  "com",
  "el",
  "los",
  "las",
  "pero",
  "porque",
  "como",
  "eso",
  "ese",
  "eu",
  "ele",
  "ela",
  "tambem",
  "também",
  // German and French
  "ich",
  "und",
  "nicht",
  "der",
  "das",
  "ist",
  "wir",
  "les",
  "est",
  "pas",
  "une",
  "des",
  "avec",
  "pour",
  "oui",
  "mais",
]);

/** Mostly another language: two of its function words at least, and two in ten words foreign (accents count half). */
export const mostlyForeign = (text: string): boolean => {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  if (words.length < 4) return false;
  const known = words.filter((w) => FOREIGN.has(w)).length;
  const accented = words.filter((w) => !FOREIGN.has(w) && /[à-öø-ÿ]/.test(w)).length;
  return known >= 2 && (known + accented / 2) / words.length >= 0.2;
};
