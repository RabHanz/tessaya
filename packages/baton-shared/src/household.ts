/**
 * Who a credential acts for (tessaya-ops research/ACCOUNTS-IDENTITY-DESIGN.md, step I-0). A member is one person's row
 * in this household; its id is the same as their Voice ID `personId` and their private store's `person_id`. A
 * credential names its member in its subject when it is paired, so a session never changes whose it is, and every
 * subject paired before members existed (the desktop, his phone and browsers, tokens, agents, vessels) is the owner's.
 */
import { OWNER_PERSON_ID } from "./privateMemory.ts";

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
