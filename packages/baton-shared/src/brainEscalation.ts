/**
 * Escalation to the deep role (BRAIN-DESIGN §2): she asks with `brain_escalate`, and this decides in code, from his
 * settings, whether the task goes to Opus now, is offered to him, or stays. Which of his rules a sentence matches is
 * the model's call (she passes its number); what a rule then allows is decided here. Pure, so every vessel reads the
 * same answer.
 */
import type { BrainEscalation, BrainEscalationRule } from "@t3tools/contracts";

export const ESCALATION_KINDS = ["plan", "code", "research", "judgement", "long"] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export interface EscalationAsk {
  readonly kind: EscalationKind;
  readonly why: string;
  /** The number (from 1) of his rule she says covers it. */
  readonly rule?: number;
  /** He said yes to the offer that is open. */
  readonly accept?: boolean;
  /** He goes on with the task Opus was just working on. */
  readonly continuing?: boolean;
}

export interface EscalationState {
  readonly offerOpen: boolean;
  /** Opus answered in this conversation within the carry window. */
  readonly deepRecently: boolean;
  /** Opus turns started without asking him today, in his time zone. */
  readonly autoToday: number;
}

export type EscalationDecision =
  | { readonly decision: "go"; readonly why: string; readonly counts: boolean }
  | { readonly decision: "ask" | "no"; readonly why: string };

export const DEFAULT_DEEP_DAILY_CAP = 20;
/** An offer, or a task Opus is on, lasts this long without his word (as `TIER_CARRY_MS`). */
export const ESCALATION_CARRY_MS = 2 * 60_000;

export const escalationDecision = (
  settings: BrainEscalation,
  ask: EscalationAsk,
  state: EscalationState,
): EscalationDecision => {
  // His own yes, now or a moment ago: never counted against what she may start on her own.
  if (ask.accept === true && state.offerOpen)
    return { decision: "go", why: "he said yes", counts: false };
  if (ask.continuing === true && state.deepRecently)
    return { decision: "go", why: "he goes on with the task Opus is on", counts: false };
  const mode = settings.mode ?? "ask";
  if (mode === "never") return { decision: "no", why: "his setting: never Opus" };
  const rule: BrainEscalationRule | undefined =
    ask.rule === undefined ? undefined : settings.rules?.[ask.rule - 1];
  const underCap = state.autoToday < (settings.autoDeepDailyCap ?? DEFAULT_DEEP_DAILY_CAP);
  const capped = "today's cap of Opus turns without asking is used up";
  if (rule !== undefined) {
    const said = `his rule "${rule.when}"`;
    if (rule.then === "sonnet") return { decision: "no", why: said };
    if (rule.then === "ask") return { decision: "ask", why: said };
    return underCap
      ? { decision: "go", why: said, counts: true }
      : { decision: "ask", why: `${said}, but ${capped}` };
  }
  if (mode === "auto")
    return underCap
      ? { decision: "go", why: "his setting: Opus on its own", counts: true }
      : { decision: "ask", why: capped };
  return { decision: "ask", why: "his setting: ask each time" };
};

/** His rules as the turn's note lists them, numbered for her to name one. */
export const escalationRulesLine = (settings: BrainEscalation): string | null => {
  const rules = settings.rules ?? [];
  return rules.length === 0
    ? null
    : `His rules for Opus (pass the number to brain_escalate when one covers this): ${rules
        .map(
          (r, i) =>
            `${i + 1}. ${r.when} → ${r.then === "sonnet" ? "stay on Sonnet" : r.then === "ask" ? "ask him first" : "Opus"}`,
        )
        .join("; ")}.`;
};

/** A request this long qualifies on its own (§2.1's hard signals). */
export const LONG_REQUEST_WORDS = 60;
