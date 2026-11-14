/** What a whole dictation inserts once it has been tidied: the tidy text, or what was heard if tidying failed. */
export const CLEANUP_FAILED_LINE = "Clean-up failed, inserted what I heard";

export const settleOneShot = (
  raw: string,
  cleaned: { readonly text: string; readonly stage: string } | null,
): { readonly text: string; readonly failed: boolean } => {
  const failed =
    cleaned === null || cleaned.stage === "fallback" || cleaned.text.trim().length === 0;
  return { text: failed ? raw : cleaned.text, failed };
};
