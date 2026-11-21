import { VOICE_ID_GATE_DEFAULTS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextVoiceIdGate, voiceLearningLines } from "./voiceIdGate.ts";

describe("Voice ID's gate", () => {
  it("keeps the last Forget through a switch change, and keeps the switches through a Forget", () => {
    const forgot = nextVoiceIdGate(VOICE_ID_GATE_DEFAULTS, { forgetLearning: true }, 100);
    expect(forgot).toEqual({ ...VOICE_ID_GATE_DEFAULTS, forgetLearningAt: 100 });
    const changed = nextVoiceIdGate(
      forgot,
      { gate: { respondToOthers: true, forgetLearningAt: 1 } },
      200,
    );
    expect(changed).toEqual({ ...forgot, respondToOthers: true, forgetLearningAt: 100 });
  });

  it("reads learning from before the last Forget as none yet", () => {
    const tumble = { device: "tumble", roomSamples: 3, farClips: 4, farAt: 50, forgotAt: null };
    expect(voiceLearningLines([tumble], 60, () => "then")[0]?.detail).toBe("None yet");
    expect(voiceLearningLines([tumble], 40, () => "then")[0]?.detail).toBe(
      "4 far samples, last added then",
    );
  });
});
