import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type EnvironmentSpeechPostProcessingRequest,
  type ModelSelection,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { ServerSettingsService } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { DictationCleanupApi } from "./DictationCleanupApi.ts";
import { layer, SpeechPostProcessing } from "./postProcessing.ts";

const HAIKU: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};

const SAID = "um so we should run the whole thing on kegle tonight and check it";
const ANSWER = "So we should run the whole thing on Kaggle tonight and check it.";

const request = (
  transcript: string,
  mode: "default" | "custom" = "default",
): EnvironmentSpeechPostProcessingRequest => ({
  transcript,
  draft: { text: "", selection: { start: 0, end: 0 } },
  options: {
    speechCustomWords: [{ term: "Kaggle", aliases: ["Kegle"] }],
    speechPostProcessingPrompt: { mode, customInstructions: mode === "custom" ? "Shout it." : "" },
  },
});

const run = (
  input: EnvironmentSpeechPostProcessingRequest,
  plan: (prompt: string, selection: ModelSelection) => Effect.Effect<string, TextGenerationError>,
  key: { readonly system: string; readonly message: string }[] = [],
) =>
  Effect.flatMap(SpeechPostProcessing, (s) => s.process(input)).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({
              dictationCleanup: { enabled: true, engine: "t3", model: HAIKU, updatedAt: 1 },
            }),
            Layer.mock(TextGeneration.TextGeneration)({
              generateTranscriptionPostProcessing: (args) =>
                Effect.map(plan(args.prompt, args.modelSelection), (transcription) => ({
                  transcription,
                })),
            }),
            Layer.mock(DictationCleanupApi)({
              cleanup: (args) => {
                key.push(args);
                return Effect.succeed({ configured: true, text: ANSWER, ms: 1 });
              },
            }),
            NodeServices.layer,
          ),
        ),
      ),
    ),
  );

it.effect("web and phone clean-up runs the desktop's: Sonnet on his plan, then his key", () =>
  Effect.gen(function* () {
    const asked: Array<{ prompt: string; model: string }> = [];
    const onPlan = yield* run(request(SAID), (prompt, selection) => {
      asked.push({ prompt, model: selection.model });
      return Effect.succeed(ANSWER);
    });
    expect(onPlan.text).toBe(ANSWER);
    expect(asked[0]?.model).toBe("claude-sonnet-5-5");
    // The shared prompt with his dictionary and British spelling, not T3's built-in one.
    expect(asked[0]?.prompt).toContain("Spelling: British English");
    expect(asked[0]?.prompt).toContain("Kaggle");
    expect(asked[0]?.prompt).toContain("<dictation>");

    const key: { system: string; message: string }[] = [];
    const viaKey = yield* run(
      request(SAID),
      () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateTranscriptionPostProcessing",
            detail: "limit",
          }),
        ),
      key,
    );
    expect(viaKey.text).toBe(ANSWER);
    expect(key[0]?.system).toContain("Spelling: British English");

    // His own instructions keep T3's prompt and his chosen model.
    const custom: Array<{ prompt: string; model: string }> = [];
    yield* run(request("hello", "custom"), (prompt, selection) => {
      custom.push({ prompt, model: selection.model });
      return Effect.succeed("HELLO");
    });
    expect(custom[0]?.model).toBe("claude-haiku-5-5");
    expect(custom[0]?.prompt).toContain("Shout it.");
  }),
);
