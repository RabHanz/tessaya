/**
 * Computer and browser use per persona (PERSONA-TEAM-DESIGN §6): approve the plan, not every keystroke. His one yes on
 * a job's plan issues a lease for a concrete act set (sites, apps, act kinds), never "the browser"; acts inside it run,
 * acts outside it ask, risky acts always ask. Research runs in its own browser profile, apart from his logged-in one.
 * Pure: the operator asks it before each act.
 */
export const RISKY_ACTS = [
  "pay",
  "delete",
  "submit",
  "send",
  "lock",
  "alarm",
  "install",
  "deploy",
] as const;

export interface PlanLease {
  readonly job: string;
  readonly persona: string;
  /** Hosts the plan names ("github.com"); a subdomain counts. */
  readonly sites: ReadonlyArray<string>;
  readonly apps: ReadonlyArray<string>;
  /** Act kinds ("open", "click", "type", "read"). */
  readonly acts: ReadonlyArray<string>;
  /** Epoch ms when the job ends, or the lease is withdrawn. */
  readonly until: number;
}

export interface Act {
  readonly persona: string;
  readonly job: string | null;
  readonly kind: string;
  readonly site?: string;
  readonly app?: string;
}

export type LeaseDecision = "run" | "ask" | "ask-risky";

const hostIn = (host: string, sites: ReadonlyArray<string>) => {
  const h = host.toLowerCase().replace(/^www\./, "");
  return sites.some((s) => {
    const site = s.toLowerCase().replace(/^www\./, "");
    return h === site || h.endsWith(`.${site}`);
  });
};

/** A lease is concrete or it is refused: at least one site or app, and act kinds that name no risky act. */
export const leaseProblem = (lease: Omit<PlanLease, "until">): string | null =>
  lease.sites.length + lease.apps.length === 0
    ? "A plan must name the sites or apps it uses."
    : lease.sites.some((s) => s.trim() === "" || s.includes("*"))
      ? "A plan names whole sites, not patterns."
      : lease.acts.some((a) => (RISKY_ACTS as ReadonlyArray<string>).includes(a))
        ? "Risky acts are never leased; each asks."
        : null;

export const leaseDecision = (
  act: Act,
  leases: ReadonlyArray<PlanLease>,
  now: number,
): LeaseDecision => {
  if ((RISKY_ACTS as ReadonlyArray<string>).includes(act.kind)) return "ask-risky";
  const covered = leases.some(
    (l) =>
      l.job === act.job &&
      l.persona === act.persona &&
      l.until > now &&
      l.acts.includes(act.kind) &&
      (act.site === undefined ? true : hostIn(act.site, l.sites)) &&
      (act.app === undefined
        ? true
        : l.apps.some((a) => a.toLowerCase() === act.app!.toLowerCase())) &&
      (act.site !== undefined || act.app !== undefined),
  );
  return covered ? "run" : "ask";
};

/** Which browser profile an act uses: research never touches his logged-in accounts; acting as him uses his. */
export const browserProfileFor = (purpose: "research" | "as-him" | "admin"): "research" | "his" =>
  purpose === "research" ? "research" : "his";
