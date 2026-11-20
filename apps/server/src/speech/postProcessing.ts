import type { EnvironmentSpeechPostProcessingRequest, ModelSelection } from "@t3tools/contracts";
import {
  cleanDictation,
  rewriteMessage,
  rewriteSystemPrompt,
} from "@t3tools/tessaya-shared/dictationCleanup";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";
import { applySpeechAliases } from "./customWords.ts";
import { TessayaVocabulary } from "../tessaya/TessayaVocabulary.ts";
import { DictationCleanupApi } from "./DictationCleanupApi.ts";
import { SpeechOperationError } from "./SpeechService.ts";

export class SpeechPostProcessing extends Context.Service<
  SpeechPostProcessing,
  {
    readonly process: (
      input: EnvironmentSpeechPostProcessingRequest,
    ) => Effect.Effect<{ readonly text: string }, SpeechOperationError>;
  }
>()("t3/speech/postProcessing/SpeechPostProcessing") {}

/** On his Claude plan the clean-up is Sonnet, as on the desktop (the Director, 16 Nov); another provider stays as chosen. */
const onPlan = (selection: ModelSelection): ModelSelection =>
  selection.model.startsWith("claude-") ? { ...selection, model: "claude-sonnet-5-5" } : selection;

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const cleanupApi = yield* DictationCleanupApi;
  return SpeechPostProcessing.of({
    process: Effect.fn("SpeechPostProcessing.process")(
      function* (input) {
        if (input.transcript.trim().length === 0) return { text: input.transcript };
        const settings = yield* settingsService.getSettings;
        const { mode, customInstructions } = input.options.speechPostProcessingPrompt;
        // Providers run in a working directory; cleanup must not read a checkout.
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-cleanup-" });
        const modelSelection = resolveSpeechPostProcessingModelSelection(settings);
        const generate = (prompt: string, selection: ModelSelection) =>
          textGeneration
            .generateTranscriptionPostProcessing({ cwd, prompt, modelSelection: selection })
            .pipe(Effect.map((generated) => generated.transcription.trim()));
        const custom = mode === "custom" ? customInstructions.trim() : "";
        if (custom !== "") {
          const text = yield* generate(
            buildTranscriptionPostProcessingPrompt(
              custom,
              input.transcript,
              input.draft,
              input.options.speechCorrectionWord,
            ),
            modelSelection,
          );
          return {
            text:
              text.length > 0
                ? applySpeechAliases(text, input.options.speechCustomWords)
                : input.transcript,
          };
        }
        // The desktop's clean-up (prompt, checker, one retry), with his one dictionary as T3's list carries it.
        const dictionary = input.options.speechCustomWords.map((w) => ({
          phrase: w.term,
          replacement: null,
          heard: w.aliases,
        }));
        // shortcut: the desktop's Spelling choice stays on the desktop, so this is the British default; carry it as a
        // server setting when anyone picks another.
        const system = rewriteSystemPrompt(dictionary);
        const context = {
          before: input.draft.text.slice(0, Math.max(0, input.draft.selection.start)),
        };
        // His past dictations most like this one, from her brain's copy of his style pairs, as the desktop shows them.
        const vocabulary = yield* Effect.serviceOption(TessayaVocabulary);
        const examples = Option.isSome(vocabulary)
          ? yield* vocabulary.value.examples(input.transcript, "default")
          : [];
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        const cleaned = yield* Effect.promise(() =>
          cleanDictation({
            raw: input.transcript,
            mode: "default",
            level: "claude",
            dictionary,
            context,
            ask: (text, mode, refused) => {
              const message = rewriteMessage(text, mode, context, examples, refused);
              // His plan first, his key only when the plan fails (the desktop's route).
              return run(
                generate(`${system}\n\n${message}`, onPlan(modelSelection)).pipe(
                  Effect.filterOrFail((answer) => answer.length > 0),
                  Effect.catch(() =>
                    cleanupApi
                      .cleanup({
                        system,
                        message: rewriteMessage(text, mode, context, examples),
                        maxTokens: 64 + Math.ceil(text.length / 2),
                        refused,
                      })
                      .pipe(
                        Effect.flatMap((r) =>
                          r.configured ? Effect.succeed(r.text) : Effect.fail("no key"),
                        ),
                      ),
                  ),
                ),
              );
            },
          }),
        );
        if (cleaned.stage === "fallback")
          yield* Effect.logWarning("dictation clean-up fell back to the local text", {
            why: cleaned.why,
          });
        return { text: applySpeechAliases(cleaned.text, input.options.speechCustomWords) };
      },
      Effect.scoped,
      Effect.mapError((cause) => new SpeechOperationError({ operation: "post-processing", cause })),
    ),
  });
});

export const layer = Layer.effect(SpeechPostProcessing, make);
