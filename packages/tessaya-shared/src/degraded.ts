/**
 * What works when something is missing (offline / degraded mode): a plain table from a few probes.
 * The probes are facts the desktop already has or can check in a moment; nothing here talks to the
 * network. "unknown" is shown as unknown, never as working.
 */
export type Probe = boolean | null;

export interface Probes {
  /** Can this computer reach the internet right now. */
  readonly network: Probe;
  /** His Claude is installed and signed in on this computer. */
  readonly claude: Probe;
  /** The local speech model is downloaded and loaded. */
  readonly speechModel: Probe;
  /** The T3 server this window talks to answers. */
  readonly server: Probe;
}

export type CapState = "works" | "limited" | "off" | "unknown";

export interface Capability {
  readonly name: string;
  readonly state: CapState;
  readonly why: string;
}

const needs = (
  name: string,
  required: ReadonlyArray<readonly [Probe, string]>,
  okWhy: string,
): Capability => {
  const missing = required.filter(([p]) => p === false).map(([, label]) => label);
  if (missing.length > 0)
    return {
      name,
      state: "off",
      why: `Needs ${missing.join(" and ")}, which ${missing.length > 1 ? "are" : "is"} not available.`,
    };
  const unknown = required.filter(([p]) => p === null).map(([, label]) => label);
  if (unknown.length > 0)
    return { name, state: "unknown", why: `Not checked yet: ${unknown.join(", ")}.` };
  return { name, state: "works", why: okWhy };
};

export const capabilities = (p: Probes): ReadonlyArray<Capability> => [
  needs(
    "Wake word and hold-key dictation",
    [[p.speechModel, "the speech model"]],
    "Runs on this computer; nothing leaves it.",
  ),
  needs("Dictation with light tidy-up", [[p.speechModel, "the speech model"]], "Local rules only."),
  needs(
    "Dictation with medium tidy-up",
    [
      [p.speechModel, "the speech model"],
      [p.claude, "your Claude"],
      [p.network, "the internet"],
    ],
    "Your own Claude fixes what rules cannot. Without it the text is tidied lightly.",
  ),
  needs(
    "Transforms and Command mode",
    [
      [p.claude, "your Claude"],
      [p.network, "the internet"],
    ],
    "Rewrites go to your own Claude.",
  ),
  needs(
    "Answers from the assistant",
    [
      [p.claude, "your Claude"],
      [p.network, "the internet"],
    ],
    "One assistant, your subscription.",
  ),
  needs(
    "Sessions, approvals and jobs on this computer",
    [[p.server, "the T3 server"]],
    "Read from the server on this computer.",
  ),
  needs(
    "Sessions on other machines",
    [
      [p.server, "the T3 server"],
      [p.network, "the internet or your network"],
    ],
    "Through each machine's own server.",
  ),
  needs(
    "Ledger, deadlines and build failures",
    [[p.network, "the internet"]],
    "Read through gh; the last answer is kept for five minutes.",
  ),
  needs("Updates", [[p.network, "the internet"]], "From the releases page."),
  {
    name: "Snippets, Scratchpad, commitments, vault, Insights, History",
    state: "works",
    why: "All kept on this computer.",
  },
  {
    name: "Transcribing a file",
    state: p.speechModel === false ? "off" : p.speechModel === null ? "unknown" : "works",
    why:
      p.speechModel === false
        ? "Needs the speech model."
        : "Local; WAV as it is, other formats with ffmpeg.",
  },
];

/** One sentence for the top of the table. */
export const degradedSummary = (caps: ReadonlyArray<Capability>): string => {
  const off = caps.filter((c) => c.state === "off").length;
  return off === 0
    ? "Everything checked is available."
    : `${off} of ${caps.length} things are unavailable right now; the rest work.`;
};
