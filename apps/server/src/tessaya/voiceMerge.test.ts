import type { TessayaVoiceProfile } from "@t3tools/tessaya-contracts";
import { vectorFromBase64, vectorToBase64 } from "@t3tools/tessaya-voice/speakerStore";
import { describe, expect, it } from "vite-plus/test";

import { mergeVoiceProfiles } from "./voiceMerge.ts";

const profile = (
  over: Partial<TessayaVoiceProfile>,
  v: ReadonlyArray<number>,
): TessayaVoiceProfile => ({
  id: "owner",
  name: "Owner",
  kind: "owner",
  model: "campplus-voxceleb-357a834f",
  centroid: vectorToBase64(new Float32Array(v)),
  samples: 1,
  sources: ["spoken"],
  enrolledAt: "2026-11-14T14:53:49.149Z",
  version: 1,
  updatedAt: "2026-11-14T14:53:49.276Z",
  ...over,
});

describe("mergeVoiceProfiles", () => {
  it("joins the brain's 9 samples and the laptop's 61 by weight, keeping every sample and source", () => {
    const brain = profile({ samples: 9 }, [1, 0]);
    const laptop = profile(
      { samples: 61, sources: ["wispr", "spoken"], enrolledAt: "2026-11-12T03:48:46.679Z" },
      [0, 1],
    );
    const joined = mergeVoiceProfiles(brain, laptop)!;
    const [x, y] = vectorFromBase64(joined.centroid)!;
    expect(Math.hypot(x!, y!)).toBeCloseTo(1, 5);
    expect(y! / x!).toBeCloseTo(61 / 9, 4);
    expect(joined).toMatchObject({
      samples: 70,
      sources: ["spoken", "wispr"],
      enrolledAt: "2026-11-12T03:48:46.679Z",
      version: 2,
    });
  });

  it("keeps the brain's copy for the same centroid, and refuses another model or a broken vector", () => {
    const brain = profile({ samples: 9 }, [1, 0]);
    expect(mergeVoiceProfiles(brain, { ...brain, samples: 9 })).toBe(brain);
    expect(mergeVoiceProfiles(brain, profile({ model: "ecapa" }, [0, 1]))).toBeNull();
    expect(mergeVoiceProfiles(brain, profile({}, [0, 0]))).toBeNull();
    expect(mergeVoiceProfiles(brain, profile({}, [1, 0, 0]))).toBeNull();
  });
});
