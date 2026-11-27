/**
 * "Link my profiles" from a device signed in to two homes (identity I-8, ACCOUNTS-IDENTITY §2.2): each home records
 * her own statement through its own connection, and she copies her voice or preferences between them on her say.
 * The homes never talk to each other, and memories never cross.
 */
import type {
  TessayaHouseholdCallInput,
  TessayaHouseholdCallResult,
  TessayaPreferenceKey,
} from "@t3tools/tessaya-contracts";

/** One home's household call; null when it can't be reached. */
export type HouseholdCall = (
  input: TessayaHouseholdCallInput,
) => Promise<TessayaHouseholdCallResult | null>;

export interface LinkHome {
  readonly label: string;
  readonly environmentId: string;
  readonly call: HouseholdCall;
}

export interface LinkOutcome {
  readonly ok: boolean;
  readonly line: string;
}

/** Hers to carry between homes; consents (location, camera, wake training) and a home's own devices stay per home. */
export const PORTABLE_PREFERENCES: ReadonlyArray<TessayaPreferenceKey> = [
  "name",
  "pronouns",
  "voice",
  "units",
  "timeFormat",
  "news",
  "music",
  "listenWait",
  "listenEnds",
];

const unreachable = (home: LinkHome): LinkOutcome => ({
  ok: false,
  line: `Couldn't reach ${home.label}. Try again.`,
});

const youIn = async (home: LinkHome) => {
  const r = await home.call({ op: "whoAmI" });
  if (r === null) return unreachable(home);
  const you = r.you;
  if (you?.id == null || you.role === "guest")
    return { ok: false, line: `You aren't a member of ${home.label} yet.` } as const;
  return { id: you.id, role: you.role, links: you.links ?? [] };
};

/** The link recorded in both homes, or in neither: a refusal on the second takes the first back. */
export async function linkProfiles(a: LinkHome, b: LinkHome): Promise<LinkOutcome> {
  if (a.environmentId === b.environmentId) return { ok: false, line: "Pick two different homes." };
  const inA = await youIn(a);
  if ("ok" in inA) return inA;
  const inB = await youIn(b);
  if ("ok" in inB) return inB;
  const first = await a.call({
    op: "linkProfile",
    home: b.label,
    member: inB.id,
    environmentId: b.environmentId,
  });
  if (first === null) return unreachable(a);
  if (first.status !== "done") return { ok: false, line: first.line };
  const second = await b.call({
    op: "linkProfile",
    home: a.label,
    member: inA.id,
    environmentId: a.environmentId,
  });
  if (second?.status === "done")
    return {
      ok: true,
      line: `Linked: you're the same person in ${a.label} and ${b.label}. Your memories stay in each home.`,
    };
  await a.call({ op: "unlinkProfile", home: b.label });
  return second === null ? unreachable(b) : { ok: false, line: second.line };
}

/** The way out, in both homes; a home out of reach keeps its half until she unlinks there too. */
export async function unlinkProfiles(a: LinkHome, b: LinkHome): Promise<LinkOutcome> {
  const lines: Array<string> = [];
  for (const [here, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const r = await here.call({ op: "unlinkProfile", home: other.label });
    if (r?.status !== "done") lines.push(r === null ? `Couldn't reach ${here.label}.` : r.line);
  }
  return lines.length === 0
    ? { ok: true, line: `Unlinked ${a.label} and ${b.label}.` }
    : { ok: false, line: lines.join(" ") };
}

/** Her voice profiles from one home saved as hers in the other: a fresh enrolment there. */
export async function copyVoice(from: LinkHome, to: LinkHome): Promise<LinkOutcome> {
  const there = await youIn(to);
  if ("ok" in there) return there;
  const mine = await from.call({ op: "myVoice" });
  if (mine === null) return unreachable(from);
  if (mine.status !== "done") return { ok: false, line: mine.line };
  const voices = mine.voices ?? [];
  if (voices.length === 0) return { ok: false, line: `${from.label} has no voice of yours yet.` };
  for (const { version: _v, updatedAt: _u, ...profile } of voices) {
    const saved = await to.call({
      op: "saveVoice",
      profile: { ...profile, id: there.id, kind: there.role === "owner" ? "owner" : "saved" },
      fresh: true,
    });
    if (saved === null) return unreachable(to);
    if (saved.status !== "done") return { ok: false, line: saved.line };
  }
  return { ok: true, line: `Copied your voice from ${from.label} to ${to.label}.` };
}

/** Her portable preferences that are set in one home, set the same in the other. */
export async function copyPreferences(from: LinkHome, to: LinkHome): Promise<LinkOutcome> {
  const here = await youIn(from);
  if ("ok" in here) return here;
  const there = await youIn(to);
  if ("ok" in there) return there;
  const read = await from.call({ op: "preferences", id: here.id });
  if (read === null) return unreachable(from);
  if (read.status !== "done") return { ok: false, line: read.line };
  const prefs = read.preferences ?? {};
  const keys = PORTABLE_PREFERENCES.filter((k) => prefs[k] !== undefined && prefs[k] !== "");
  if (keys.length === 0)
    return { ok: false, line: `You haven't set any preferences in ${from.label}.` };
  for (const key of keys) {
    const r = await to.call({ op: "setPreference", id: there.id, key, value: prefs[key] ?? null });
    if (r === null) return unreachable(to);
    if (r.status !== "done") return { ok: false, line: r.line };
  }
  return {
    ok: true,
    line: `Copied ${keys.length} ${keys.length === 1 ? "preference" : "preferences"} from ${from.label} to ${to.label}.`,
  };
}
