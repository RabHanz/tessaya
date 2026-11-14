/**
 * The diagnostics file he can attach to a report (no upload, ever): version, platform, the
 * lifecycle log, timings and checks, and the settings, with everything private taken out first.
 * What he said and what came back never goes in. Pure, so what is removed is tested.
 */
const TOKENS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WIN_HOME = /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi;
const POSIX_HOME = /(\/(?:home|Users)\/)[^/\s"']+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export const redactText = (text: string): string => {
  let out = text;
  for (const re of TOKENS) out = out.replace(re, "<secret>");
  return out
    .replace(EMAIL, "<email>")
    .replace(WIN_HOME, "$1<user>")
    .replace(POSIX_HOME, "$1<user>")
    .replace(IPV4, "<ip>");
};

/** Fields that hold what he said or what Tessaya said back. */
const WORDS = new Set([
  "said",
  "reply",
  "raw",
  "cleaned",
  "text",
  "caption",
  "heard",
  "message",
  "content",
  "note",
  "prompt",
  "title",
  "detail",
]);
const PRIVATE_KEY =
  /token|secret|password|passwd|apikey|api_key|credential|cookie|auth|email|account/i;

const strip = (value: unknown, drop: (key: string) => boolean): unknown => {
  if (Array.isArray(value)) return value.map((v) => strip(v, drop));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = drop(k) ? "<removed>" : strip(v, drop);
    }
    return out;
  }
  return typeof value === "string" ? redactText(value) : value;
};

/** A log of one JSON object per line, without any of the words in it. A line that is not JSON is redacted text. */
export const scrubLog = (ndjson: string, maxLines = 400): string =>
  ndjson
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-maxLines)
    .map((line) => {
      try {
        return JSON.stringify(strip(JSON.parse(line), (k) => WORDS.has(k) || PRIVATE_KEY.test(k)));
      } catch {
        return redactText(line).slice(0, 400);
      }
    })
    .join("\n");

/** The settings file without anything that could identify or unlock. */
export const scrubSettings = (settings: unknown): string =>
  JSON.stringify(
    strip(settings, (k) => PRIVATE_KEY.test(k)),
    null,
    2,
  );

export interface Section {
  readonly title: string;
  readonly body: string;
}

export const MAX_SECTION = 120_000;

export const buildDiagnostics = (input: {
  readonly at: string;
  readonly sections: ReadonlyArray<Section>;
}): string =>
  [
    "Tessaya diagnostics",
    `Made ${input.at}. Made on this computer and never uploaded. It holds no dictated or spoken words, no tokens, no email addresses and no user names; read it before you send it.`,
    ...input.sections.map(
      (s) => `\n===== ${s.title} =====\n${redactText(s.body).slice(-MAX_SECTION)}`,
    ),
  ].join("\n");
