/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Natural language to orchestration rules, by grammar.
 *
 * §13's rule, applied a phase early: **deterministic grammar and metadata
 * first.** No model decides what a sentence means here, in V1 or otherwise,
 * for a reason that is not purism — a rule that starts provider sessions and
 * spends a subscription must be something the user can read back and disagree
 * with. A parser that quietly guesses produces rules nobody audits.
 *
 * So the grammar is small and it **refuses loudly**. When a clause cannot be
 * placed, the result names the exact words it could not place, rather than
 * dropping them and building a rule that does less than the sentence said.
 * That refusal is the feature: it is what tells the user to rephrase instead
 * of discovering later that "and tell me if either needs me" was ignored.
 *
 * The sentence this must handle is the specification's own (§29 Phase 9):
 *
 *   "When Claude finishes this, have Codex review it and tell me if either
 *    needs me."
 *
 * @module batonRuleParser
 */
import {
  DEFAULT_MAX_FIRINGS,
  type OrchestrationAction,
  type OrchestrationTrigger,
} from "@t3tools/tessaya-contracts";

/** One rule the sentence asked for, before ids and timestamps are attached. */
export interface ParsedRule {
  readonly trigger: OrchestrationTrigger;
  readonly action: OrchestrationAction;
  /** True when this rule must run after the one before it in the list. */
  readonly afterPrevious: boolean;
  readonly maxFirings: number;
}

export type RuleParseResult =
  | { readonly ok: true; readonly rules: ReadonlyArray<ParsedRule>; readonly source: string }
  | {
      readonly ok: false;
      readonly source: string;
      /** The words the grammar could not place, verbatim. */
      readonly unplaced: string;
      readonly reason: string;
    };

/**
 * Who the sentence names. Resolved against the provider instances the caller
 * knows about, so "Codex" means this environment's Codex and not a guess.
 */
export interface ProviderVocabulary {
  /** Lower-cased word or phrase → provider instance id. */
  readonly byName: ReadonlyMap<string, string>;
  /** Model to open a session with, per instance id. */
  readonly modelFor: (instanceId: string) => string | null;
}

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** Strip a trailing full stop so clause matching does not have to care. */
const stripTerminator = (text: string): string => text.replace(/[.!?]+$/, "").trim();

const TRIGGER_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly trigger: OrchestrationTrigger;
}> = [
  {
    pattern:
      /^(?:when|once|as soon as) .*\b(finish(?:es|ed)?|completes?|(?:is|are|'s) (?:done|finished))\b/,
    trigger: { kind: "on_done" },
  },
  {
    pattern: /^(?:when|if|once|as soon as) .*\b(fails?|failed|errors?|breaks?)\b/,
    trigger: { kind: "on_failed" },
  },
  {
    pattern: /^(?:when|if|once|as soon as) .*\b(needs? (?:me|you)|asks?|gets? stuck|is blocked)\b/,
    trigger: { kind: "on_needs_user" },
  },
];

/**
 * Clauses that ask for a review by a named provider. "have Codex review it",
 * "get Codex to review this", "then Codex reviews it".
 */
const REVIEW_CLAUSE =
  /\b(?:have|get|ask|let)?\s*([a-z][a-z0-9 _-]{0,24}?)\s*(?:to\s+)?review(?:s|ed)?\b/;

/** "tell me", "notify me", "let me know" — optionally qualified. */
const NOTIFY_CLAUSE = /\b(?:tell|notify|let)\s+me\b(.*)$/;

/** "send it back to Claude", "return it to Claude", "have Claude fix it". */
const SEND_BACK_CLAUSE =
  /\b(?:send|give|hand|pass)\s+(?:it|them|those|the findings)?\s*back\b|\bhave\s+[a-z ]+\s+fix\b/;

/** "ask me first", "check with me", "confirm with me". */
const CONFIRM_CLAUSE = /\b(?:ask|check|confirm)\s+(?:with\s+)?me\s*(?:first)?\b/;

const splitClauses = (text: string): ReadonlyArray<string> =>
  text
    .split(/\s*(?:,|\band then\b|\bthen\b|\band\b|;)\s*/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);

const resolveProvider = (
  phrase: string,
  vocabulary: ProviderVocabulary,
): { readonly instanceId: string; readonly model: string } | null => {
  const cleaned = normalise(phrase)
    .replace(/^(?:have|get|ask|let)\s+/, "")
    .trim();
  for (const [name, instanceId] of vocabulary.byName) {
    if (cleaned === name || cleaned.endsWith(` ${name}`) || cleaned.startsWith(`${name} `)) {
      const model = vocabulary.modelFor(instanceId);
      return model === null ? null : { instanceId, model };
    }
  }
  return null;
};

/**
 * Parse one instruction into the rules it asks for.
 *
 * Returns several rules when the sentence chains: "have Codex review it **and**
 * tell me…" is a review rule plus a notify rule that runs after it, which is
 * what makes each step separately inspectable and separately disableable.
 */
export function parseOrchestrationSentence(
  sentence: string,
  vocabulary: ProviderVocabulary,
): RuleParseResult {
  const source = sentence.trim();
  const text = stripTerminator(normalise(source));
  if (text.length === 0) {
    return { ok: false, source, unplaced: "", reason: "There was nothing to parse." };
  }

  const matched = TRIGGER_PATTERNS.find((candidate) => candidate.pattern.test(text));
  if (matched === undefined) {
    return {
      ok: false,
      source,
      unplaced: source,
      reason:
        'No trigger found. Start with "When …" or "Once …", and say what happens: finishes, fails, or needs you.',
    };
  }

  // Everything after the first comma is the instruction; before it is the
  // trigger clause, which has already done its job.
  const commaIndex = text.indexOf(",");
  const body = commaIndex === -1 ? stripTriggerPrefix(text) : text.slice(commaIndex + 1).trim();
  if (body.length === 0) {
    return {
      ok: false,
      source,
      unplaced: source,
      reason: "The sentence says when, but not what to do.",
    };
  }

  const rules: ParsedRule[] = [];
  const unplaced: string[] = [];

  for (const clause of splitClauses(body)) {
    if (CONFIRM_CLAUSE.test(clause)) {
      rules.push({
        trigger: rules.length === 0 ? matched.trigger : { kind: "after_rule", ruleId: PLACEHOLDER },
        action: { kind: "confirmation_gate", question: source },
        afterPrevious: rules.length > 0,
        maxFirings: DEFAULT_MAX_FIRINGS,
      });
      continue;
    }

    const review = REVIEW_CLAUSE.exec(clause);
    if (review !== null) {
      const provider = resolveProvider(review[1] ?? "", vocabulary);
      if (provider === null) {
        unplaced.push(clause);
        continue;
      }
      rules.push({
        trigger: rules.length === 0 ? matched.trigger : { kind: "after_rule", ruleId: PLACEHOLDER },
        action: {
          kind: "start_provider_session",
          providerInstanceId: provider.instanceId as never,
          model: provider.model,
          role: "review",
          // A reviewer reads; it does not get to write without being asked.
          runtimeMode: "approval-required",
          prompt:
            "Review the change on this branch. Reply with BLOCKING followed by the issues if anything must be fixed before merge, or LGTM if not.",
          title: "Review",
        },
        afterPrevious: rules.length > 0,
        maxFirings: DEFAULT_MAX_FIRINGS,
      });
      continue;
    }

    if (SEND_BACK_CLAUSE.test(clause)) {
      rules.push({
        trigger: rules.length === 0 ? matched.trigger : { kind: "after_rule", ruleId: PLACEHOLDER },
        action: {
          kind: "message_active_implementation_session",
          prompt: "The review found blocking issues.",
          include: "review_findings",
        },
        afterPrevious: rules.length > 0,
        maxFirings: DEFAULT_MAX_FIRINGS,
      });
      continue;
    }

    const notify = NOTIFY_CLAUSE.exec(clause);
    if (notify !== null) {
      rules.push({
        trigger: rules.length === 0 ? matched.trigger : { kind: "after_rule", ruleId: PLACEHOLDER },
        action: { kind: "notify", message: tidyNotifyMessage(notify[1] ?? "", source) },
        afterPrevious: rules.length > 0,
        maxFirings: DEFAULT_MAX_FIRINGS,
      });
      continue;
    }

    // A clause that is only a pronoun or a connective carries no instruction;
    // dropping it is not the same as ignoring something the user asked for.
    if (isFiller(clause)) continue;

    unplaced.push(clause);
  }

  if (rules.length === 0) {
    return {
      ok: false,
      source,
      unplaced: unplaced.join(", ") || body,
      reason: "No action found. Say what should happen: review, send it back, or tell you.",
    };
  }
  if (unplaced.length > 0) {
    // Refuse rather than silently build a rule that does less than was asked.
    return {
      ok: false,
      source,
      unplaced: unplaced.join(", "),
      reason:
        "Part of that could not be turned into a rule, so none of it was created. Rephrase or split it in two.",
    };
  }

  return { ok: true, rules, source };
}

/**
 * Placeholder for "after the rule before this one". The caller replaces it
 * with the previous rule's real id once ids are minted, which is why parsing
 * stays pure and id generation stays where the clock is.
 */
export const PLACEHOLDER = "__previous__" as never;

const FILLER = new Set([
  "it",
  "this",
  "that",
  "them",
  "those",
  "please",
  "ok",
  "okay",
  "first",
  "next",
  "after",
  "afterwards",
]);

const isFiller = (clause: string): boolean => {
  const words = clause.split(" ").filter((word) => word.length > 0);
  return words.length > 0 && words.every((word) => FILLER.has(word));
};

const stripTriggerPrefix = (text: string): string =>
  text
    .replace(
      /^(?:when|if|once|as soon as)\b[^,]*?\b(?:finish(?:es|ed)?|completes?|fails?|failed|(?:is|are|'s) (?:done|finished))\b/,
      "",
    )
    .trim();

/**
 * "tell me if either needs me" → "if either needs me". Keeps the user's own
 * qualifier; falls back to the whole sentence when there was none, so the
 * notification always says something.
 */
const tidyNotifyMessage = (tail: string, source: string): string => {
  const trimmed = tail.replace(/^\s*know\b/, "").trim();
  return trimmed.length === 0 ? source : trimmed;
};
