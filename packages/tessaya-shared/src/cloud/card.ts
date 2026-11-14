/**
 * The approval card's rules, the same on every surface (Approvals, Now, the phone page, a spoken yes):
 * pick a provider, then an account, then confirm. Nothing is preselected, only an enabled choice can be
 * picked, and nothing is approved until the confirm step. Pure.
 */
import type { ProviderChoice } from "./registry.ts";
import type { ProviderId } from "./types.ts";

export type CardState =
  | { readonly phase: "provider" }
  | { readonly phase: "account"; readonly provider: ProviderId }
  | { readonly phase: "confirm"; readonly provider: ProviderId; readonly account: string }
  | { readonly phase: "approving"; readonly provider: ProviderId; readonly account: string }
  | { readonly phase: "done"; readonly provider: ProviderId; readonly account: string }
  | { readonly phase: "denied" }
  | { readonly phase: "error"; readonly message: string; readonly back: CardState };

export const CARD_START: CardState = { phase: "provider" };

export type CardEvent =
  | { readonly type: "provider"; readonly provider: ProviderId }
  | { readonly type: "account"; readonly account: string }
  | { readonly type: "back" }
  | { readonly type: "confirm" }
  | { readonly type: "approved" }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "deny" }
  | { readonly type: "retry" };

/** `choices` are what the card is showing now; a disabled choice cannot be picked whatever is sent. */
export const reduceCard = (
  s: CardState,
  e: CardEvent,
  choices: ReadonlyArray<ProviderChoice>,
): CardState => {
  switch (e.type) {
    case "provider":
      return s.phase === "provider" && choices.find((c) => c.id === e.provider)?.enabled === true
        ? { phase: "account", provider: e.provider }
        : s;
    case "account": {
      if (s.phase !== "account") return s;
      const pick = choices
        .find((c) => c.id === s.provider)
        ?.accounts.find((a) => a.account === e.account);
      return pick?.enabled === true
        ? { phase: "confirm", provider: s.provider, account: e.account }
        : s;
    }
    case "back":
      return s.phase === "account"
        ? CARD_START
        : s.phase === "confirm"
          ? { phase: "account", provider: s.provider }
          : s.phase === "error"
            ? s.back
            : s;
    case "confirm":
      return s.phase === "confirm"
        ? { phase: "approving", provider: s.provider, account: s.account }
        : s;
    case "approved":
      return s.phase === "approving"
        ? { phase: "done", provider: s.provider, account: s.account }
        : s;
    case "failed":
      return s.phase === "approving"
        ? { phase: "error", message: e.message, back: { phase: "account", provider: s.provider } }
        : s;
    case "retry":
      return s.phase === "error" ? s.back : s;
    case "deny":
      return s.phase === "done" || s.phase === "approving" || s.phase === "denied"
        ? s
        : { phase: "denied" };
  }
};

/**
 * A spoken 'approve cloud request 3 on <account>' only gets as far as the confirm step: the account must be
 * named, it must be one that can be picked, and the card is read back before anything is approved.
 */
export const fromSpoken = (
  choices: ReadonlyArray<ProviderChoice>,
  said: { readonly provider?: ProviderId; readonly account: string },
): { readonly state: CardState; readonly readBack: string } | { readonly refused: string } => {
  const matches = choices.filter(
    (c) =>
      c.enabled &&
      (said.provider === undefined || c.id === said.provider) &&
      c.accounts.some((a) => a.account.toLowerCase() === said.account.toLowerCase()),
  );
  if (matches.length === 0)
    return {
      refused: `I cannot approve on ${said.account}: it is not offered, or its provider is not set up.`,
    };
  if (matches.length > 1)
    return { refused: `${said.account} is offered by more than one provider. Say which.` };
  const c = matches[0]!;
  const a = c.accounts.find((x) => x.account.toLowerCase() === said.account.toLowerCase())!;
  if (!a.enabled)
    return { refused: `${a.account} cannot be used now: ${a.why ?? "not available"}.` };
  return {
    state: { phase: "confirm", provider: c.id, account: a.account },
    readBack: `Approve this cloud task on ${c.label}, account ${a.account}${a.percent === null ? "" : `, ${a.percent}% used this week`}? Only your yes on the card runs it.`,
  };
};

export const OFFER_MAX = 6;

export type OfferPick =
  | { readonly kind: "pick"; readonly provider: ProviderId; readonly account: string }
  | { readonly kind: "deny" }
  | { readonly kind: "later" };

/**
 * The card as one question with a button for each assistant-and-account that may be picked (so it fits a
 * dialog and a phone): nothing is preselected, a closed choice is not a button, and the last button is
 * "decide later". Choosing one only leads to a second question, "approve on X?"; it approves nothing.
 */
export const offerQuestion = (
  choices: ReadonlyArray<ProviderChoice>,
  words: {
    readonly pick: (label: string, account: string, usage: string) => string;
    readonly deny: string;
    readonly later: string;
  },
): {
  readonly buttons: ReadonlyArray<string>;
  readonly cancel: number;
  readonly picks: ReadonlyArray<OfferPick>;
} => {
  const options = choices
    .filter((c) => c.enabled)
    .flatMap((c) =>
      c.accounts
        .filter((a) => a.enabled)
        .map((a) => ({
          button: words.pick(
            c.label,
            a.account,
            a.percent === null ? "usage unknown" : `${a.percent}% used`,
          ),
          pick: { kind: "pick", provider: c.id, account: a.account } as OfferPick,
        })),
    );
  // A phone shows eight answers; the rest are still on the card in Approvals.
  const shown = options.slice(0, OFFER_MAX);
  const picks: OfferPick[] = [...shown.map((o) => o.pick), { kind: "deny" }, { kind: "later" }];
  return {
    buttons: [...shown.map((o) => o.button), words.deny, words.later],
    cancel: picks.length - 1,
    picks,
  };
};
