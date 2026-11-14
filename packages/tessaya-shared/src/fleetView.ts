/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Presentation logic for the Fleet view.
 *
 * The §33 shape:
 *
 * ```text
 * ● Storefront / Scheduler     Working
 * ! Production / Deploy       Approval needed
 * ◐ Spotler / Reviewer        Reviewing
 * ✓ Margin / Search           Done
 * ```
 *
 * Glyph, then project and work, then the state — and, secondary, which account
 * and which host. Pure, so the wording and the ordering can be asserted without
 * rendering anything.
 *
 * It lives in `shared` rather than in a client because **both** clients render
 * this list, and the phone is where getting it wrong matters most: §29 Phase 7
 * wants the fleet on a screen the user glances at while walking away from the
 * desk. Two implementations of "what does this row say" would drift, and the
 * drift would be silent — the web would say a session needs you and the phone
 * would not.
 *
 * @module batonFleetView
 */
import {
  BATON_STATE_GLYPHS,
  BATON_STATE_LABELS,
  isSynopsisStale,
  type EnvironmentId,
  type BatonFleetEntry,
  type BatonSessionState,
  type ProjectId,
  type WorkSessionId,
} from "@t3tools/tessaya-contracts";

export interface FleetRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly workSessionId: WorkSessionId;
  readonly glyph: string;
  /** "Storefront / Scheduler reconnect race" */
  readonly heading: string;
  readonly stateLabel: string;
  readonly state: BatonSessionState;
  readonly needsUser: boolean;
  /** "Claude B · home-linux", or null when nothing is attached. */
  readonly attribution: string | null;
  /**
   * Which account is running this work, by name and by address.
   *
   * The name is what its owner called it and the address is which login it
   * actually is — two accounts that have quietly ended up on one set of
   * credentials look identical until you can see both. Null when no thread is
   * attached, and the address is null when the provider has not reported one.
   */
  readonly account: FleetAccount | null;
  /** The synopsis line, or null when there is nothing recorded yet. */
  readonly detail: string | null;
  /** True when the detail is older than the staleness window. */
  readonly detailStale: boolean;
}

export interface FleetAccount {
  readonly label: string;
  readonly email: string | null;
}

export interface FleetRowInput {
  readonly entries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly entry: BatonFleetEntry;
  }>;
  readonly resolveProjectLabel: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => string | null;
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly resolveProviderAccount: (
    environmentId: EnvironmentId,
    providerInstanceId: string,
  ) => FleetAccount | null;
  readonly now: number;
}

export function buildFleetRows(input: FleetRowInput): readonly FleetRow[] {
  return input.entries.map(({ environmentId, entry }) => {
    const projectLabel = input.resolveProjectLabel(environmentId, entry.projectId);
    // The active thread is the one the user is working through; with none, the
    // first live thread still answers "under which account".
    const attributed =
      entry.threads.find((thread) => thread.threadId === entry.activeThreadId) ??
      entry.threads[0] ??
      null;
    const account =
      attributed?.providerInstanceId == null
        ? null
        : input.resolveProviderAccount(environmentId, attributed.providerInstanceId);
    const hostLabel = input.resolveEnvironmentLabel(environmentId);
    const synopsis = entry.synopsis;

    return {
      key: `${environmentId}:${entry.workSessionId}`,
      environmentId,
      workSessionId: entry.workSessionId,
      glyph: BATON_STATE_GLYPHS[entry.state],
      heading: projectLabel === null ? entry.title : `${projectLabel} / ${entry.title}`,
      stateLabel: BATON_STATE_LABELS[entry.state],
      state: entry.state,
      needsUser: entry.needsUser,
      attribution: joinDot([account?.label ?? null, hostLabel]),
      account,
      detail: synopsis?.currentAction ?? null,
      detailStale: synopsis !== null && isSynopsisStale(synopsis, input.now),
    };
  });
}

const joinDot = (parts: ReadonlyArray<string | null>): string | null => {
  const kept = parts.filter((part): part is string => part !== null && part.trim().length > 0);
  return kept.length === 0 ? null : kept.join(" · ");
};

/**
 * The §33 "Needs me" filter, as a top-level control rather than a search: one
 * action shows every session that needs approval or input.
 */
export const filterFleetRows = (
  rows: readonly FleetRow[],
  needsUserOnly: boolean,
): readonly FleetRow[] => (needsUserOnly ? rows.filter((row) => row.needsUser) : rows);

/** Counts for the filter chip, so it can say what it would hide. */
export const countFleetRows = (
  rows: readonly FleetRow[],
): { readonly total: number; readonly needsUser: number } => ({
  total: rows.length,
  needsUser: rows.filter((row) => row.needsUser).length,
});
