/**
 * Who a credential acts for (tessaya-ops research/ACCOUNTS-IDENTITY-DESIGN.md, step I-0). A member is one person's row
 * in this household; its id is the same as their Voice ID `personId` and their private store's `person_id`. A
 * credential names its member in its subject when it is paired, so a session never changes whose it is, and every
 * subject paired before members existed (the desktop, his phone and browsers, tokens, agents, vessels) is the owner's.
 */
import {
  AuthAccessReadScope,
  AuthStandardClientScopes,
  AuthTessayaGuestScope,
  AuthTessayaMemberScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";

import type { TessayaPreferenceKey } from "@t3tools/tessaya-contracts";

import { OWNER_PERSON_ID, type SpeakerLike } from "./privateMemory.ts";

export const OWNER_MEMBER_ID = OWNER_PERSON_ID;

const MEMBER_PREFIX = "member:";
const VESSEL_PREFIX = "vessel:";
/** A Voice ID profile id or a member id: no spaces and no colon, so a subject can't name two things. */
const MEMBER_ID = /^[^\s:]{1,128}$/;

export const isMemberId = (id: string): boolean => MEMBER_ID.test(id);

/** The subject of a pairing or session that belongs to this member. */
export const memberSubject = (memberId: string): string => `${MEMBER_PREFIX}${memberId}`;

/** A vessel's own credential (a desk device, a speaker): it acts for whoever paired it, never for the voice it hears. */
export const vesselSubject = (vesselId: string): string => `${VESSEL_PREFIX}${vesselId}`;

/**
 * The member a credential with this subject acts for. A subject that names a member badly acts for nobody (null), never
 * for the owner.
 */
export const memberOfSubject = (subject: string): string | null => {
  if (!subject.startsWith(MEMBER_PREFIX)) return OWNER_MEMBER_ID;
  const id = subject.slice(MEMBER_PREFIX.length);
  return isMemberId(id) ? id : null;
};

/** Whether a subject names a member (one paired from an invite, or by a member's own device). */
export const isMemberSubject = (subject: string): boolean => subject.startsWith(MEMBER_PREFIX);

/** A member's role in this household (HOUSEHOLD-DESIGN §5, ACCOUNTS-IDENTITY-DESIGN §3.3). */
export type MemberRole = "owner" | "admin" | "adult" | "child" | "guest";
export const MEMBER_ROLES = ["owner", "admin", "adult", "child", "guest"] as const;
/** Who a request is from: a member's role, or a service (an agent, job or token) acting for a member. */
export type PrincipalRole = MemberRole | "service";

/**
 * The identity decisions (ACCOUNTS-IDENTITY-DESIGN §10), each the recommended option he approved on 27 Nov. Decision 1
 * (the owner opening adults' stores) differs per home, so it is the `tessayaOwnerOpensMemberStores` setting instead.
 */
export const HOUSEHOLD_DEFAULTS = {
  /** Decision 5: a child becomes an adult at this age, unless their own row sets another. */
  childAdultAge: 16,
  /** Decision 6: a removed member's data waits this long for their export, then is destroyed. */
  exportWindowDays: 7,
  /** Decision 3: the owner may make an adult an admin, who manages members but never the owner. */
  adminsAllowed: true,
  /** An invite (a member-bound pairing code) lasts this long. */
  inviteHours: 24,
} as const;

/**
 * How sure we are who is asking (ACCOUNTS-IDENTITY-DESIGN §3.1): 0 nobody known, 1 probably them (a listen-level voice,
 * a carried-over verdict), 2 them now (voice at the act cut-off, or their own signed-in device), 3 a fresh PIN or
 * passkey on their own device, 4 the root (recovery key, a shell on the home box).
 */
export type Assurance = 0 | 1 | 2 | 3 | 4;
export const assuranceLabel = (level: Assurance): string => `A${level}`;

/** Admin-class acts (members, roles, machine access) need this, or a yes from the owner's approving device. */
export const ADMIN_ASSURANCE: Assurance = 3;

/** The most a session of this role may hold; an invite is capped at it and a narrower role cuts sessions to match. */
export const roleCeiling = (
  role: MemberRole,
  machine: boolean,
): ReadonlyArray<AuthEnvironmentScope> => {
  const own: ReadonlyArray<AuthEnvironmentScope> =
    role === "owner"
      ? AuthStandardClientScopes
      : role === "admin"
        ? [AuthTessayaMemberScope, AuthAccessReadScope]
        : role === "guest"
          ? [AuthTessayaGuestScope]
          : [AuthTessayaMemberScope];
  // "Machine" is T3's threads, terminals and files: either can mint every scope, so it is the whole computer.
  return machine && role !== "guest" && role !== "child"
    ? [...new Set([...own, ...AuthStandardClientScopes])]
    : own;
};

/** Whether every scope a session holds is within a ceiling. */
export const withinCeiling = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  ceiling: ReadonlyArray<AuthEnvironmentScope>,
): boolean => scopes.every((scope) => ceiling.includes(scope));

const RANK: Readonly<Record<MemberRole, number>> = {
  owner: 4,
  admin: 3,
  adult: 2,
  child: 1,
  guest: 0,
};

/**
 * Why `actor` may not give `target` the role `to` (or add a member with it when `target` is null), or null when it
 * may. Only the owner and admins manage members; nobody manages the owner or makes another; only the owner makes an
 * admin; an admin manages adults, children and guests.
 */
export const manageRefusal = (
  actor: PrincipalRole,
  target: MemberRole | null,
  to: MemberRole | null,
): string | null => {
  if (actor !== "owner" && actor !== "admin") return "Only the owner or an admin manages members.";
  if (target === "owner") return "Nobody can change or remove the owner.";
  if (to === "owner")
    return "There is one owner; ownership moves only by the owner's own transfer.";
  if (to === "admin" && actor !== "owner") return "Only the owner makes someone an admin.";
  if (to === "admin" && !HOUSEHOLD_DEFAULTS.adminsAllowed) return "This home has no admins.";
  if (actor === "admin" && target !== null && RANK[target] >= RANK.admin)
    return "An admin manages adults, children and guests, not other admins.";
  return null;
};

/**
 * The member a spoken turn is from. A guest's voice is nobody (null), and so is one Voice ID has not judged yet or could
 * not judge: a late verdict never fails open to the owner (Director, 16 Nov). Only a vessel with no Voice ID to run
 * (`voiceIdOff`) hears every voice as the owner's at A0, so a home without it keeps working.
 */
export const memberOfSpeaker = (speaker: SpeakerLike | null): string | null =>
  speaker === null || speaker.kind === "owner"
    ? OWNER_MEMBER_ID
    : speaker.kind === "saved"
      ? speaker.personId
      : speaker.kind === "unverified" && speaker.voiceIdOff === true
        ? OWNER_MEMBER_ID
        : null;

/**
 * A voice on a member's own signed-in desktop, phone or browser (PVD identity: known by sign-in there, by voice on a
 * shared Tessel). Only Voice ID verifying someone else on this turn's own audio moves the turn off the device's member;
 * a guest's, unsure or unjudged verdict (a laptop mic that clips) is that member placed by sign-in, never verified.
 */
export const signedInSpeaker = <S extends SpeakerLike>(
  speaker: S,
  vessel: string,
  member: string | null | undefined,
): S => {
  if (vessel !== "desktop" && vessel !== "phone" && vessel !== "web") return speaker;
  if (speaker.verified && !speaker.inherited && speaker.test !== true) return speaker;
  const { session: _s, lifted: _l, voiceIdOff: _v, test: _t, ...rest } = speaker;
  const id = member ?? OWNER_MEMBER_ID;
  return {
    ...rest,
    kind: id === OWNER_MEMBER_ID ? "owner" : "saved",
    personId: id,
    verified: false,
    inherited: false,
    placed: `this is their own signed-in ${vessel}`,
  } as S;
};

/**
 * How sure a voice is (ACCOUNTS-IDENTITY-DESIGN §3.1): A2 only at the act cut-off on this turn's own audio, A1 for a
 * listen-level or carried-over match, A0 otherwise. A voice never reaches A3.
 */
export const voiceAssurance = (speaker: SpeakerLike | null): Assurance =>
  speaker === null || (speaker.kind !== "owner" && speaker.kind !== "saved")
    ? 0
    : speaker.verified && !speaker.inherited
      ? 2
      : 1;

/** What a member can set for themselves (HOUSEHOLD-DESIGN §4), with what each means to her. */
export const PREFERENCE_KEYS: Readonly<Record<TessayaPreferenceKey, string>> = {
  name: "what to call them",
  persona: "which persona answers them by default",
  voice: "the voice she speaks to them in",
  units: "metric or imperial",
  timeFormat: "how to say times (12-hour with AM/PM, or 24-hour)",
  news: "where their news comes from",
  music: "their music service or taste",
  wakeTraining:
    "whether their enrolled voice may train her wake words (on or off; on for the owner until he says off)",
  follow:
    'whether her own lines follow them to the vessel they are nearest ("follow me": on, the default) or stay where they asked (off)',
  pronouns: 'the pronouns she uses for them ("she/her", "he/him", "they/them"); unset is "they"',
  devices:
    "their own phones, laptops and headphones by name or network (MAC) address, comma-separated, so she knows when they are on the home Wi-Fi and whose headphones are on",
  location:
    "whether their phone may tell her when they arrive home or leave (on or off; off until they say on); never where they are",
  camera:
    "whether a camera may notice they are at a computer (on or off; off until they say on); she says when it is on and keeps no picture",
  listenWait:
    'in listen mode ("just listen"), how long a silence ends the thought, in seconds (5 to 120; 20 when unset)',
  listenEnds:
    'their own words that end listen mode, comma-separated (beside "over to you", "that\'s it", "your turn")',
  sleeve:
    'which of their phones is her Sleeve, showing only her full screen with its settings locked ("make this phone her sleeve"): phone names, comma-separated; cleared ("give me my phone back"), every phone shows everything',
};
/** An opt-in (location, camera): off until they say yes. */
export const optedIn = (value: string | undefined): boolean =>
  value !== undefined && /^\s*(?:on|yes|y|true|allow(?:ed)?|ok(?:ay)?|sure)\b/i.test(value);
/** "Follow me" is on until they say off. */
export const followOn = (value: string | undefined): boolean =>
  value === undefined || !/^\s*(?:off|no|n|false|stay|don'?t)\b/i.test(value);
export type PreferenceKey = TessayaPreferenceKey;
/** Whether a member's enrolled voice may train wake words: the owner's yes stands until he says no; others opt in. */
export const wakeTrainingOn = (member: string, value: string | undefined): boolean =>
  value === undefined
    ? member === OWNER_MEMBER_ID
    : /^\s*(?:on|yes|y|true|allow(?:ed)?|ok(?:ay)?|sure|go ahead|use it)\b/i.test(value);

export const isPreferenceKey = (key: string): key is PreferenceKey => key in PREFERENCE_KEYS;

/**
 * What she keeps about a member and who else can see it (identity I-4, the consent at join): told before they agree,
 * and again whenever they ask "who am I?". Guests: nothing is kept.
 */
export const keptAbout = (
  role: MemberRole,
  ownerOpensStores: boolean,
): { readonly kept: ReadonlyArray<string>; readonly seenBy: string } =>
  role === "guest"
    ? {
        kept: ["nothing you say: a guest is never remembered"],
        seenBy: "There is nothing of yours to see.",
      }
    : {
        kept: [
          "your voice print, so she knows it's you",
          "your preferences, like what to call you",
          "what you tell her, and each persona's memories of you",
          "your private memories, locked by your PIN",
          "your devices, and when you're home only if you turn that on",
        ],
        seenBy:
          role === "owner"
            ? "Your private memories are yours alone."
            : role === "child"
              ? "Your guardians can open your private memories; nobody else can."
              : ownerOpensStores
                ? "The owner can open your private memories; everyone else sees only that they exist."
                : "Nobody else can open your private memories, not even the owner.",
      };

/** The day (YYYY-MM-DD) a child born on `born` becomes an adult at `age`; null without a well-formed birth date. */
export const adultOn = (born: string | null, age: number): string | null => {
  const m = born === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(born);
  return m === null ? null : `${String(Number(m[1]) + age).padStart(4, "0")}-${m[2]}-${m[3]}`;
};

/** A child's limits a guardian set (identity I-5); each is lifted by setting it to null. */
export interface ChildLimits {
  /** "21:00-07:00": in these hours (the home's clock) she only talks with them. */
  readonly quiet: string | null;
  /** "guardians": they message only their guardians. */
  readonly messages: string | null;
}
export const NO_LIMITS: ChildLimits = { quiet: null, messages: null };

/** Minutes after midnight of "HH:MM-HH:MM"'s two ends, or null when it is not one. */
export const quietRange = (text: string): { readonly from: number; readonly to: number } | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return m === null
    ? null
    : { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]) };
};

/** Whether `minutes` after midnight falls in quiet hours; a range past midnight wraps. */
export const inQuiet = (quiet: string | null, minutes: number): boolean => {
  const r = quiet === null ? null : quietRange(quiet);
  if (r === null || r.from === r.to) return false;
  return r.from < r.to ? minutes >= r.from && minutes < r.to : minutes >= r.from || minutes < r.to;
};

/**
 * Her instruction for a turn with a child of this home (identity I-5, child mode): their name, spoken to as a child,
 * nothing unsuitable, and what is a guardian's to decide sent back to them.
 */
export const childModeLine = (name: string | null): string =>
  `You are talking with ${name ?? "a child"} of this home, a child: speak simply, warmly and briefly; keep everything suitable for a child, with no swearing, gore, horror or adult topics, softening a request for them into a gentle version; for buying anything, changing the house or anything risky, say it is for a parent or guardian to decide.`;
