/**
 * What she says when he only says her name (or presses S2) and then nothing: a varied, short "I'm here", never the same
 * line twice in a row, and sometimes no words at all, only her look. Pure: the loop gives the context, then speaks
 * the line (pre-rendered, so it is instant) or not.
 * @module baton-voice/room/acknowledge
 */

export type Acknowledge = "voice" | "tone" | "off";

/** Lines any persona may say; a persona's own lines are added to these. `{name}` is his name, once a session. */
const COMMON = ["Yes?", "Mm?", "I'm here.", "Go on.", "Hey."];
const BY_PERSONA: Readonly<Record<string, ReadonlyArray<string>>> = {
  butler: ["At your service.", "Sir?"],
};
const WITH_NAME = ["What's up, {name}?", "Yes, {name}?"];

/** Every line a persona may say: what the loop renders ahead so the answer is instant. */
export const ackLines = (personaId: string): ReadonlyArray<string> => [
  ...COMMON,
  ...(BY_PERSONA[personaId] ?? []),
  "Morning.",
  "Still here.",
];

export interface AckContext {
  readonly personaId: string;
  /** The house's hour, 0 to 23. */
  readonly hour: number;
  /** Since her last exchange with him in this session (Infinity when none). */
  readonly sinceExchangeMs: number;
  /** Since her last acknowledgement (Infinity when none). */
  readonly sinceAckMs: number;
  /** His name when he is recognised and she has not said it yet this session; null otherwise. */
  readonly name: string | null;
  /** Her last acknowledgement line, never said twice running. */
  readonly last: string | null;
}

/** The line to say, or null for no words (her look alone). `random` is 0 to 1. */
export const pickAck = (c: AckContext, random: () => number): string | null => {
  // Woken again within minutes: often no words at all, only the look.
  if (c.sinceAckMs < 3 * 60_000 && random() < 0.6) return null;
  if (random() < 0.12) return null;
  const pool: string[] = [];
  if (c.sinceExchangeMs < 5 * 60_000) pool.push("Still here.", "Still here.");
  else if (c.hour >= 5 && c.hour < 11) pool.push("Morning.", "Morning.");
  if (c.name !== null) pool.push(...WITH_NAME.map((l) => l.replace("{name}", c.name!)));
  pool.push(...COMMON, ...(BY_PERSONA[c.personaId] ?? []));
  const fresh = pool.filter((l) => l !== c.last);
  return fresh[Math.floor(random() * fresh.length)] ?? null;
};
