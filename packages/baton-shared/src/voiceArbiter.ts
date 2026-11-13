/**
 * One responder per utterance (R1-P7), the rules alone: which of several vessels that heard him at once answers.
 * Pure, so the room loop's replay, the server and the tests judge the same way.
 */
import type { VoiceClaimInput } from "@t3tools/baton-contracts";

export type VoiceClaim = VoiceClaimInput;

/** The window after the first claim in which others still count. */
export const CLAIM_WINDOW_MS = 250;
/** A device he spoke to this recently keeps the conversation. */
export const RECENT_MS = 120_000;
/** Losers stay quiet this long after her reply ends. */
export const QUIET_AFTER_MS = 2_000;

export const pickResponder = (
  claims: ReadonlyArray<VoiceClaim>,
  context: {
    readonly primary: string | null;
    /** When each device last answered him. */
    readonly lastAnswered: ReadonlyMap<string, number>;
    readonly now: number;
  },
): VoiceClaim | null => {
  if (claims.length === 0) return null;
  const here = claims.find((c) => c.answerHere === true);
  if (here !== undefined) return here;
  const primary = claims.find((c) => c.deviceId === context.primary);
  if (primary !== undefined) return primary;
  const recent = claims
    .map((c) => ({ c, at: context.lastAnswered.get(c.deviceId) ?? -Infinity }))
    .filter((x) => context.now - x.at <= RECENT_MS)
    .toSorted((a, b) => b.at - a.at)[0];
  if (recent !== undefined) return recent.c;
  return claims.toSorted(
    (a, b) =>
      (b.loudnessDb ?? -Infinity) - (a.loudnessDb ?? -Infinity) ||
      b.wakeScore - a.wakeScore ||
      a.deviceId.localeCompare(b.deviceId),
  )[0]!;
};
