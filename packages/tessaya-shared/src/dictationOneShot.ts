/**
 * What a whole dictation inserts once it has been tidied: the model's text, or, when the model failed or was refused,
 * the text tidied on this computer (what was heard, if there is none).
 */
export const settleOneShot = (
  raw: string,
  cleaned: { readonly text: string; readonly stage: string; readonly why?: string } | null,
): { readonly text: string; readonly failed: boolean; readonly why?: string } => {
  const local = cleaned !== null && cleaned.text.trim().length > 0 ? cleaned.text : null;
  const failed = local === null || cleaned?.stage === "fallback";
  return {
    text: local ?? raw,
    failed,
    ...(failed && cleaned?.why !== undefined ? { why: cleaned.why } : {}),
  };
};

/** The line he sees when the model's clean-up was not used, saying which of its three causes it was. */
export const cleanupFailedLine = (why: string | undefined): string => {
  const tail = "so it was tidied on this computer only";
  if (why === undefined) return `Clean-up failed, ${tail}`;
  if (/timed out/.test(why)) return `Clean-up took too long, ${tail}`;
  if (/^key\b|api \d|failed$/.test(why))
    return `Clean-up could not reach your API key (${why}), ${tail}`;
  return `Clean-up changed your words (${why}), ${tail}`;
};
