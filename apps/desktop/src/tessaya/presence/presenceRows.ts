/** The Presence group of the settings (D149): clear switches, none behind "More options". */
import type { HomeControl } from "../home/tessayaHome.ts";

export interface PresenceSettings {
  readonly awarenessWindow: boolean;
  readonly awarenessIdle: boolean;
  readonly awarenessFocus: boolean;
  readonly awarenessJobs: boolean;
  readonly initiativeMode: "off" | "written" | "spoken";
  readonly initiativePerHour: number;
  readonly needsRepos: ReadonlyArray<string>;
  readonly ciRepos: ReadonlyArray<string>;
  readonly needsDeadlinesFile: string | null;
  readonly needsFeeds: ReadonlyArray<string>;
  readonly needsExpect: ReadonlyArray<string>;
}

const AWARE = "Presence: what I may know right now";
const SPEAK = "Presence: speaking up";
const WATCH = "Presence: what I watch";

export const PER_HOUR = [1, 3, 5, 10] as const;

export const presenceControls = (s: PresenceSettings): ReadonlyArray<HomeControl> => [
  {
    id: "pr.awWindow",
    section: AWARE,
    label: "Know which app and window you are in",
    hint: "Off until you turn it on. Windows of password managers, banking and private browsing are replaced with 'a private window'. Only the last 30 minutes are held, in memory, never saved. Never what you type or copy.",
    kind: "toggle",
    on: s.awarenessWindow,
  },
  {
    id: "pr.awIdle",
    section: AWARE,
    label: "Know when you are away from the keyboard",
    hint: "Only how long it has been since you last used the keyboard or mouse.",
    kind: "toggle",
    on: s.awarenessIdle,
  },
  {
    id: "pr.awFocus",
    section: AWARE,
    label: "Know which session you have focused",
    kind: "toggle",
    on: s.awarenessFocus,
  },
  {
    id: "pr.awJobs",
    section: AWARE,
    label: "Know which jobs are running",
    kind: "toggle",
    on: s.awarenessJobs,
  },
  {
    id: "pr.initiative",
    section: SPEAK,
    label: "Offer to look when something needs a look",
    hint: "A failed or silent session, a failed build on a repository you list, a commitment that is due. It asks first: Yes, Later or Never. It never acts on its own. Uses your quiet hours.",
    kind: "choice",
    value: s.initiativeMode,
    options: [
      { value: "off", label: "Off" },
      { value: "written", label: "A card" },
      { value: "spoken", label: "A card and one spoken line" },
    ],
  },
  {
    id: "pr.perHour",
    section: SPEAK,
    label: "At most this many offers an hour",
    kind: "choice",
    value: String(s.initiativePerHour),
    options: PER_HOUR.map((n) => ({ value: String(n), label: String(n) })),
  },
  {
    id: "pr.needsRepos",
    section: WATCH,
    label: "Ledgers to read for 'what needs me'",
    hint: "Repositories whose open issues labelled ledger:money-blocker or ledger:blocked-on-director count. Read-only, through gh.",
    kind: "list",
    items: s.needsRepos,
    placeholder: "owner/repository",
  },
  {
    id: "pr.ciRepos",
    section: WATCH,
    label: "Repositories whose failed builds I should raise",
    hint: "The newest run of each workflow, read-only, through gh.",
    kind: "list",
    items: s.ciRepos,
    placeholder: "owner/repository",
  },
  {
    id: "pr.feeds",
    section: WATCH,
    label: "Status files other systems write",
    hint: 'A JSON file { "source", "asOf", "items": [{ "id", "title", "why", "weight", "due" }] } read for "what needs me": approvals from a dashboard, a peer project\'s status. Read-only; a file older than a day is not trusted.',
    kind: "list",
    items: s.needsFeeds,
    placeholder: "Full path to a status file",
  },
  {
    id: "pr.expect",
    section: WATCH,
    label: "Sources I expect an answer from",
    hint: "Name a source (for example Cockpit approvals). If no readable status file carries that name, the answer says it is not connected rather than leaving it out.",
    kind: "list",
    items: s.needsExpect,
    placeholder: "Name of a source",
  },
  {
    id: "pr.deadlines",
    section: WATCH,
    label: "Deadlines file",
    hint: "A JSON file with a rows list, each with an id, what and due (YYYY-MM-DD). Adding a path replaces the current one.",
    kind: "list",
    items: s.needsDeadlinesFile === null ? [] : [s.needsDeadlinesFile],
    placeholder: "Full path to the file",
    addLabel: "Set",
  },
];

export const REPO_MAX = 20;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** "https://github.com/o/r" or "o/r.git" are accepted and reduced to "o/r". */
export const parseRepo = (text: string): string | null => {
  const clean = text
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return REPO.test(clean) ? clean : null;
};

const listPatch = (
  current: ReadonlyArray<string>,
  op: "add" | "rm",
  value: string,
): ReadonlyArray<string> | null => {
  if (op === "rm") return current.filter((x) => x !== value);
  const repo = parseRepo(value);
  if (repo === null || current.length >= REPO_MAX) return null;
  return current.includes(repo) ? current : [...current, repo];
};

/** The settings patch a Presence control means, or null for an id or value that is not one. */
export const presencePatch = (
  id: string,
  value: string | boolean | null,
  current: PresenceSettings,
): Partial<PresenceSettings> | null => {
  const on = value === true;
  const free = /^pr\.(feeds|expect):(add|rm)$/.exec(id);
  if (free !== null) {
    if (typeof value !== "string" || value.trim() === "" || value.length > 500) return null;
    const key = free[1] === "feeds" ? "needsFeeds" : "needsExpect";
    const clean = value.trim();
    const now = current[key];
    if (free[2] === "rm") return { [key]: now.filter((x) => x !== clean) };
    return now.includes(clean) || now.length >= 20 ? null : { [key]: [...now, clean] };
  }
  const list = /^pr\.(needsRepos|ciRepos|deadlines):(add|rm)$/.exec(id);
  if (list !== null) {
    if (typeof value !== "string" || value === "" || value.length > 500) return null;
    const op = list[2] as "add" | "rm";
    if (list[1] === "deadlines") {
      return op === "rm" ? { needsDeadlinesFile: null } : { needsDeadlinesFile: value.trim() };
    }
    const key = list[1] === "needsRepos" ? "needsRepos" : "ciRepos";
    const next = listPatch(current[key], op, value);
    return next === null ? null : { [key]: next };
  }
  switch (id) {
    case "pr.awWindow":
      return { awarenessWindow: on };
    case "pr.awIdle":
      return { awarenessIdle: on };
    case "pr.awFocus":
      return { awarenessFocus: on };
    case "pr.awJobs":
      return { awarenessJobs: on };
    case "pr.initiative":
      return value === "off" || value === "written" || value === "spoken"
        ? { initiativeMode: value }
        : null;
    case "pr.perHour": {
      const n = Number(value);
      return (PER_HOUR as ReadonlyArray<number>).includes(n) ? { initiativePerHour: n } : null;
    }
    default:
      return null;
  }
};
