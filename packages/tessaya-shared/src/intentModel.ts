/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The model's half of the intent path, with none of the model in it.
 *
 * D50 reversed D24: a sentence the grammar cannot place is now read by a model
 * rather than refused. What did **not** change is the thing that made the
 * grammar-only design safe, and this module is where that is enforced:
 *
 *   1. **The model answers in a schema, not in prose.** It picks a command kind
 *      from a closed list and names its target by an id it was shown. It cannot
 *      invent a work session, a project, an account or a parked question.
 *   2. **Every id it returns is checked against the same vocabulary the grammar
 *      uses.** An id that is not in that list is a refusal that names what the
 *      model said, not a best-effort match.
 *   3. **§24.1 is matched deterministically before and after.** Before, by the
 *      grammar, which refuses a high-risk sentence and never reaches here.
 *      After, by `highRiskSubject` applied to the effectful free text the model
 *      produced — because a model asked to be helpful is exactly the component
 *      that would turn a vague sentence into "deploy to production" inside the
 *      message an agent then receives.
 *   4. **Low confidence is a question, never a guess.** Two plausible readings
 *      produce a refusal carrying the model's own question, which the input
 *      shows before Enter does anything.
 *
 * Nothing here calls a model, spawns a process or reads a clock: this is the
 * prompt, the reply schema, and the function that turns a reply into a
 * resolution or a refusal. That is what makes every rule above testable without
 * spending a turn.
 *
 * @module batonIntentModel
 */
import type {
  TessayaIntentCommand,
  TessayaIntentResolution,
  TessayaIntentRisk,
} from "@t3tools/tessaya-contracts";

import { highRiskSubject, type IntentVocabulary } from "./intentParser.ts";

/** The command kinds a model may produce. */
export const MODEL_INTENT_KINDS = [
  "status_fleet",
  "status_work_session",
  "message_work_session",
  "resume_work_session",
  "start_work_session",
  "answer_gate",
  "none",
] as const;
export type ModelIntentKind = (typeof MODEL_INTENT_KINDS)[number];

export const MODEL_STATUS_QUESTIONS = ["needs_me", "running", "finished", "everything"] as const;

/**
 * What the model must return.
 *
 * Flat, nullable fields rather than a discriminated union: a union in a JSON
 * schema is where small models produce their most confident nonsense, and every
 * field here is checked against the vocabulary afterwards anyway. `create_rules`
 * is deliberately absent — rule sentences have their own grammar, they read
 * back as rules before they are created, and a model drafting orchestration is
 * a larger decision than this one.
 */
export interface IntentModelReply {
  readonly kind: ModelIntentKind;
  /** For `status_fleet`. */
  readonly statusQuestion: string | null;
  /** An id from the work sessions the prompt listed. */
  readonly workSessionId: string | null;
  /** An id from the projects the prompt listed. */
  readonly projectId: string | null;
  /** An instance id from the accounts the prompt listed. */
  readonly providerInstanceId: string | null;
  /** For `start_work_session`: what the work is called. */
  readonly title: string | null;
  /** For `message_work_session`: the user's own words, not a paraphrase. */
  readonly message: string | null;
  /** For `answer_gate`: the id of a question the prompt listed as waiting. */
  readonly firingId: string | null;
  readonly confirmed: boolean | null;
  /** One line, in the user's terms, for the read-back. */
  readonly description: string;
  readonly confidence: "high" | "low";
  /** What to ask when the reading is not certain. */
  readonly question: string | null;
}

/**
 * The JSON schema handed to the CLI's structured-output flag.
 *
 * Written by hand rather than derived: the descriptions are the prompt. A model
 * reading `"an id copied exactly from the list above"` behaves differently from
 * one reading `"string"`, and that difference is most of the accuracy.
 */
export const INTENT_MODEL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "statusQuestion",
    "workSessionId",
    "projectId",
    "providerInstanceId",
    "title",
    "message",
    "firingId",
    "confirmed",
    "description",
    "confidence",
    "question",
  ],
  properties: {
    kind: {
      type: "string",
      enum: [...MODEL_INTENT_KINDS],
      description:
        "What the sentence asks for. Use 'none' when it asks for something not in this list, or when you cannot tell.",
    },
    statusQuestion: {
      type: ["string", "null"],
      enum: [...MODEL_STATUS_QUESTIONS, null],
      description:
        "Only for kind='status_fleet'. Copy one of these four words exactly: needs_me, running, finished, everything. Never write a sentence here.",
    },
    workSessionId: {
      type: ["string", "null"],
      description: "An id copied exactly from the WORK list. Never invent one.",
    },
    projectId: {
      type: ["string", "null"],
      description: "An id copied exactly from the PROJECTS list. Never invent one.",
    },
    providerInstanceId: {
      type: ["string", "null"],
      description: "An id copied exactly from the ACCOUNTS list. Never invent one.",
    },
    title: {
      type: ["string", "null"],
      description: "Only for kind='start_work_session'. A short name for the new work.",
    },
    message: {
      type: ["string", "null"],
      description:
        "Only for kind='message_work_session'. The user's own words for the agent, verbatim after the target. Never a paraphrase.",
    },
    firingId: {
      type: ["string", "null"],
      description: "An id copied exactly from the WAITING list. Never invent one.",
    },
    confirmed: {
      type: ["boolean", "null"],
      description: "Only for kind='answer_gate'. True for yes, false for no.",
    },
    description: {
      type: "string",
      description:
        "One line in the user's own terms describing what will happen, e.g. 'Tell Claude on Scheduler: run the tests.' This is read back before anything runs.",
    },
    confidence: {
      type: "string",
      enum: ["high", "low"],
      description:
        "'low' only when the sentence fits two different entries in the same list, or two different kinds, and you would have to guess between them. A casual or short sentence is not a reason for 'low'.",
    },
    question: {
      type: ["string", "null"],
      description: "When confidence is low, the one question that would settle it.",
    },
  },
} as const;

/** How many entries of each kind the prompt carries. */
export const PROMPT_LIST_LIMIT = 40;

const list = (entries: ReadonlyArray<string>): string => {
  if (entries.length === 0) return "  (none)";
  const shown = entries.slice(0, PROMPT_LIST_LIMIT).map((entry) => `  ${entry}`);
  return entries.length <= PROMPT_LIST_LIMIT
    ? shown.join("\n")
    : [...shown, `  (+${entries.length - PROMPT_LIST_LIMIT} more, least recently touched)`].join(
        "\n",
      );
};

/**
 * Everything the model is allowed to know, and nothing else.
 *
 * No thread contents, no diffs, no file paths: a sentence is placed against
 * *names and ids*, and sending an agent's transcript to a classifier would be a
 * privacy decision nobody made.
 */
export function buildIntentModelPrompt(input: {
  readonly sentence: string;
  readonly vocabulary: IntentVocabulary;
}): string {
  const { sentence, vocabulary } = input;
  const focused = vocabulary.focusedWorkSessionId;

  return [
    "You turn one spoken sentence into one command for a software agent fleet.",
    "The person speaking owns this fleet and is talking about the work listed below,",
    "casually and in their own words. Your job is to place the sentence, not to check it.",
    "",
    "The kinds, with the sort of sentence that means each one:",
    '  status_fleet          — about everything: "what\'s cooking", "where is everything", "anything need me", "what finished"',
    '  status_work_session   — about one piece of work: "how is the scheduler doing", "is that one stuck", "what did it end up doing"',
    '  message_work_session  — words for the agent doing one piece of work: "tell it to stop", "poke it and ask where it got to", "ask it to run the tests"',
    '  resume_work_session   — put an account back on work that already exists: "get that one moving again", "have claude take another look at it"',
    '  start_work_session    — begin new work on a project: "spin something up on <project> to look at X", "start work on <project>"',
    '  answer_gate           — yes or no to a question in WAITING: "yeah go ahead", "no, hold off"',
    "  none                  — the sentence asks for something that is not one of the above",
    "",
    "Rules:",
    "- Only ever use ids copied exactly from the lists below. Never invent an id.",
    '- A description that fits exactly one entry in a list IS that entry. "the radar one" is the work whose title mentions radar. "it" and "that one" mean the work the user is looking at, when one is marked.',
    "- If the sentence names something that is in none of the lists, answer kind='none'.",
    "- Use confidence='low' **only** when the sentence genuinely fits two different entries in the same list, or two different kinds, and you would have to guess. A casual or short sentence is not by itself a reason for low confidence. When you use it, give the one question that settles it.",
    "- Never answer a sentence that asks to deploy to production, merge a protected branch, touch credentials, drop data, change permissions or spend money. Answer kind='none' for those.",
    "- For message_work_session, `message` is what the agent should be told, in the user's own words — not a paraphrase and not a summary of the sentence.",
    "- The description is read aloud to the user before anything happens. Write it in their terms.",
    "",
    "WORK (id — project — title):",
    list(
      vocabulary.workSessions.map(
        (workSession) =>
          `${workSession.id} — ${workSession.projectLabel ?? workSession.projectId} — ${workSession.title}${
            workSession.id === focused ? "   [the user is looking at this one]" : ""
          }${workSession.needsApproval ? "   [waiting for approval]" : ""}`,
      ),
    ),
    "",
    "PROJECTS (id — title):",
    list(vocabulary.projects.map((project) => `${project.id} — ${project.title}`)),
    "",
    // Only the accounts that can actually be chosen: naming the others invites
    // the model to pick one, and every such pick is refused downstream anyway.
    "ACCOUNTS (id — label):",
    list(
      vocabulary.providers
        .filter((provider) => provider.available)
        .map((provider) => `${provider.instanceId} — ${provider.label}`),
    ),
    "",
    "WAITING (id — question):",
    list(vocabulary.openGates.map((gate) => `${gate.firingId} — ${gate.question}`)),
    "",
    "The sentence:",
    sentence,
  ]
    .filter((section) => section !== "")
    .join("\n");
}

const refuse = (
  reason: "unrecognised" | "unknown_target" | "high_risk" | "ambiguous_target",
  unplaced: string,
  message: string,
): TessayaIntentResolution => ({
  outcome: "refused",
  refusal: { reason, unplaced, message },
});

const resolved = (input: {
  readonly command: TessayaIntentCommand;
  readonly description: string;
  readonly risk: TessayaIntentRisk;
  readonly workSessionId: string | null;
}): TessayaIntentResolution => ({
  outcome: "resolved",
  command: input.command,
  description: input.description,
  risk: input.risk,
  workSessionId: input.workSessionId as never,
});

/**
 * Turn a model reply into a resolution, or into a refusal that says why.
 *
 * Every branch that rejects something says what the model returned, because the
 * only way to improve a prompt is to see what it produced.
 */
export function interpretIntentModelReply(input: {
  readonly sentence: string;
  readonly reply: IntentModelReply;
  readonly vocabulary: IntentVocabulary;
}): TessayaIntentResolution {
  const { sentence, reply, vocabulary } = input;

  // §24.1 on the way out. The sentence itself was checked by the grammar before
  // the model ever saw it; this catches the case where a model turns a refused
  // request into a differently-worded command.
  //
  // What is checked is the sentence and the **free text the model produced that
  // has an effect** — the message an agent would receive, the title new work
  // would carry. Deliberately not the description: it quotes names this
  // environment already holds, and a work session called "Production deploy
  // check" would then make every sentence about it unanswerable. The user
  // naming their own work is not the user asking for a deploy.
  const risky = highRiskSubject([sentence, reply.message ?? "", reply.title ?? ""].join(" \n "));
  if (risky !== null) {
    return refuse(
      "high_risk",
      sentence,
      `That asks for ${risky}. Tessaya never does that from a sentence — do it yourself, with the change in front of you.`,
    );
  }

  if (reply.kind === "none") {
    return refuse(
      "unrecognised",
      sentence,
      reply.question?.trim() ||
        `I could not place "${sentence}". Try naming the work, the project or the account.`,
    );
  }

  if (reply.confidence === "low") {
    return refuse(
      "ambiguous_target",
      sentence,
      reply.question?.trim() || `I read that two ways. Say which work you mean.`,
    );
  }

  const description = reply.description.trim();
  if (description.length === 0) {
    return refuse("unrecognised", sentence, "I could not describe what that would do.");
  }

  const workSession =
    reply.workSessionId === null
      ? null
      : (vocabulary.workSessions.find((entry) => entry.id === reply.workSessionId) ?? "missing");
  if (workSession === "missing") {
    return refuse(
      "unknown_target",
      reply.workSessionId ?? "",
      `I could not place work "${reply.workSessionId ?? ""}" — it is not here.`,
    );
  }

  const provider =
    reply.providerInstanceId === null
      ? null
      : (vocabulary.providers.find((entry) => entry.instanceId === reply.providerInstanceId) ??
        "missing");
  if (provider === "missing") {
    return refuse(
      "unknown_target",
      reply.providerInstanceId ?? "",
      `I could not place account "${reply.providerInstanceId ?? ""}" — it is not configured here.`,
    );
  }
  if (provider !== null && !provider.available) {
    return refuse(
      "unknown_target",
      provider.label,
      `${provider.label} is not available right now.`,
    );
  }

  switch (reply.kind) {
    case "status_fleet": {
      // A model that writes "What is the current status of all work?" into an
      // enum field has answered the question that matters — *which kind* — and
      // fumbled the one that does not. Falling back to `everything` is safe in
      // a way that no other fallback in this file would be: every status
      // question is a read, `everything` is the superset of the other three,
      // and no target is being guessed. Observed on a real run: two of ten
      // sentences came back exactly like this.
      const named = reply.statusQuestion ?? "everything";
      const question = MODEL_STATUS_QUESTIONS.some((candidate) => candidate === named)
        ? named
        : "everything";
      return resolved({
        command: { kind: "status_fleet", question: question as never },
        description,
        risk: "low",
        workSessionId: null,
      });
    }
    case "status_work_session": {
      if (workSession === null) {
        return refuse("unknown_target", sentence, "Say which work you mean.");
      }
      return resolved({
        command: { kind: "status_work_session", workSessionId: workSession.id as never },
        description,
        risk: "low",
        workSessionId: workSession.id,
      });
    }
    case "message_work_session": {
      if (workSession === null) {
        return refuse("unknown_target", sentence, "Say which work the message is for.");
      }
      const text = reply.message?.trim() ?? "";
      if (text.length === 0) {
        return refuse("unrecognised", sentence, "There was no message in that.");
      }
      return resolved({
        command: {
          kind: "message_work_session",
          workSessionId: workSession.id as never,
          text: text as never,
        },
        description,
        risk: "low",
        workSessionId: workSession.id,
      });
    }
    case "resume_work_session": {
      if (workSession === null) {
        return refuse("unknown_target", sentence, "Say which work to open a session on.");
      }
      const chosen = provider ?? vocabulary.providers.find((entry) => entry.available) ?? null;
      if (chosen === null || chosen.model === null) {
        return refuse("unknown_target", sentence, "No account here is available to run that.");
      }
      return resolved({
        command: {
          kind: "resume_work_session",
          workSessionId: workSession.id as never,
          providerInstanceId: chosen.instanceId as never,
          model: chosen.model as never,
        },
        description,
        risk: "medium",
        workSessionId: workSession.id,
      });
    }
    case "start_work_session": {
      const project =
        reply.projectId === null
          ? null
          : (vocabulary.projects.find((entry) => entry.id === reply.projectId) ?? "missing");
      if (project === "missing" || project === null) {
        return refuse(
          "unknown_target",
          reply.projectId ?? sentence,
          `I could not place project "${reply.projectId ?? ""}".`,
        );
      }
      const chosen = provider ?? vocabulary.providers.find((entry) => entry.available) ?? null;
      if (chosen === null || chosen.model === null) {
        return refuse("unknown_target", sentence, "No account here is available to start that.");
      }
      return resolved({
        command: {
          kind: "start_work_session",
          projectId: project.id as never,
          title: (reply.title?.trim() || "New work") as never,
          providerInstanceId: chosen.instanceId as never,
          model: chosen.model as never,
        },
        description,
        risk: "medium",
        workSessionId: null,
      });
    }
    case "answer_gate": {
      const gate = vocabulary.openGates.find((entry) => entry.firingId === reply.firingId);
      if (gate === undefined) {
        return refuse(
          "unknown_target",
          reply.firingId ?? sentence,
          vocabulary.openGates.length === 0
            ? "Nothing is waiting for an answer."
            : "Say which waiting question that answers.",
        );
      }
      if (reply.confirmed === null) {
        return refuse("unrecognised", sentence, "I could not tell whether that was yes or no.");
      }
      return resolved({
        command: {
          kind: "answer_gate",
          firingId: gate.firingId as never,
          confirmed: reply.confirmed,
        },
        description,
        risk: "medium",
        workSessionId: gate.workSessionId,
      });
    }
    default:
      return refuse("unrecognised", sentence, `I could not place "${sentence}".`);
  }
}
