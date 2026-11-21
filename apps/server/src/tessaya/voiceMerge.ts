/**
 * Two copies of one member's voice profile joined into one (21 Nov: the brain held 9 samples, the laptop's server 61).
 * Nothing is dropped: the centroids are weighted by their samples and renormalised, the samples and sources add up.
 * Pure.
 */
import type { TessayaVoiceProfile } from "@t3tools/tessaya-contracts";
import { unitOrNull } from "@t3tools/tessaya-voice/speaker";
import { vectorFromBase64, vectorToBase64 } from "@t3tools/tessaya-voice/speakerStore";

/** The joined profile, or null when they can't be joined (another model, a broken vector): the brain's copy stands. */
export const mergeVoiceProfiles = (
  mine: TessayaVoiceProfile,
  theirs: TessayaVoiceProfile,
): TessayaVoiceProfile | null => {
  if (mine.model !== theirs.model) return null;
  if (mine.centroid === theirs.centroid) return mine;
  const a = vectorFromBase64(mine.centroid);
  const b = vectorFromBase64(theirs.centroid);
  if (a === null || b === null || a.length !== b.length || unitOrNull(b) === null) return null;
  const sum = a.map((x, i) => x * mine.samples + b[i]! * theirs.samples);
  const centroid = unitOrNull(sum);
  if (centroid === null) return null;
  return {
    ...mine,
    centroid: vectorToBase64(centroid),
    samples: mine.samples + theirs.samples,
    sources: [...new Set([...mine.sources, ...theirs.sources])],
    enrolledAt: mine.enrolledAt < theirs.enrolledAt ? mine.enrolledAt : theirs.enrolledAt,
    version: mine.version + 1,
  };
};
