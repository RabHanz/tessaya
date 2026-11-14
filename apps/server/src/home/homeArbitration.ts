/**
 * Two people, one device (PERSONA-MODEL-AUDIT CS4): she may be in several conversations at once, so one person can ask
 * for the opposite of what another just set. Within the window the later ask does not silently win: the owner's goes
 * through and is told whose setting it replaced; a child's is refused; anyone else hears who set it and when, and
 * their asking again is their yes. A risky act still goes to the owner's phone through the house's own gate.
 */
import type { MemberRole } from "@t3tools/tessaya-shared/household";

export const ARBITRATION_MS = 90_000;

/** The last act on one entity: who asked, what they wanted, when. */
export interface RecentAct {
  readonly member: string | null;
  readonly name: string;
  readonly intent: string;
  readonly at: number;
}

export interface Asker {
  readonly member: string | null;
  readonly role: MemberRole;
  readonly intent: string;
  readonly at: number;
  /** They were already told who set it, and asked again within the window. */
  readonly askedAgain: boolean;
}

export type Arbitration =
  | { readonly go: true; readonly note: string | null }
  | { readonly go: false; readonly why: string };

const ago = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} seconds ago` : "a minute ago";
};

export const arbitrate = (
  device: string,
  recent: RecentAct | undefined,
  asker: Asker,
): Arbitration => {
  if (
    recent === undefined ||
    asker.at - recent.at > ARBITRATION_MS ||
    recent.intent === asker.intent ||
    (recent.member !== null && recent.member === asker.member)
  )
    return { go: true, note: null };
  const when = ago(asker.at - recent.at);
  if (asker.role === "owner")
    return {
      go: true,
      note: `${recent.name} had set ${device} ${when}; say in a few words that you changed it over theirs.`,
    };
  if (asker.role === "child")
    return {
      go: false,
      why: `${recent.name} set ${device} ${when}, and a child cannot change it over them. Say so kindly; they can ask ${recent.name}.`,
    };
  if (asker.askedAgain)
    return {
      go: true,
      note: `${recent.name} had set ${device} ${when}; they asked again, so it is changed.`,
    };
  return {
    go: false,
    why: `${recent.name} set ${device} ${when}. Tell them that and ask whether to change it anyway; if they say yes, make the same call again.`,
  };
};
