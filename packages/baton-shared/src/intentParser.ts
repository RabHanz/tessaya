/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * One sentence to one Baton command, by grammar.
 *
 * §13's instruction, taken literally: **do not feed every transcript blindly
 * into an LLM; use deterministic grammar and metadata first.** In V1 there is
 * no "then". Nothing here calls a model, and nothing here may: the whole point
 * of a voice surface is that the user can trust what a half-heard sentence will
 * do, and a probabilistic parser makes that impossible to promise.
 *
 * The four rules this file follows:
 *
 *   1. **Resolve to ids, never to words.** The command that comes out names a
 *      work session id, a provider instance id, a firing id. Execution never
 *      re-reads the sentence, so there is exactly one interpretation and it is
 *      the one the user was shown.
 *   2. **Refuse with the words.** Every refusal carries the phrase it could not
 *      place. "I did not understand" teaches nothing; "I could not place
 *      'the office one'" tells the user what to say instead.
 *   3. **Never guess a target.** A named target that matches nothing is a
 *      refusal, not a fallback to whatever is on screen. Falling back is how a
 *      message meant for one account lands in another.
 *   4. **A sentence never authorises a high-risk action** (§24.1, §24.2).
 *      Production deploys, protected merges, destructive database work,
 *      secrets and purchases are recognised *by name* and refused as such,
 *      rather than being left to fail as gibberish.
 *
 * @module batonIntentParser
 */
import type {
  BatonIntentCommand,
  BatonIntentResolution,
  BatonIntentRefusalReason,
  BatonIntentRisk,
} from "@t3tools/baton-contracts";

import { parseOrchestrationSentence, type ProviderVocabulary } from "./ruleParser.ts";

export interface IntentWorkSession {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectLabel: string | null;
  /** Used only for a better refusal when someone says "yes" with nothing parked. */
  readonly needsApproval: boolean;
  /** ISO. Breaks ties for "this" and "it" when nothing is focused. */
  readonly updatedAt: string;
}

export interface IntentProject {
  readonly id: string;
  readonly title: string;
}

export interface IntentProvider {
  readonly instanceId: string;
  /** The driver kind, so a caller can ask what this account can actually do. */
  readonly driver: string;
  /** How the user refers to it: "Claude", "Claude B", "Codex", the driver kind. */
  readonly aliases: ReadonlyArray<string>;
  /** Display name for the read-back. */
  readonly label: string;
  /** Null when the environment has no model configured for it. */
  readonly model: string | null;
  /** Installed, enabled and not reporting itself unavailable. */
  readonly available: boolean;
  /**
   * The account has proven a login: authenticated *and* naming the address it
   * is authenticated as.
   *
   * Distinct from `available`, and the distinction cost a live deploy to find.
   * A configured instance whose stored credentials have expired still reports
   * itself enabled, installed and "authenticated" — what it cannot do is
   * answer. Anything that spends a call on an account should prefer one of
   * these; anything the user *named* should still be attempted, because "it is
   * not logged in" is a better answer than silently using another account.
   */
  readonly signedIn: boolean;
}

export interface IntentGate {
  readonly firingId: string;
  readonly workSessionId: string;
  readonly question: string;
}

export interface IntentVocabulary {
  readonly workSessions: ReadonlyArray<IntentWorkSession>;
  readonly projects: ReadonlyArray<IntentProject>;
  readonly providers: ReadonlyArray<IntentProvider>;
  /** Confirmation gates waiting for an answer right now. */
  readonly openGates: ReadonlyArray<IntentGate>;
  /** What this environment answers to, so "on the box" can be checked. */
  readonly hostAliases: ReadonlyArray<string>;
  /** §14 rung 3. Null when the client did not say. */
  readonly focusedWorkSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const stripTerminator = (text: string): string => text.replace(/[.!?]+$/, "").trim();

/**
 * Wake phrases and politeness. Stripped rather than matched, because they carry
 * no instruction and every grammar below would otherwise need to allow for
 * them. §24.2's rule that a wake word alone authorises nothing is exactly this:
 * the word is discarded before anything is decided.
 */
const PREFIXES: ReadonlyArray<RegExp> = [
  /^(?:hey |ok |okay )?(?:jarvis|baton)[,:]?\s+/,
  /^(?:please|pls)\s+/,
  /^(?:can|could|would)\s+you\s+(?:please\s+)?/,
  /^(?:i\s+want\s+to\s+know|i'd\s+like\s+to\s+know|let\s+me\s+know)\s+/,
  /^tell\s+me\s+(?=what|whether|if\s+anything|how)/,
  /^(?:give\s+me\s+)(?=a\s+status|the\s+status)/,
  /^(?:so|and|also|then)\s+/,
];

const stripPrefixes = (text: string): string => {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of PREFIXES) {
      const next = out.replace(prefix, "");
      if (next !== out) {
        out = next.trim();
        changed = true;
      }
    }
  }
  return out;
};

const ARTICLES = /^(?:the|a|an|my|our|that|this)\s+/;
const stripArticle = (text: string): string => text.replace(ARTICLES, "").trim();

const PRONOUNS = new Set([
  "it",
  "this",
  "that",
  "them",
  "these",
  "those",
  "here",
  // "this one" and "that one" arrive here with the article already stripped.
  "one",
  "current",
  "current one",
]);

const wordBoundedContains = (haystack: string, needle: string): boolean => {
  if (needle.length === 0) return false;
  const index = haystack.indexOf(needle);
  if (index === -1) return false;
  const before = index === 0 ? " " : haystack[index - 1]!;
  const afterIndex = index + needle.length;
  const after = afterIndex >= haystack.length ? " " : haystack[afterIndex]!;
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
};

// ---------------------------------------------------------------------------
// §24.1 HIGH — recognised so it can be refused by name
// ---------------------------------------------------------------------------

const HIGH_RISK: ReadonlyArray<{ readonly pattern: RegExp; readonly subject: string }> = [
  {
    pattern: /\b(?:deploy|ship|release|push)\b[^.]*\bto\s+(?:prod|production|live)\b/,
    subject: "a production deploy",
  },
  {
    pattern: /\b(?:prod|production)\b[^.]*\b(?:deploy|deployment|release)\b/,
    subject: "a production deploy",
  },
  {
    pattern: /\brestart\b[^.]*\b(?:prod|production)\b/,
    subject: "restarting a production service",
  },
  {
    pattern: /\b(?:prod|production)\b[^.]*\brestart\b/,
    subject: "restarting a production service",
  },
  {
    pattern: /\bmerge\b[^.]*\b(?:main|master|production|protected|release)\b/,
    subject: "merging a protected branch",
  },
  {
    pattern: /\b(?:drop|truncate|wipe|delete)\b[^.]*\b(?:database|db|table|schema)\b/,
    subject: "a destructive database operation",
  },
  {
    pattern:
      /\b(?:rotate|reset|change)\b[^.]*\b(?:secret|secrets|credential|credentials|api key|token)\b/,
    subject: "changing credentials",
  },
  {
    pattern:
      /\b(?:show|print|read|reveal|give)\b[^.]*\b(?:secret|secrets|credential|credentials|api key|env file|\.env)\b/,
    subject: "reading secrets",
  },
  {
    pattern: /\b(?:grant|revoke)\b[^.]*\b(?:access|permission|permissions|admin)\b/,
    subject: "a permission change",
  },
  {
    pattern:
      /\b(?:buy|purchase|pay|charge|refund|transfer)\b[^.]*\b(?:card|invoice|money|usd|dollars|subscription|plan)\b/,
    subject: "a financial action",
  },
];

/**
 * Understood, and belongs to a phase that does not exist yet. Named rather than
 * refused as gibberish, because "I cannot do that yet" and "I did not
 * understand you" are different facts and the user needs the first one.
 */
const NOT_YET: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly subject: string;
  readonly detail: string;
}> = [
  {
    pattern: /^(?:show|open|focus|bring up|switch to)\b/,
    subject: "showing a session",
    detail: "Focus and surface routing are §21 and arrive with the desktop surfaces.",
  },
  {
    pattern: /^dictate\b|\bdictate:/,
    subject: "dictation",
    // Not "not yet": dictation is built, and it is built on the client on
    // purpose. An environment has no business receiving the contents of
    // somebody's email, so the words never arrive here to be understood.
    detail:
      "Dictated words stay on your own device — the client handles them and never sends them here.",
  },
  {
    pattern:
      /\b(?:hand(?:\s+this)?\s+(?:off|over)|move\s+(?:this|it)\s+to|switch\s+(?:this|it)\s+to|take\s+over)\b/,
    subject: "an account handoff",
    detail: "Handoff needs a second account logged in on this environment.",
  },
  {
    pattern: /\b(?:stop|pause|mute)\s+listening\b/,
    subject: "listening control",
    detail: "There is no microphone in the environment; listening is the client's own.",
  },
];

/** Ahead of NOT_YET, whose "switch to" and "move it to" would otherwise claim these sentences. */
const SWITCH_ACCOUNT: ReadonlyArray<RegExp> = [
  /^(?:switch|change|rotate|move)\s+(?:the\s+)?accounts?\s+to\s+(?:the\s+)?(.+?)(?:\s+account)?$/,
  /^(?:switch\s+to|use)\s+(?:the\s+)?(.+?)\s+account$/,
];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

type Refusal = Extract<BatonIntentResolution, { outcome: "refused" }>;
type Resolved = Extract<BatonIntentResolution, { outcome: "resolved" }>;

const refuse = (reason: BatonIntentRefusalReason, unplaced: string, message: string): Refusal => ({
  outcome: "refused",
  refusal: { reason, unplaced, message },
});

const resolved = (input: {
  readonly command: BatonIntentCommand;
  readonly description: string;
  readonly risk: BatonIntentRisk;
  readonly workSessionId: string | null;
}): Resolved =>
  ({
    outcome: "resolved",
    command: input.command,
    description: input.description,
    risk: input.risk,
    workSessionId: input.workSessionId,
  }) as Resolved;

const label = (workSession: IntentWorkSession): string =>
  workSession.projectLabel === null
    ? workSession.title
    : `${workSession.projectLabel} / ${workSession.title}`;

type TargetMatch =
  | { readonly kind: "one"; readonly workSession: IntentWorkSession }
  | { readonly kind: "many"; readonly candidates: ReadonlyArray<IntentWorkSession> }
  | { readonly kind: "none" };

/**
 * Work sessions a phrase could mean, most specific first.
 *
 * "Most specific" is how many characters of the *phrase* the match actually
 * accounts for, not how long the matched name happens to be. That distinction
 * is the whole of it: "Storefront" matching the label of two work sessions is a
 * nine-character match against both and therefore ambiguous, while "scheduler
 * reconnect race" is a twenty-four-character match against one and therefore
 * is not. Scoring by the name's own length instead made the work session with
 * the longest title win every vague phrase.
 */
const matchWorkSessions = (phrase: string, vocabulary: IntentVocabulary): TargetMatch => {
  const needle = stripArticle(normalise(phrase));
  if (needle.length < 2) return { kind: "none" };

  let best = 0;
  let winners: IntentWorkSession[] = [];
  for (const workSession of vocabulary.workSessions) {
    const names = [
      workSession.title,
      workSession.projectLabel,
      workSession.projectLabel === null ? null : `${workSession.projectLabel} ${workSession.title}`,
      // The id is matchable because it is what a refusal falls back to naming
      // when two pieces of work share a title. A refusal the user cannot act
      // on is only half a refusal.
      workSession.id,
    ]
      .filter((name): name is string => name !== null)
      .map(normalise);
    for (const name of names) {
      const score =
        name === needle || wordBoundedContains(needle, name)
          ? name.length
          : needle.length >= 4 && wordBoundedContains(name, needle)
            ? needle.length
            : 0;
      if (score === 0) continue;
      if (score > best) {
        best = score;
        winners = [workSession];
      } else if (score === best && !winners.includes(workSession)) {
        winners.push(workSession);
      }
    }
  }
  if (winners.length === 0) return { kind: "none" };
  if (winners.length === 1) return { kind: "one", workSession: winners[0]! };
  return { kind: "many", candidates: winners };
};

const mostRecent = (vocabulary: IntentVocabulary): IntentWorkSession | null => {
  let best: IntentWorkSession | null = null;
  for (const workSession of vocabulary.workSessions) {
    if (best === null || workSession.updatedAt > best.updatedAt) best = workSession;
  }
  return best;
};

/**
 * §14's ladder, as far as an environment can climb it.
 *
 * Rung 1 is the explicit target in the utterance. Rung 3 is what the client
 * said is focused. Rung 6 is whatever moved last. The rungs in between are
 * desktop-surface facts the environment has never been told, and the ladder
 * deliberately stops rather than inventing them.
 */
const resolveTarget = (
  phrase: string | null,
  vocabulary: IntentVocabulary,
): TargetMatch | { readonly kind: "unknown"; readonly phrase: string } => {
  if (phrase !== null) {
    const cleaned = stripArticle(normalise(phrase));
    if (!PRONOUNS.has(cleaned) && cleaned.length > 0) {
      const match = matchWorkSessions(cleaned, vocabulary);
      if (match.kind === "none") {
        // A project with exactly one piece of work is not ambiguous.
        const project = vocabulary.projects.find(
          (candidate) =>
            normalise(candidate.title) === cleaned ||
            wordBoundedContains(cleaned, normalise(candidate.title)),
        );
        if (project !== undefined) {
          const owned = vocabulary.workSessions.filter(
            (workSession) => workSession.projectId === project.id,
          );
          if (owned.length === 1) return { kind: "one", workSession: owned[0]! };
          if (owned.length > 1) return { kind: "many", candidates: owned };
        }
        return { kind: "unknown", phrase: cleaned };
      }
      return match;
    }
  }
  const focused =
    vocabulary.focusedWorkSessionId === null
      ? null
      : (vocabulary.workSessions.find(
          (workSession) => workSession.id === vocabulary.focusedWorkSessionId,
        ) ?? null);
  const fallback = focused ?? mostRecent(vocabulary);
  return fallback === null ? { kind: "none" } : { kind: "one", workSession: fallback };
};

/**
 * "That could be X, or Y. Say which one."
 *
 * When two pieces of work share a label the names alone are useless — the live
 * run produced "That could be Intent proof, or Intent proof" — so the id is
 * added, and the id is matchable, which makes the refusal something the user
 * can answer rather than just a complaint.
 */
const ambiguous = (candidates: ReadonlyArray<IntentWorkSession>, phrase: string): Refusal => {
  const shown = candidates.slice(0, 4);
  const labels = shown.map(label);
  const duplicated = labels.some(
    (name, index) => labels.indexOf(name) !== index || labels.lastIndexOf(name) !== index,
  );
  return refuse(
    "ambiguous_target",
    phrase,
    `That could be ${shown
      .map((candidate, index) =>
        duplicated ? `${labels[index]} (${candidate.id})` : (labels[index] ?? candidate.title),
      )
      .join(", or ")}. Say which one.`,
  );
};

const noWorkSessions = (phrase: string): Refusal =>
  refuse(
    "unknown_target",
    phrase,
    'There is no work here to point that at yet. Start some with "start work on <project>".',
  );

const matchProvider = (phrase: string, vocabulary: IntentVocabulary): IntentProvider | null => {
  const needle = stripArticle(normalise(phrase));
  let best: IntentProvider | null = null;
  let bestLength = 0;
  for (const provider of vocabulary.providers) {
    for (const alias of provider.aliases) {
      const name = normalise(alias);
      if (name.length === 0) continue;
      if (name === needle || wordBoundedContains(needle, name)) {
        if (name.length > bestLength) {
          bestLength = name.length;
          best = provider;
        }
      }
    }
  }
  return best;
};

/**
 * "… with Claude B" / "… using codex".
 *
 * Deliberately not "on": "on" introduces a host, and one preposition doing two
 * jobs is how "start work on Storefront on the office box" becomes a complaint
 * about an account nobody named.
 */
const splitProviderClause = (
  text: string,
): { readonly rest: string; readonly providerPhrase: string | null } => {
  const match = /^(.*?)\s+(?:with|using)\s+([a-z0-9][a-z0-9 _-]*)$/.exec(text);
  if (match === null) return { rest: text, providerPhrase: null };
  return { rest: (match[1] ?? "").trim(), providerPhrase: (match[2] ?? "").trim() };
};

/** "… on the office box" — a machine, never an account. */
const splitHostClause = (
  text: string,
): { readonly rest: string; readonly hostPhrase: string | null } => {
  const match = /^(.*?)\s+on\s+(?:the\s+)?([a-z0-9][a-z0-9 _-]*)$/.exec(text);
  if (match === null) return { rest: text, hostPhrase: null };
  return { rest: (match[1] ?? "").trim(), hostPhrase: (match[2] ?? "").trim() };
};

const providerVocabulary = (vocabulary: IntentVocabulary): ProviderVocabulary => {
  const byName = new Map<string, string>();
  for (const provider of vocabulary.providers) {
    for (const alias of provider.aliases) {
      const name = normalise(alias);
      if (name.length > 0 && !byName.has(name)) byName.set(name, provider.instanceId);
    }
  }
  const models = new Map(
    vocabulary.providers.map((provider) => [provider.instanceId, provider.model]),
  );
  return { byName, modelFor: (instanceId) => models.get(instanceId) ?? null };
};

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

const FLEET_QUESTIONS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly question: "needs_me" | "running" | "finished" | "everything";
}> = [
  {
    pattern:
      /^(?:what|who|anything|does anything|is there anything)\b[^?]*\bneeds?\s+(?:me|you|my attention|your attention)\b/,
    question: "needs_me",
  },
  {
    pattern: /^(?:what|anything)\b[^?]*\b(?:finished|completed|is done|are done|has finished)\b/,
    question: "finished",
  },
  {
    pattern:
      /^what(?:'s| is| are)?\s+(?:everything|they|the fleet|we)\b[^?]*\b(?:doing|up to|working on)\b/,
    question: "running",
  },
  { pattern: /^what(?:'s| is)?\s+running\b/, question: "running" },
  { pattern: /^(?:what|who)\b[^?]*\bis\s+(?:still\s+)?(?:running|working)\b/, question: "running" },
  { pattern: /^(?:roll call|who's working|whos working)\b/, question: "running" },
  { pattern: /^(?:status|sitrep|a status|the status|status report)\b$/, question: "everything" },
  { pattern: /^where are we\b$/, question: "everything" },
  { pattern: /^what(?:'s| is)?\s+(?:going on|happening|the status)\b$/, question: "everything" },
];

const SESSION_STATUS: ReadonlyArray<RegExp> = [
  /^what(?:'s| is)\s+(.+?)\s+(?:doing|up to|working on)$/,
  /^how(?:'s| is)\s+(.+?)\s+(?:doing|going|getting on)$/,
  /^where are we\s+(?:on|with)\s+(.+)$/,
  /^what(?:'s| is)\s+(?:the\s+)?status\s+(?:of|on|for)\s+(.+)$/,
  /^what happened\s+(?:to|with)\s+(.+)$/,
  /^is\s+(.+?)\s+(?:done|finished|still going)$/,
];

const MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:tell|ask|message|send)\s+(.+?)\s*:\s*(.+)$/,
  /^(?:tell|ask)\s+(.+?)\s+to\s+(.+)$/,
  /^(?:tell|ask)\s+(.+?)\s+that\s+(.+)$/,
];

const START_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:start|open|spin up|kick off|begin)\s+(?:some\s+|a\s+|an\s+|new\s+)*(?:work\s+session|work|session)\s+(?:on|for|in)\s+(.+)$/,
  /^(?:start|open|spin up|kick off|begin)\s+(?:a\s+|an\s+|new\s+)*(?:work\s+session|session)\s+(?:on|for|in)\s+(.+)$/,
];

const RESUME_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:continue|resume|carry on with|keep going on|pick up|get back to)\s+(.+)$/,
];

const AFFIRMATIVE =
  /^(?:yes|yeah|yep|yup|sure|go ahead|do it|confirm|confirmed|approve|approved|proceed|ok|okay)\b(.*)$/;
const NEGATIVE = /^(?:no|nope|nah|don't|do not|cancel|decline|reject|stop that|never mind)\b(.*)$/;

/**
 * "Yes, go ahead on the search ranking" is one answer with three ways of
 * saying yes in front of the target. Strip them all, or the target clause is
 * never reached and the answer looks ambiguous when it is not.
 */
const ANSWER_FILLER =
  /^(?:[,\s]+|and\b|then\b|please\b|go ahead\b|do it\b|sure\b|ok(?:ay)?\b|yes\b|yeah\b|confirm(?:ed)?\b|approve(?:d)?\b|proceed\b|it\b|that\b)/;

const stripAnswerFiller = (text: string): string => {
  let out = text.trim();
  while (ANSWER_FILLER.test(out)) out = out.replace(ANSWER_FILLER, "").trim();
  return out;
};

/**
 * Resolve one sentence.
 *
 * Order is part of the contract: high-risk phrases are checked before anything
 * can match them as an instruction, and the phases that do not exist are named
 * before the grammar can mistake them for something it does handle.
 */
/**
 * §24.1's HIGH list, as a predicate other code can reuse.
 *
 * Exported because the model path has to apply the same test to what a model
 * *produced*, not only to what the user said (D50): a model asked to be helpful
 * is exactly the component that would paraphrase a refused request into wording
 * that no longer matches. One list, two call sites, no drift.
 *
 * Returns the subject to name in the refusal, or null.
 */
/**
 * The canonical form of a sentence: lower case, straight quotes, single spaces,
 * no trailing punctuation.
 *
 * Exported because the learned-vocabulary table keys on it (D50), and a second
 * implementation there would mean "what needs me?" and "What needs me" hit
 * different rows in the memory and the same branch in the grammar.
 */
export function normaliseIntentText(text: string): string {
  return stripTerminator(normalise(text));
}

export function highRiskSubject(text: string): string | null {
  const raw = stripTerminator(normalise(text));
  for (const entry of HIGH_RISK) {
    if (entry.pattern.test(raw)) return entry.subject;
  }
  return null;
}

export function resolveBatonIntent(
  sentence: string,
  vocabulary: IntentVocabulary,
): BatonIntentResolution {
  const source = sentence.trim();
  const raw = stripTerminator(normalise(source));
  if (raw.length === 0) {
    return refuse("unrecognised", "", "There was nothing to do.");
  }

  for (const entry of HIGH_RISK) {
    if (entry.pattern.test(raw)) {
      return refuse(
        "high_risk",
        source,
        `That asks for ${entry.subject}. Tessaya never does that from a sentence — do it yourself, with the change in front of you.`,
      );
    }
  }

  const text = stripPrefixes(raw);
  if (text.length === 0) {
    return refuse("unrecognised", source, "That was a wake word and nothing else.");
  }

  for (const pattern of SWITCH_ACCOUNT) {
    const accountLabel = pattern.exec(text)?.[1]?.trim();
    if (accountLabel) {
      // Only work he is looking at: moving the work that changed last would be a guess about billing.
      const work =
        vocabulary.workSessions.find((entry) => entry.id === vocabulary.focusedWorkSessionId) ??
        null;
      if (work === null) {
        return refuse(
          "ambiguous_target",
          source,
          "Open the work to move first, then say it again.",
        );
      }
      return resolved({
        command: {
          kind: "switch_account",
          accountLabel: accountLabel as never,
          workSessionId: work.id as never,
        },
        description: `Move ${label(work)} to ${accountLabel}.`,
        risk: "medium",
        workSessionId: work.id,
      });
    }
  }

  for (const entry of NOT_YET) {
    if (entry.pattern.test(text)) {
      return refuse(
        "not_available_yet",
        source,
        `I understood that as ${entry.subject}, which is not built yet. ${entry.detail}`,
      );
    }
  }

  const gate = resolveGateAnswer(text, source, vocabulary);
  if (gate !== null) return gate;

  if (/^(?:when|whenever|if|once|as soon as)\b/.test(text)) {
    return resolveRuleSentence(source, vocabulary);
  }

  const message = resolveMessage(text, source, vocabulary);
  if (message !== null) return message;

  const start = resolveStart(text, vocabulary);
  if (start !== null) return start;

  const resume = resolveResume(text, vocabulary);
  if (resume !== null) return resume;

  for (const entry of FLEET_QUESTIONS) {
    if (entry.pattern.test(text)) {
      return resolved({
        command: { kind: "status_fleet", question: entry.question },
        description: FLEET_DESCRIPTIONS[entry.question],
        risk: "low",
        workSessionId: null,
      });
    }
  }

  for (const pattern of SESSION_STATUS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const phrase = match[1] ?? "";
    const target = resolveTarget(phrase, vocabulary);
    if (target.kind === "unknown") {
      return refuse(
        "unknown_target",
        target.phrase,
        `I could not place "${target.phrase}". Say the project or the work by name.`,
      );
    }
    if (target.kind === "many") return ambiguous(target.candidates, phrase);
    if (target.kind === "none") return noWorkSessions(phrase);
    return resolved({
      command: { kind: "status_work_session", workSessionId: target.workSession.id as never },
      description: `Say what ${label(target.workSession)} is doing.`,
      risk: "low",
      workSessionId: target.workSession.id,
    });
  }

  return refuse(
    "unrecognised",
    source,
    `I could not place "${source}". Try "what needs me", "tell <name>: …", "start work on <project> with <account>", or "when … , have … review it".`,
  );
}

const FLEET_DESCRIPTIONS: Record<"needs_me" | "running" | "finished" | "everything", string> = {
  needs_me: "Say what needs you.",
  running: "Say what is running.",
  finished: "Say what finished.",
  everything: "Say where everything is.",
};

function resolveGateAnswer(
  text: string,
  source: string,
  vocabulary: IntentVocabulary,
): BatonIntentResolution | null {
  const affirmative = AFFIRMATIVE.exec(text);
  const negative = affirmative === null ? NEGATIVE.exec(text) : null;
  const match = affirmative ?? negative;
  if (match === null) return null;
  const confirmed = affirmative !== null;
  const tail = stripAnswerFiller(match[1] ?? "");

  if (vocabulary.openGates.length === 0) {
    // A better refusal when something *is* waiting, just not for us: a thread
    // approval is T3's own surface and this phase cannot answer one.
    const waiting = vocabulary.workSessions.some((workSession) => workSession.needsApproval);
    return refuse(
      "nothing_to_confirm",
      source,
      waiting
        ? "Nothing is waiting on a confirmation here. A provider's own approval request has to be answered in its session."
        : "Nothing is waiting for an answer.",
    );
  }

  const targetPhrase = /^(?:on|for|about|to|with)\s+(.+)$/.exec(tail)?.[1] ?? null;
  let gates = vocabulary.openGates;
  if (targetPhrase !== null) {
    const target = resolveTarget(targetPhrase, vocabulary);
    if (target.kind === "unknown") {
      return refuse(
        "unknown_target",
        target.phrase,
        `I could not place "${target.phrase}". Name the project or the work session.`,
      );
    }
    if (target.kind === "many") return ambiguous(target.candidates, targetPhrase);
    if (target.kind === "one") {
      const workSessionId = target.workSession.id;
      gates = gates.filter((entry) => entry.workSessionId === workSessionId);
      if (gates.length === 0) {
        return refuse(
          "nothing_to_confirm",
          targetPhrase,
          `${label(target.workSession)} is not waiting for an answer.`,
        );
      }
    }
  }

  if (gates.length > 1) {
    return refuse(
      "ambiguous_target",
      source,
      `${gates.length} questions are waiting. Say which one: ${gates
        .slice(0, 3)
        .map((entry) => `"${entry.question}"`)
        .join(", ")}.`,
    );
  }

  const only = gates[0]!;
  return resolved({
    command: { kind: "answer_gate", firingId: only.firingId as never, confirmed },
    description: `Answer ${confirmed ? "yes" : "no"} to: ${only.question}`,
    // Answering yes releases whatever was queued behind the gate, which is the
    // point at which automation starts running again.
    risk: "medium",
    workSessionId: only.workSessionId,
  });
}

function resolveRuleSentence(source: string, vocabulary: IntentVocabulary): BatonIntentResolution {
  const target = resolveTarget(null, vocabulary);
  if (target.kind !== "one") {
    return refuse(
      "unknown_target",
      source,
      "There is no work here to attach a rule to. Start the work first.",
    );
  }
  const parsed = parseOrchestrationSentence(source, providerVocabulary(vocabulary));
  if (!parsed.ok) {
    return refuse("rule_not_understood", parsed.unplaced, parsed.reason);
  }
  const rules = parsed.rules;
  const startsSession = rules.some((rule) => rule.action.kind === "start_provider_session");
  return resolved({
    command: {
      kind: "create_rules",
      workSessionId: target.workSession.id as never,
      rules,
      // The user's own sentence travels with the rules, so each one can be
      // read back in the words that made it.
      source,
    },
    description: `Create ${rules.length === 1 ? "a rule" : `${rules.length} rules`} on ${label(target.workSession)}.`,
    // Creating is cheap; what it will later spend is not, and the read-back
    // should carry that weight before the user presses enter.
    risk: startsSession ? "medium" : "low",
    workSessionId: target.workSession.id,
  });
}

function resolveMessage(
  text: string,
  source: string,
  vocabulary: IntentVocabulary,
): BatonIntentResolution | null {
  for (const pattern of MESSAGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const phrase = (match[1] ?? "").trim();
    const body = (match[2] ?? "").trim();
    if (body.length === 0) continue;
    const target = resolveTarget(phrase, vocabulary);
    if (target.kind === "unknown") {
      return refuse(
        "unknown_target",
        target.phrase,
        `I could not place "${target.phrase}". Say the work or the project by name.`,
      );
    }
    if (target.kind === "many") return ambiguous(target.candidates, phrase);
    if (target.kind === "none") return noWorkSessions(phrase);
    // The user's own words, restored from the original so capitalisation and
    // punctuation survive: this text becomes a message to an agent.
    const spoken = restoreCase(source, body);
    return resolved({
      command: {
        kind: "message_work_session",
        workSessionId: target.workSession.id as never,
        text: spoken,
      },
      description: `Tell ${label(target.workSession)}: ${spoken}`,
      risk: "low",
      workSessionId: target.workSession.id,
    });
  }
  return null;
}

function resolveStart(text: string, vocabulary: IntentVocabulary): BatonIntentResolution | null {
  for (const pattern of START_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const tail = (match[1] ?? "").trim();
    const withProvider = splitProviderClause(tail);
    const host = splitHostClause(withProvider.rest);
    const hostRefusal = checkHost(host.hostPhrase, vocabulary);
    if (hostRefusal !== null) return hostRefusal;
    const body = host.hostPhrase !== null ? host.rest : withProvider.rest;

    const { subject, title } = splitTitleClause(body);
    const projectPhrase = stripArticle(subject);
    const project = vocabulary.projects.find((candidate) => {
      const name = normalise(candidate.title);
      return name === projectPhrase || wordBoundedContains(projectPhrase, name);
    });
    if (project === undefined) {
      return refuse(
        "unknown_target",
        projectPhrase,
        `I could not place the project "${projectPhrase}".`,
      );
    }
    const provider = chooseProvider(withProvider.providerPhrase, vocabulary);
    if ("refusal" in provider) return provider.refusal;

    return resolved({
      command: {
        kind: "start_work_session",
        projectId: project.id as never,
        title: title ?? "New work",
        providerInstanceId: provider.provider.instanceId as never,
        model: provider.model,
      },
      description: `Start work on ${project.title} with ${provider.provider.label}.`,
      risk: "medium",
      workSessionId: null,
    });
  }
  return null;
}

function resolveResume(text: string, vocabulary: IntentVocabulary): BatonIntentResolution | null {
  for (const pattern of RESUME_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const tail = (match[1] ?? "").trim();
    const withProvider = splitProviderClause(tail);
    const host = splitHostClause(withProvider.rest);
    const hostRefusal = checkHost(host.hostPhrase, vocabulary);
    if (hostRefusal !== null) return hostRefusal;
    const body = host.hostPhrase !== null ? host.rest : withProvider.rest;

    const target = resolveTarget(body.length === 0 ? null : body, vocabulary);
    if (target.kind === "unknown") {
      return refuse(
        "unknown_target",
        target.phrase,
        `I could not place "${target.phrase}". Name the project or the work session.`,
      );
    }
    if (target.kind === "many") return ambiguous(target.candidates, body);
    if (target.kind === "none") return noWorkSessions(body);
    const provider = chooseProvider(withProvider.providerPhrase, vocabulary);
    if ("refusal" in provider) return provider.refusal;

    return resolved({
      command: {
        kind: "resume_work_session",
        workSessionId: target.workSession.id as never,
        providerInstanceId: provider.provider.instanceId as never,
        model: provider.model,
      },
      description: `Open another ${provider.provider.label} session on ${label(target.workSession)}.`,
      risk: "medium",
      workSessionId: target.workSession.id,
    });
  }
  return null;
}

/**
 * A named host that is not this one is not an error in the sentence — it is a
 * sentence sent to the wrong environment, and saying so is more useful than
 * silently doing the work here.
 */
function checkHost(phrase: string | null, vocabulary: IntentVocabulary): Refusal | null {
  if (phrase === null) return null;
  const known = vocabulary.hostAliases.some(
    (alias) => normalise(alias) === phrase || wordBoundedContains(phrase, normalise(alias)),
  );
  if (known) return null;
  // Only refuse when the phrase is clearly about a machine. "on the scheduler"
  // is a piece of work, and taking it for a host would break every resume.
  return /\b(?:box|host|machine|server|environment|laptop|desktop)\b/.test(phrase)
    ? refuse("unknown_target", phrase, `This environment is not "${phrase}". Ask the one that is.`)
    : null;
}

function chooseProvider(
  phrase: string | null,
  vocabulary: IntentVocabulary,
): { readonly provider: IntentProvider; readonly model: string } | { readonly refusal: Refusal } {
  if (phrase !== null) {
    const named = matchProvider(phrase, vocabulary);
    if (named === null) {
      return {
        refusal: refuse(
          "unknown_target",
          phrase,
          `I could not place the account "${phrase}". Settings -> Providers lists the ones this machine has.`,
        ),
      };
    }
    if (!named.available) {
      return {
        refusal: refuse(
          "unknown_target",
          phrase,
          `${named.label} is not available on this environment.`,
        ),
      };
    }
    if (named.model === null) {
      return {
        refusal: refuse(
          "unknown_target",
          phrase,
          `${named.label} has no model configured here. Pick one for it in Settings -> Providers.`,
        ),
      };
    }
    return { provider: named, model: named.model };
  }
  // No account named. One usable account is not a guess; several is.
  const usable = vocabulary.providers.filter(
    (provider) => provider.available && provider.model !== null,
  );
  const only = usable[0];
  if (usable.length === 1 && only !== undefined) {
    return { provider: only, model: only.model as string };
  }
  if (usable.length === 0) {
    return {
      refusal: refuse(
        "unknown_target",
        "",
        "No account is available on this environment. Add one in Settings -> Providers, or sign the CLI in on that machine.",
      ),
    };
  }
  return {
    refusal: refuse(
      "ambiguous_target",
      "",
      `Say which account: ${usable.map((provider) => provider.label).join(", ")}.`,
    ),
  };
}

/** "… called X", "… : X", "… to X" — the human name for a new piece of work. */
function splitTitleClause(text: string): {
  readonly subject: string;
  readonly title: string | null;
} {
  const explicit = /^(.*?)\s*(?::|\bcalled\b|\bnamed\b|\bto\b)\s+(.+)$/.exec(text);
  if (explicit === null) return { subject: text, title: null };
  const subject = (explicit[1] ?? "").trim();
  const title = (explicit[2] ?? "").trim();
  return subject.length === 0 ? { subject: text, title: null } : { subject, title };
}

/**
 * Give the lower-cased fragment its original characters back.
 *
 * The grammar works on normalised text; the message that reaches an agent
 * should be what the user actually typed or dictated, capitals and all.
 */
function restoreCase(source: string, fragment: string): string {
  const index = source.toLowerCase().indexOf(fragment.toLowerCase());
  if (index === -1) return fragment;
  return source.slice(index, index + fragment.length).trim();
}
