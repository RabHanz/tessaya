import { detectSecret, REDACTED } from "@t3tools/tessaya-shared/memory";

/** What a dictation or spoken turn may keep in History: itself, or a mark when it looks like a secret. */
export const redactForHistory = (
  raw: string,
  cleaned: string | null,
): { readonly raw: string; readonly cleaned: string | null; readonly secret: string | null } => {
  const secret = detectSecret(raw) ?? (cleaned === null ? null : detectSecret(cleaned));
  return secret === null
    ? { raw, cleaned, secret: null }
    : { raw: REDACTED, cleaned: cleaned === null ? null : REDACTED, secret };
};
