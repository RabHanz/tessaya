import type { TessayaPersona } from "@t3tools/tessaya-contracts";

/** The persona the Talk tab answers as: the one he picked if it is still on the team, else the lead. */
export const talkPersona = (
  personas: ReadonlyArray<TessayaPersona>,
  picked: string | null,
): TessayaPersona | null =>
  personas.find((p) => p.id === picked && p.private !== true) ??
  personas.find((p) => p.lead) ??
  personas[0] ??
  null;

/** What one poll of his ask says to show: still thinking, her answer, or why it could not be answered. */
export const askOutcome = (
  reply: { readonly status?: string; readonly line?: string } | null,
): { readonly done: boolean; readonly line: string } => {
  if (reply === null) return { done: true, line: "That was lost. Say it again." };
  const line = reply.line ?? "";
  return reply.status === "answered" || reply.status === "failed" || reply.status === "expired"
    ? { done: true, line }
    : { done: false, line };
};

/** Base64 of a model's bytes, in chunks, so a 20 MB body never builds one giant argument list. */
export const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
