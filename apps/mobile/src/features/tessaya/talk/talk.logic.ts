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

/** Why her brain turned an ask away at once (`{ ok: false, line }`: no desktop to take it; "" when it gave no reason), or null when it was taken. */
export const askRefused = (opened: unknown): string | null => {
  if (typeof opened !== "object" || opened === null || !("ok" in opened) || opened.ok !== false)
    return null;
  return "line" in opened && typeof opened.line === "string" ? opened.line.trim() : "";
};

/** Where a body model is kept on the phone after its first load: one file per model address, so a new one is fetched. */
export const bodyCacheName = (url: string): string =>
  `tessaya-body-${url
    .replace(/^[a-z]+:\/\/[^/]+/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(-120)}.vrm`;
