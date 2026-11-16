import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";

const usage = { usageScope: "main_agent", usageStatus: "complete", hasSubagents: false } as const;

/** Grok reports per-prompt usage on its turn_completed notification. */
export function assertGrokMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);
  assert.deepEqual(
    projectionFor(result, transcript.scenario).providerTurns.map((turn) => turn.turnTokenUsage),
    [
      {
        ...usage,
        inputTokens: 22168,
        outputTokens: 36,
        cachedInputTokens: 1664,
        cacheCreationTokens: 0,
        reasoningTokens: 32,
      },
      {
        ...usage,
        inputTokens: 22548,
        outputTokens: 19,
        cachedInputTokens: 1152,
        cacheCreationTokens: 0,
        reasoningTokens: 15,
      },
    ],
  );
}
