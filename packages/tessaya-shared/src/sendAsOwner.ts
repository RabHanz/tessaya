/**
 * Sebastian acting as him (PERSONA-TEAM-DESIGN §5, B-029): the send tiers. S0 drafts only, S1 sends each item after his
 * yes, S2 sends a narrow standing class without asking (one channel, named contacts, a daily cap, an undo delay).
 * Some things always ask him, item by item, at A3, whatever the tier; anything drafted from tainted content never sends.
 * Pure: the caller supplies the item, the tier and the grants, and acts on the decision.
 */
import type { Assurance } from "./household.ts";

export type SendTier = "S0" | "S1" | "S2";

/** What always asks him per item, never standing (Director 14 Nov). */
export const ALWAYS_ASK = ["money", "legal", "new-contact", "family", "sensitive"] as const;
export type AlwaysAsk = (typeof ALWAYS_ASK)[number];

export interface SendItem {
  readonly channel: string;
  /** Who it goes to, as the channel names them. */
  readonly to: string;
  /** Classes the drafting turn or the checker found in it. */
  readonly flags: ReadonlyArray<AlwaysAsk>;
  /** The draft was written in a turn that read an email, page or message: it can be drafted, never sent. */
  readonly tainted: boolean;
}

/** A narrow standing approval (S2), granted at A3 on his device and revocable in one sentence. */
export interface StandingGrant {
  readonly id: string;
  readonly channel: string;
  /** Who it may go to; empty means none (an S2 grant always names its contacts or calendar). */
  readonly to: ReadonlyArray<string>;
  readonly dailyCap: number;
  readonly undoSeconds: number;
  /** Epoch ms after which it lapses; null never. */
  readonly until: number | null;
}

export type SendDecision =
  | { readonly act: "draft"; readonly why: string }
  | { readonly act: "ask"; readonly assurance: Assurance; readonly why: string }
  | { readonly act: "send"; readonly grant: string; readonly undoSeconds: number };

export const DEFAULT_UNDO_SECONDS = 300;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const sendDecision = (input: {
  readonly item: SendItem;
  /** The tier he set for this channel; a channel he never set is S0. */
  readonly tier: SendTier | undefined;
  readonly grants: ReadonlyArray<StandingGrant>;
  /** Items each grant has sent today, by grant id. */
  readonly sentToday: Readonly<Record<string, number>>;
  readonly now: number;
}): SendDecision => {
  const { item } = input;
  if (item.tainted)
    return {
      act: "draft",
      why: "It was written from something it read, so it can only be a draft.",
    };
  const always = item.flags.find((f) => ALWAYS_ASK.includes(f));
  if (always !== undefined) return { act: "ask", assurance: 3, why: `It touches ${always}.` };
  const tier = input.tier ?? "S0";
  if (tier === "S0") return { act: "draft", why: `${item.channel} is draft-only.` };
  if (tier === "S2") {
    const grant = input.grants.find(
      (g) =>
        same(g.channel, item.channel) &&
        g.to.some((t) => same(t, item.to)) &&
        (g.until === null || g.until > input.now) &&
        (input.sentToday[g.id] ?? 0) < g.dailyCap,
    );
    if (grant !== undefined)
      return { act: "send", grant: grant.id, undoSeconds: grant.undoSeconds };
  }
  return { act: "ask", assurance: 2, why: `Each ${item.channel} message waits for his yes.` };
};

/** Granting S2 is itself a risky ask: only at A3 on his own device. */
export const mayGrantStanding = (assurance: Assurance, ownDevice: boolean): boolean =>
  assurance >= 3 && ownDevice;

/** How Sebastian names himself when he must disclose: his own setting, "alter ego" or "digital <owner name>". */
export type DisclosureLabel = "alter-ego" | "digital-owner";
export const disclosureOf = (label: DisclosureLabel | undefined, owner: string): string =>
  label === "digital-owner" ? `digital ${owner}` : `${owner}'s alter ego`;

/** The Record line that says who sent it and on what authority. */
export const provenanceLine = (
  decision:
    | Extract<SendDecision, { act: "send" }>
    | { readonly approvedAt: Assurance; readonly how: string },
): string =>
  "grant" in decision
    ? `Sent by Sebastian as you, under standing approval: ${decision.grant}.`
    : `Sent by Sebastian as you, approved by you (A${decision.approvedAt}, ${decision.how}).`;
