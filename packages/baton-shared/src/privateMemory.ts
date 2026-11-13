/**
 * Private memory stores' rules (tessaya-ops research/PRIVATE-MEMORIES.md): PINs, the wrong-PIN wait, when a store
 * re-locks, and which store a turn may read or write. Pure; the server holds the keys and the desktop asks.
 */

export type PrivateStoreKind = "owner" | "person";
export const OWNER_PERSON_ID = "owner";

/** Why a PIN is refused, in words he can read, or null. The owner's is longer: his store opens everyone's. */
export const pinProblem = (pin: string, kind: PrivateStoreKind): string | null => {
  const digits = /^\d+$/.test(pin);
  if (kind === "person") {
    if (!digits || pin.length !== 6) return "A PIN is 6 digits.";
  } else if (digits ? pin.length < 8 : pin.length < 12) {
    return "Your PIN needs at least 8 digits, or a passphrase of 12 characters or more.";
  }
  if (!digits)
    return new Set(pin.toLowerCase()).size < 5 ? "That passphrase repeats too much." : null;
  if (new Set(pin).size === 1) return "A PIN of one digit repeated is too easy to guess.";
  const steps = [...pin].slice(1).map((d, i) => Number(d) - Number(pin[i]));
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1))
    return "A run of digits is too easy to guess.";
  if (kind === "owner" && pin.length === 8 && looksLikeDate(pin))
    return "A date is too easy to guess.";
  return null;
};

const looksLikeDate = (pin: string): boolean => {
  const valid = (y: number, m: number, d: number) =>
    y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const n = (a: number, b: number) => Number(pin.slice(a, b));
  return (
    valid(n(0, 4), n(4, 6), n(6, 8)) ||
    valid(n(4, 8), n(2, 4), n(0, 2)) ||
    valid(n(4, 8), n(0, 2), n(2, 4))
  );
};

export interface LockoutState {
  /** Wrong PINs in a row. */
  readonly failures: number;
  /** Epoch ms until which no PIN is tried, 0 when none. */
  readonly waitUntil: number;
}
export const NO_LOCKOUT: LockoutState = { failures: 0, waitUntil: 0 };
const MINUTE = 60_000;
/** After this many wrong PINs in a row, only his recovery code opens his store. */
export const OWNER_RECOVERY_ONLY_AFTER = 20;

/** Five wrong PINs, then a wait (his 15 min, a person's 5) that doubles every three more. */
export const afterWrongPin = (
  kind: PrivateStoreKind,
  state: LockoutState,
  now: number,
): LockoutState => {
  const failures = state.failures + 1;
  if (failures < 5) return { failures, waitUntil: 0 };
  const base = (kind === "owner" ? 15 : 5) * MINUTE;
  return { failures, waitUntil: now + base * 2 ** Math.floor((failures - 5) / 3) };
};

export type PinGate =
  | { readonly kind: "try" }
  | { readonly kind: "wait"; readonly until: number }
  | { readonly kind: "recovery-only" };
export const pinGate = (kind: PrivateStoreKind, state: LockoutState, now: number): PinGate =>
  kind === "owner" && state.failures >= OWNER_RECOVERY_ONLY_AFTER
    ? { kind: "recovery-only" }
    : state.waitUntil > now
      ? { kind: "wait", until: state.waitUntil }
      : { kind: "try" };

/** How long an opened store stays open: idle, and at most. */
export const relockAfter = (
  kind: PrivateStoreKind,
): { readonly idleMs: number; readonly maxMs: number } =>
  kind === "owner"
    ? { idleMs: 5 * MINUTE, maxMs: 30 * MINUTE }
    : { idleMs: 2 * MINUTE, maxMs: 15 * MINUTE };

/** The voice ID lane's `SpeakerIdentity` (packages/baton-voice/src/speaker.ts), the fields this needs. */
export interface SpeakerLike {
  readonly kind: "owner" | "saved" | "guest" | "unverified";
  readonly personId: string | null;
  readonly verified: boolean;
  readonly inherited: boolean;
  /** Raw cosine to the matched voice (Voice ID's `confidence`), carried so a turn says how close it was. */
  readonly confidence?: number | null;
}

/**
 * Where a turn came from: his own assistant session, a saved person's outside session, a standing job, the phone
 * relay, or an outside agent. Only the first two ever touch a private store.
 */
export type PrivateRoute = "assistant" | "outside" | "standing" | "phone" | "agent";

export interface PrivateTurn {
  readonly route: PrivateRoute;
  /** Typed into his desktop window: that is him (Director, 2026-11-11). */
  readonly typed: boolean;
  /** The turn read a page, file or message: whatever it asks is data, so nothing private is read or written. */
  readonly tainted: boolean;
  readonly speaker: SpeakerLike | null;
  /**
   * A typed turn's own device: the member its signed-in session acts for (identity I-2). Absent is his desktop; null is
   * a session that names a member badly, so nobody.
   */
  readonly member?: string | null;
}

/** Whose private store this turn speaks for, or why none. Identity only narrows: a near match is nobody. */
export const privatePersonOf = (
  turn: PrivateTurn,
): { readonly personId: string } | { readonly refused: string } => {
  if (turn.tainted) return { refused: "this turn read something from outside" };
  if (turn.route === "assistant") {
    if (turn.typed)
      return turn.member === undefined
        ? { personId: OWNER_PERSON_ID }
        : turn.member === null
          ? { refused: "this device acts for nobody in the household" }
          : { personId: turn.member };
    const s = turn.speaker;
    if (s?.kind === "owner" && s.verified && !s.inherited) return { personId: OWNER_PERSON_ID };
    return { refused: "the voice was not verified as his" };
  }
  if (turn.route === "outside") {
    const s = turn.speaker;
    if (s?.kind === "saved" && s.personId !== null && s.verified && !s.inherited)
      return { personId: s.personId };
    return { refused: "the voice was not verified as a saved person" };
  }
  return { refused: "private memories are only for the assistant's own turns" };
};

/** Words that make a memory private: faith, family and relationships, identity, health and feelings, home and money. */
const PRIVATE_WORDS =
  /\b(pray(?:er|ers|ing|s)?|fajr|dhuhr|zuhr|asr|maghrib|isha|qur'?an|allah|islam\w*|muslim|faith|church|god|ramadan|daughters?|sons?|kids?|children|wife|husband|partner|girlfriend|boyfriend|married|divorc\w*|anniversary|birthday|pregnan\w*|mother|father|mum|mom|dad|brother|sister|family|gay|lesbian|bisexual|orientation|sick|illness|health|doctor|diagnos\w*|medic\w*|therap\w*|depress\w*|anxi\w*|grief|lonely|password|address|salary|debt|loan|income)\b/i;
export const looksPrivate = (text: string): boolean => PRIVATE_WORDS.test(text);

/** What every log, Record line and conversation file gets in place of a private turn's words. */
export const PRIVATE_TURN_STUB = "[private turn]";
export const usedPrivateLine = (count: number, whose: string): string =>
  `used ${count} private ${count === 1 ? "memory" : "memories"} (${whose})`;
