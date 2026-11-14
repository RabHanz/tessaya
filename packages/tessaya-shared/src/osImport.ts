/**
 * Turning a user's own operating-system document into the pack files (D148). The model call happens in
 * the import script with the user's own Claude login; this is the prompt and the check of what comes
 * back, so nothing odd is written to disk. The document itself is never stored here.
 */
export interface DistilledPack {
  readonly executive: string;
  readonly roles: Readonly<Record<string, string>>;
}

export const DISTIL_DOCUMENT_MAX = 200_000;

export const distilPrompt = (document: string): string =>
  `Below is a person's own operating system for how they think and decide. Distil it for an assistant that plans and delegates their work. Reply with one JSON object and nothing else:
{"executive": "...", "roles": {"name": "..."}}
"executive" is how the top agent frames and decides a job, as short numbered rules in the person's own terms (at most 6000 characters). "roles" has one brief per specialist the document describes (at most 8, lowercase names of letters, digits and hyphens), each giving the persona, the tools, what to remember, the limits and when to report back (at most 1500 characters each). Keep their words and their order of priority. Add nothing they did not say.

The document:
${document.slice(0, DISTIL_DOCUMENT_MAX)}`;

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const parseDistilled = (
  reply: string,
):
  | { readonly ok: true; readonly pack: DistilledPack }
  | { readonly ok: false; readonly why: string } => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, why: "The reply had no JSON in it." };
  let value: unknown;
  try {
    value = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return { ok: false, why: "The reply was not valid JSON." };
  }
  const object = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const executive = typeof object["executive"] === "string" ? object["executive"].trim() : "";
  if (executive.length < 40 || executive.length > 6_000) {
    return { ok: false, why: "The executive framing was missing or the wrong length." };
  }
  const given = (
    typeof object["roles"] === "object" && object["roles"] !== null ? object["roles"] : {}
  ) as Record<string, unknown>;
  const roles: Record<string, string> = {};
  for (const [name, brief] of Object.entries(given).slice(0, 8)) {
    if (
      NAME.test(name) &&
      typeof brief === "string" &&
      brief.trim() !== "" &&
      brief.length <= 1_500
    ) {
      roles[name] = brief.trim();
    }
  }
  return { ok: true, pack: { executive, roles } };
};
