import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type { ProviderTextGeneration } from "./textGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildReviewGuidePrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

export const TranscriptionPostProcessingOutput = Schema.Struct({ transcription: Schema.String });

export type Operation = keyof ProviderTextGeneration;

export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Investigate cwd with read-only tools across turns; fail if the runner cannot guarantee read-only access. */
  readonly investigate?:
    | {
        readonly timeoutMs: number;
        /** cwd holds the content under review; paths the user configured resolve here instead. */
        readonly projectCwd: string;
      }
    | undefined;
}

const INVESTIGATION_TIMEOUT_MS = 15 * 60_000;

export const investigationUnsupported = (operation: Operation, provider: string) =>
  new TextGenerationError({
    operation,
    detail: `${provider} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set.`,
  });

export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

export const withoutInvestigation =
  (provider: string, run: Runner): Runner =>
  (request) =>
    request.investigate
      ? Effect.fail(investigationUnsupported(request.operation, provider))
      : run(request);

/** One generation's tokens; `input` is the uncached part. `model` when the reply names the one that ran. */
export interface Tokens {
  readonly model?: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

/** Where a driver hands back what its call used; the caller that records usage provides it. */
export const UsageSink = Context.Reference<((tokens: ReadonlyArray<Tokens>) => void) | undefined>(
  "@t3tools/provider-core/textGenerationOperations/UsageSink",
  { defaultValue: () => undefined },
);

export const reportUsage = Effect.fn("TextGenerationOperations.reportUsage")(function* (
  tokens: ReadonlyArray<Tokens>,
) {
  (yield* UsageSink)?.(tokens);
});

const nonNegative = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** An ACP PromptResponse's `usage`: its input counts the cache, except Gemini's, which also leaves thoughts out of output. */
export const acpTokens = (
  usage:
    | {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cachedReadTokens?: number | null | undefined;
        readonly cachedWriteTokens?: number | null | undefined;
        readonly thoughtTokens?: number | null | undefined;
      }
    | null
    | undefined,
  gemini = false,
): ReadonlyArray<Tokens> => {
  if (usage == null) return [];
  const cacheRead = nonNegative(usage.cachedReadTokens);
  const cacheWrite = nonNegative(usage.cachedWriteTokens);
  const input = nonNegative(usage.inputTokens);
  return [
    {
      input: gemini ? input : Math.max(0, input - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      output: nonNegative(usage.outputTokens) + (gemini ? nonNegative(usage.thoughtTokens) : 0),
    },
  ];
};

export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

export const generatedThreadTitle = (raw: string) => {
  const title = sanitizeThreadTitle(raw);
  // Some models echo the output schema's key instead of a title.
  return title.toLowerCase() === "title"
    ? Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: 'The model returned the placeholder title "title".',
        }),
      )
    : Effect.succeed(title);
};

export function fromRunner(name: string, run: Runner): ProviderTextGeneration {
  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    `${name}.generateCommitMessage`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      }),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    `${name}.generatePrContent`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generatePrContent",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
        threadContext: input.threadContext,
        producedBy: input.producedBy,
      }),
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    `${name}.generateBranchName`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBranchName",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      }),
    });
    return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
  });

  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    `${name}.generateThreadTitle`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildThreadTitlePrompt({
        message: input.message,
        projectTitle: input.projectTitle,
        previousTitle: input.previousTitle,
        forkSource: input.forkSource,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
        instructions: input.instructions,
      }),
    });
    return {
      title: yield* generatedThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    };
  });

  const generateTranscriptionPostProcessing: ProviderTextGeneration["generateTranscriptionPostProcessing"] =
    Effect.fn(`${name}.generateTranscriptionPostProcessing`)(function* (input) {
      return yield* run({
        operation: "generateTranscriptionPostProcessing",
        cwd: input.cwd,
        prompt: input.prompt,
        outputSchema: TranscriptionPostProcessingOutput,
        modelSelection: input.modelSelection,
      });
    });

  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = Effect.fn(
    `${name}.generateReviewGuide`,
  )(function* (input) {
    return yield* run({
      operation: "generateReviewGuide",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      investigate: { timeoutMs: INVESTIGATION_TIMEOUT_MS, projectCwd: input.projectCwd },
      ...buildReviewGuidePrompt(input),
    });
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
    generateTranscriptionPostProcessing,
  } satisfies ProviderTextGeneration;
}
