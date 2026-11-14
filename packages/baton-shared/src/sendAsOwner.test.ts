import { describe, expect, it } from "vite-plus/test";

import {
  disclosureOf,
  mayGrantStanding,
  provenanceLine,
  sendDecision,
  type SendItem,
  type StandingGrant,
} from "./sendAsOwner.ts";

const item = (over: Partial<SendItem> = {}): SendItem => ({
  channel: "linkedin",
  to: "Sam",
  flags: [],
  tainted: false,
  ...over,
});
const posts: StandingGrant = {
  id: "posts",
  channel: "linkedin",
  to: ["Sam"],
  dailyCap: 2,
  undoSeconds: 300,
  until: null,
};
const decide = (over: Partial<Parameters<typeof sendDecision>[0]> = {}) =>
  sendDecision({ item: item(), tier: "S2", grants: [posts], sentToday: {}, now: 0, ...over });

describe("Sebastian sending as him", () => {
  it("sends under a standing grant only inside its channel, contacts, cap and time", () => {
    expect(decide()).toEqual({ act: "send", grant: "posts", undoSeconds: 300 });
    expect(decide({ sentToday: { posts: 2 } }).act).toBe("ask");
    expect(decide({ item: item({ to: "Someone else" }) }).act).toBe("ask");
    expect(decide({ item: item({ channel: "email" }) }).act).toBe("ask");
    expect(decide({ grants: [{ ...posts, until: 10 }], now: 11 }).act).toBe("ask");
  });
  it("drafts on S0 or an unset channel and asks at A2 on S1", () => {
    expect(decide({ tier: "S0" }).act).toBe("draft");
    expect(decide({ tier: undefined }).act).toBe("draft");
    expect(decide({ tier: "S1" })).toMatchObject({ act: "ask", assurance: 2 });
  });
  it("never sends a draft from tainted content, at any tier", () => {
    for (const tier of ["S0", "S1", "S2"] as const)
      expect(decide({ tier, item: item({ tainted: true }) }).act).toBe("draft");
  });
  it("asks at A3 item by item for money, legal, new contacts, family and sensitive topics, even under a grant", () => {
    for (const flag of ["money", "legal", "new-contact", "family", "sensitive"] as const)
      expect(decide({ item: item({ flags: [flag] }) })).toMatchObject({ act: "ask", assurance: 3 });
  });
  it("grants standing approval only at A3 on his own device", () => {
    expect(mayGrantStanding(3, true)).toBe(true);
    expect(mayGrantStanding(2, true)).toBe(false);
    expect(mayGrantStanding(4, false)).toBe(false);
  });
  it("names itself by his chosen label and says on whose authority it sent", () => {
    expect(disclosureOf("digital-owner", "Rabee")).toBe("digital Rabee");
    expect(disclosureOf(undefined, "Rabee")).toBe("Rabee's alter ego");
    expect(provenanceLine({ act: "send", grant: "posts", undoSeconds: 300 })).toContain("posts");
    expect(provenanceLine({ approvedAt: 3, how: "passkey, your phone" })).toBe(
      "Sent by Sebastian as you, approved by you (A3, passkey, your phone).",
    );
  });
});
