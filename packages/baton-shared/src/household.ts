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

import type { BatonPreferenceKey } from "@t3tools/baton-contracts";

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
 * The defaults for the identity decisions still open with the Director (ACCOUNTS-IDENTITY-DESIGN §10), each the
 * design's recommended option. They are changed here; nothing else hard-codes them.
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
  /**
   * Decision 1: a member's store, made when they accept, is also wrapped to the owner's key, so the owner can open it
   * (his rule of 11 Nov, and every store's today). The design's proposal for other homes is false: sealed from the owner.
   */
  ownerOpensMemberStores: true,
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
 * The member a spoken turn is from. A guest's voice is nobody (null). A voice Voice ID could not judge is heard as before,
 * on the owner's path, at A0 (identity only narrows; `speakerPath`), so a home without Voice ID keeps working.
 */
export const memberOfSpeaker = (speaker: SpeakerLike | null): string | null =>
  speaker?.kind === "guest" ? null : speaker?.kind === "saved" ? speaker.personId : OWNER_MEMBER_ID;

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
export const PREFERENCE_KEYS: Readonly<Record<BatonPreferenceKey, string>> = {
  name: "what to call them",
  persona: "which persona answers them by default",
  voice: "the voice she speaks to them in",
  units: "metric or imperial",
  timeFormat: "how to say times (12-hour with AM/PM, or 24-hour)",
  news: "where their news comes from",
  music: "their music service or taste",
  wakeTraining:
    "whether their enrolled voice may train her wake words (on or off; on for the owner until he says off)",
};
export type PreferenceKey = BatonPreferenceKey;
/** Whether a member's enrolled voice may train wake words: the owner's yes stands until he says no; others opt in. */
export const wakeTrainingOn = (member: string, value: string | undefined): boolean =>
  value === undefined
    ? member === OWNER_MEMBER_ID
    : /^\s*(?:on|yes|y|true|allow(?:ed)?|ok(?:ay)?|sure|go ahead|use it)\b/i.test(value);

export const isPreferenceKey = (key: string): key is PreferenceKey => key in PREFERENCE_KEYS;
