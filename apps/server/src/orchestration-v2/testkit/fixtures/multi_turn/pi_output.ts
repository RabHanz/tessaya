import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";
import { assertPiSettledTokenUsage } from "../simple/pi_output.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";

const usage = { usageScope: "main_agent", usageStatus: "complete", hasSubagents: false } as const;

export function assertPiMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);
  assertPiSettledTokenUsage(result, transcript);
  // Per-turn usage sums the turn's assistant message_end usage; input includes cache reads.
  assert.deepEqual(
    projectionFor(result, transcript.scenario).providerTurns.map((turn) => turn.turnTokenUsage),
    [
      {
        ...usage,
        inputTokens: 1787,
        outputTokens: 21,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 18,
      },
      {
        ...usage,
        inputTokens: 1819,
        outputTokens: 21,
        cachedInputTokens: 1792,
        cacheCreationTokens: 0,
        reasoningTokens: 19,
      },
    ],
  );
}
