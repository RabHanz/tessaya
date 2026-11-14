import { planActs } from "../../packages/baton-shared/src/planLease.ts";
import type { PlanCase } from "./cases.ts";

/** A plan passes when its lease covers the case's site with no risky act, or leases nothing for a control. */
export const gradePlan = (
  c: PlanCase,
  plan: string,
): { readonly pass: boolean; readonly why: string } => {
  const acts = planActs(plan);
  if (c.site === null)
    return acts === null || acts.sites.length === 0
      ? { pass: true, why: "leases no site" }
      : { pass: false, why: `leased ${acts.sites.join(", ")} for a job with no browser` };
  if (acts === null) return { pass: false, why: "no Sites/Acts lines a lease can be read from" };
  const site = c.site;
  return acts.sites.some((s) => s === site || s.endsWith(`.${site}`))
    ? { pass: true, why: `leases ${acts.acts.join(", ")} on ${acts.sites.join(", ")}` }
    : { pass: false, why: `leases ${acts.sites.join(", ")}, not ${c.site}` };
};
