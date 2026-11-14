/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Presentation for the intent input.
 *
 * The input has one job beyond taking text: **say what will happen before it
 * happens.** A surface fed by dictation mishears, and the difference between a
 * useful assistant and a dangerous one is whether the user sees "Tell Claude on
 * Scheduler: run the migration tests" and can stop it, or only finds out
 * afterwards.
 *
 * So the preview is not decoration. It is the confirmation step, and the
 * wording below is what the user reads at the moment they decide.
 */
import type {
  TessayaIntentRecord,
  TessayaIntentResolution,
  TessayaIntentRisk,
} from "@t3tools/tessaya-contracts";
import { BAR_ASK_TTL_MS } from "@t3tools/tessaya-shared/phoneRelay";

export interface IntentPreview {
  /** `will` — pressing enter does this. `refused` — it will not happen. */
  readonly tone: "will" | "refused";
  /** The line under the input. */
  readonly line: string;
  /** The words it could not place, when that is why it refused. */
  readonly unplaced: string | null;
  /**
   * True when the action spends a subscription, starts a session, or releases
   * queued automation. The input marks these; it does not block them.
   */
  readonly weighty: boolean;
}

const WEIGHTY: ReadonlySet<TessayaIntentRisk> = new Set(["medium", "high"]);

/** Words the grammar cannot place are the lead's to read; a high-risk, ambiguous or rule refusal stays a refusal. */
const FOR_THE_LEAD: ReadonlySet<string> = new Set(["unrecognised", "unknown_target"]);

export const goesToLead = (resolution: TessayaIntentResolution): boolean =>
  resolution.outcome === "refused" && FOR_THE_LEAD.has(resolution.refusal.reason);

/**
 * Whether the bar stops re-reading an ask it left for the lead: it has an outcome, the server no longer knows it,
 * or it is older than the server would keep it undelivered (a lost connection must not poll for ever).
 */
export const leadAskSettled = (
  got: { readonly status?: string } | null | undefined,
  askedAt: number,
  now: number,
): boolean =>
  got === null ||
  (got !== undefined && got.status !== "queued" && got.status !== "taken") ||
  now - askedAt > BAR_ASK_TTL_MS;

export const previewResolution = (resolution: TessayaIntentResolution): IntentPreview =>
  goesToLead(resolution)
    ? { tone: "will", line: "Ask Tessaya", unplaced: null, weighty: false }
    : resolution.outcome === "resolved"
      ? {
          tone: "will",
          line: resolution.description,
          unplaced: null,
          weighty: WEIGHTY.has(resolution.risk),
        }
      : {
          tone: "refused",
          line: resolution.refusal.message,
          // Shown separately so the user can see which words to change, rather
          // than re-reading their own sentence looking for the problem.
          unplaced:
            resolution.refusal.unplaced.trim().length === 0
              ? null
              : resolution.refusal.unplaced.trim(),
          weighty: false,
        };

export interface IntentRow {
  readonly id: string;
  /** What was said. */
  readonly text: string;
  /** What came of it, in one line. */
  readonly outcome: string;
  readonly refused: boolean;
  readonly failed: boolean;
}

/**
 * The recent-intent list.
 *
 * Refusals stay in it on purpose: a log that keeps only what worked cannot show
 * the grammar its own blind spots, and "it did nothing and I do not know why"
 * is the complaint this list exists to answer.
 */
export const buildIntentRows = (
  records: ReadonlyArray<TessayaIntentRecord>,
): readonly IntentRow[] =>
  records.map((record) => ({
    id: record.id,
    text: record.text,
    outcome: record.reply.trim().length > 0 ? record.reply : describeOutcome(record),
    refused: record.outcome === "refused",
    failed: record.outcome === "failed",
  }));

const describeOutcome = (record: TessayaIntentRecord): string => {
  switch (record.outcome) {
    case "resolved":
      return record.description.length > 0 ? record.description : "Done.";
    case "refused":
      return "Refused.";
    case "failed":
      return "Could not be done.";
  }
};
