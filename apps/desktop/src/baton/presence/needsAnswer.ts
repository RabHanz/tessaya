/** Puts every source of "what needs me?" together and says it. Read-only. */
import type { BatonJob, BatonSessionSummary, WatchFinding } from "@t3tools/tessaya-contracts";
import { buildApprovals } from "@t3tools/tessaya-shared/approvals";
import {
  describeNeeds,
  needsFromApprovals,
  needsFromFindings,
  needsFromJobs,
  rankNeeds,
  type NeedItem,
} from "@t3tools/tessaya-shared/needsMe";

import {
  readExternalNeeds,
  type ExternalNeeds,
  type NeedsConfig,
  type Run,
} from "./needsSources.ts";

export interface NeedsInput {
  readonly jobs: ReadonlyArray<BatonJob>;
  readonly sessions: ReadonlyArray<BatonSessionSummary>;
  readonly findings: ReadonlyArray<WatchFinding>;
  /** Extra items from the commitments ledger and other local sources. */
  readonly extra?: ReadonlyArray<NeedItem>;
  readonly config: NeedsConfig;
  readonly hidden?: ReadonlySet<string>;
  readonly now: number;
  readonly run?: Run;
  /** A cached, time-limited reader; the default reads fresh. */
  readonly external?: ExternalNeeds;
}

export const collectNeeds = async (
  input: NeedsInput,
): Promise<{ ranked: ReadonlyArray<NeedItem>; unreadable: ReadonlyArray<string> }> => {
  const external =
    (await input.external?.(input.config, input.now)) ??
    (await readExternalNeeds(input.config, input.now, input.run));
  const ranked = rankNeeds(
    [
      ...needsFromFindings(input.findings),
      ...needsFromJobs(input.jobs, input.now),
      ...needsFromApprovals(buildApprovals({ jobs: input.jobs, sessions: input.sessions })),
      ...(input.extra ?? []),
      ...external.items,
    ],
    input.now,
    input.hidden,
  );
  return { ranked, unreadable: external.unreadable };
};

export const answerNeeds = async (input: NeedsInput): Promise<string> => {
  const { ranked, unreadable } = await collectNeeds(input);
  return describeNeeds(ranked, unreadable);
};
