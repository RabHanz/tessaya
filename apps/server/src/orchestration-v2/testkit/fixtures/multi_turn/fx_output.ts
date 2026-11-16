import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";

const usage = { usageScope: "main_agent", usageStatus: "complete", hasSubagents: false } as const;

/** fx's PromptResponse.usage counts each prompt on its own. */
export function assertFxMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);
  assert.deepEqual(
    projectionFor(result, transcript.scenario).providerTurns.map((turn) => turn.turnTokenUsage),
    [
      { ...usage, inputTokens: 19550, outputTokens: 10 },
      { ...usage, inputTokens: 20022, outputTokens: 10 },
    ],
  );
}
