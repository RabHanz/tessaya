/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Presentation for orchestration rules in the sidebar.
 *
 * §22's requirement is that a rule be *inspectable*: the user should be able to
 * see what will happen, whether it has happened, and how many firings are left
 * before it stops. A rule the user cannot see is indistinguishable from an
 * agent doing things on its own, which is the thing this design exists to
 * avoid.
 */
import {
  describeRule,
  type OrchestrationFiring,
  type OrchestrationRuleWithFirings,
} from "@t3tools/tessaya-contracts";

export interface RuleRow {
  readonly ruleId: string;
  /** "When this finishes, start codex as review." */
  readonly description: string;
  /** "2 of 3 firings used", or "stopped" when the bound is spent. */
  readonly budget: string;
  readonly status: "enabled" | "disabled" | "exhausted";
  /** The last firing's outcome in one phrase, or null when it never fired. */
  readonly lastFiring: string | null;
  /** True while a confirmation gate is waiting on the user. */
  readonly awaitingConfirmation: boolean;
  /** The firing to answer, when one is waiting. */
  readonly awaitingFiringId: string | null;
}

export const buildRuleRows = (
  rules: ReadonlyArray<OrchestrationRuleWithFirings>,
): readonly RuleRow[] =>
  rules.map(({ rule, firings }) => {
    const latest = firings[0] ?? null;
    const waiting = firings.find((firing) => firing.outcome === "awaiting_confirmation") ?? null;
    return {
      ruleId: rule.id,
      description: describeRule(rule),
      budget:
        rule.status === "exhausted"
          ? "stopped after its limit"
          : `${rule.firedCount} of ${rule.maxFirings} firings used`,
      status: rule.status,
      lastFiring: latest === null ? null : describeFiring(latest),
      awaitingConfirmation: waiting !== null,
      awaitingFiringId: waiting?.id ?? null,
    };
  });

/**
 * One phrase per outcome. `skipped` says why it did nothing rather than
 * reading as a failure, because "there was no implementer to message" is a
 * correct result and a failed rule is not.
 */
export const describeFiring = (firing: OrchestrationFiring): string => {
  switch (firing.outcome) {
    case "started":
      return "running now";
    case "completed":
      return firing.detail.length > 0 ? firing.detail : "done";
    case "skipped":
      return firing.detail.length > 0 ? `skipped — ${firing.detail}` : "skipped";
    case "awaiting_confirmation":
      return `waiting for you — ${firing.detail}`;
    case "failed":
      return firing.detail.length > 0 ? `failed — ${firing.detail}` : "failed";
  }
};

/** Rules a work session owns, keyed for the Work block's lookup. */
export const rulesByWorkSession = (
  rules: ReadonlyArray<OrchestrationRuleWithFirings>,
): ReadonlyMap<string, readonly OrchestrationRuleWithFirings[]> => {
  const grouped = new Map<string, OrchestrationRuleWithFirings[]>();
  for (const entry of rules) {
    const existing = grouped.get(entry.rule.workSessionId);
    if (existing === undefined) grouped.set(entry.rule.workSessionId, [entry]);
    else existing.push(entry);
  }
  return grouped;
};
