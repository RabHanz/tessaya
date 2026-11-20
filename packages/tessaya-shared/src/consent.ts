/**
 * His standing yeses ("Always allow"), one list on his server (`baton.consent.*`) that every vessel reads; the desktop
 * keeps a copy for when the server is away. A yes counts only for him, so a guest is still asked.
 */

import { OWNER_MEMBER_ID } from "./household.ts";

/** Seeing his screen: the one key every look path (the desktop's own, a device's, the phone's) checks. */
export const LOOK_GRANT = "screen_look";

/** His "this is my voice, or I have their permission" for one clone; revoking it silences that clone. */
export const cloneGrant = (id: string): string => `voice_clone|${id}`;

export const GRANTS_MAX = 50;

/** One act he answered "Always allow" to: the tool, the reason it asks, and the app (none for a job act). */
export const standingKey = (tool: string, why: string, app = ""): string => `${tool}|${why}|${app}`;

/** The app part of a standing key for an act on one web site, so his "Always allow" on one site holds on that site alone. */
export const siteScope = (host: string): string => `site:${host}`;

/** His standing yes for changing one house device without a card ("remember you don't need approval for the pump"). */
export const houseGrant = (entityId: string, name: string): string =>
  standingKey("house", name.replace(/\|/g, " ").slice(0, 80), entityId);
/** The house device a key is his standing yes for, or null. */
export const houseGrantEntity = (key: string): string | null => {
  const [tool, , entity] = key.split("|");
  return tool === "house" && entity !== undefined && entity !== "" ? entity : null;
};

export const withGrant = (keys: ReadonlyArray<string>, key: string, allow: boolean): string[] =>
  allow
    ? [...keys.filter((k) => k !== key), key].slice(-GRANTS_MAX)
    : keys.filter((k) => k !== key);

/**
 * A standing yes holds only for him: at his own keyboard, or his voice verified on this turn (Voice ID's session hold
 * counts). Any other voice, a guest's or an unverified one, is asked as before.
 */
export const stands = (
  keys: ReadonlyArray<string>,
  key: string,
  who: { readonly his: boolean },
): boolean => who.his && keys.includes(key);

/**
 * One standing yes as the server keeps it: whose it is and what it covers, optionally only on one device or for one
 * persona, until a time (ms). A bare key in an older list is the owner's, everywhere, for good.
 */
export interface Grant {
  readonly key: string;
  readonly member: string;
  readonly device?: string;
  readonly persona?: string;
  readonly until?: number;
}

export const grantOf = (entry: string | Grant): Grant =>
  typeof entry === "string" ? { key: entry, member: OWNER_MEMBER_ID } : entry;

/** Adds (replacing the same key and scope) or revokes every grant of a key; the newest fifty are kept. */
export const withScopedGrant = (
  grants: ReadonlyArray<Grant>,
  grant: Grant,
  allow: boolean,
): Grant[] => {
  const same = (g: Grant) =>
    g.key === grant.key &&
    (!allow ||
      (g.member === grant.member && g.device === grant.device && g.persona === grant.persona));
  const rest = grants.filter((g) => !same(g));
  return allow ? [...rest, grant].slice(-GRANTS_MAX) : rest;
};

/** The keys that stand now, for lists and the desktop's copy. */
export const liveKeys = (grants: ReadonlyArray<Grant>, now: number): string[] => [
  ...new Set(grants.filter((g) => (g.until ?? Infinity) > now).map((g) => g.key)),
];

/**
 * Whether a granted capability is asked no more: the turn is the member's own (their voice known at A1 or better, or
 * their signed-in device), untainted, on the grant's device and persona if it names one, before it ends. A guest's
 * voice (no member) or an unverified one (A0) is asked whatever was granted.
 */
export const grantHolds = (
  grants: ReadonlyArray<Grant>,
  key: string,
  who: {
    readonly member: string | null;
    readonly assurance: number;
    readonly tainted?: boolean;
    readonly device?: string;
    readonly persona?: string | null;
  },
  now: number,
): boolean =>
  who.member !== null &&
  who.assurance >= 1 &&
  who.tainted !== true &&
  grants.some(
    (g) =>
      g.key === key &&
      g.member === who.member &&
      (g.device === undefined || g.device === who.device) &&
      (g.persona === undefined || g.persona === who.persona) &&
      (g.until ?? Infinity) > now,
  );

/**
 * Whether a look at his screen must ask. His own turn (keyboard, phone, web) looks once he said Always allow, or within
 * an hour he allowed. A device's turn looks on his verified voice (or his "devices may look"), one look at a time;
 * any other voice is asked, whatever he allowed.
 */
export const lookAsks = (input: {
  readonly keys: ReadonlyArray<string>;
  readonly deviceTurn: boolean;
  readonly mayLook: boolean;
  readonly allowedUntil: number;
  readonly now: number;
}): boolean =>
  input.deviceTurn
    ? !input.mayLook
    : !stands(input.keys, LOOK_GRANT, { his: true }) && input.now >= input.allowedUntil;

/** A key in his words, for Settings and for her to read back: "Tessaya job schedule (asks before scheduling)". */
export const grantLabel = (key: string): string => {
  if (key === LOOK_GRANT) return "Seeing your screen";
  if (key.startsWith(cloneGrant(""))) return "A cloned voice (yours, or theirs with permission)";
  const [tool = key, why = "", app = ""] = key.split("|");
  if (tool === "house") return `Changing ${why} at home`;
  const what = tool.replace(/^tessaya_/, "").replace(/_/g, " ");
  const where = app === "" ? "" : app.startsWith("site:") ? ` on ${app.slice(5)}` : ` in ${app}`;
  return `${what[0]?.toUpperCase() ?? ""}${what.slice(1)}${where}${why === "" ? "" : ` (${why.replace(/\.$/, "")})`}`;
};

const WORD_SKIP = new Set([
  "the",
  "a",
  "an",
  "my",
  "me",
  "you",
  "to",
  "at",
  "in",
  "on",
  "of",
  "it",
  "stop",
  "letting",
  "let",
  "ask",
  "again",
  "before",
  "always",
  "allow",
  "anymore",
  "please",
  "don't",
  "do",
  "not",
  "your",
]);
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z']+/)
    .map((w) => w.replace(/(ing|s)$/, ""))
    .filter((w) => w.length > 1 && !WORD_SKIP.has(w));

/** The standing yes his words name ("stop letting you look at my screen"): the key whose label shares most words. */
export const grantNamed = (keys: ReadonlyArray<string>, words: string): string | null => {
  const said = new Set(wordsOf(words));
  if (said.has("look")) said.add("screen");
  let best: { key: string; score: number } | null = null;
  for (const key of keys) {
    const score = wordsOf(`${grantLabel(key)} ${key.replace(/[|_]/g, " ")}`).filter((w) =>
      said.has(w),
    ).length;
    if (score > 0 && (best === null || score > best.score)) best = { key, score };
  }
  return best?.key ?? null;
};
