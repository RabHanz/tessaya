/** Which providers are offered, in what state, and with which accounts. Pure. */
import { pickable, type CloudProvider, type ProviderId, type Usage } from "./types.ts";

export interface ProviderChoice {
  readonly id: ProviderId;
  readonly label: string;
  readonly enabled: boolean;
  /** Why it cannot be chosen, in words for a person. */
  readonly why: string | null;
  readonly accounts: ReadonlyArray<{
    readonly account: string;
    readonly enabled: boolean;
    readonly why: string | null;
    readonly percent: number | null;
    readonly resets: string | null;
  }>;
}

/** The provider step and the account step of the card. Only providers that are set up are enabled. */
export const providerChoices = (
  providers: ReadonlyArray<CloudProvider>,
  usage: ReadonlyArray<Usage>,
  ready: ReadonlySet<ProviderId>,
): ReadonlyArray<ProviderChoice> =>
  providers.map((p) => {
    const setup = p.setup();
    const usable = setup.state === "ready" && ready.has(p.id);
    return {
      id: p.id,
      label: p.label,
      enabled: usable,
      why: usable
        ? null
        : setup.state === "not-set-up"
          ? setup.why
          : `${p.label} is not installed or not signed in on the computer that runs cloud tasks.`,
      accounts: p.accounts().map((account) => {
        const u = usage.find((x) => x.provider === p.id && x.account === account);
        const can = pickable(u);
        return {
          account,
          enabled: can.enabled,
          why: can.why,
          percent: u?.weeklyPercent ?? null,
          resets: u?.resetsAt ?? null,
        };
      }),
    };
  });
