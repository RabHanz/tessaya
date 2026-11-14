/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * One entry per project across every box and account (D72), for the sidebar and the server's session list.
 *
 * Inputs are each environment's fleet as it already arrives; nothing here asks a
 * server anything. A row's key is the thing that survives what the Director
 * does to a session: a Claude conversation id survives an account rotation
 * (D69, same id resumed) and adoption into Herdr (D74, same id); a work session
 * id survives "Continue with…" (D62, new thread, same work). So the row stays
 * where it was, and only its attributes change.
 */
import type {
  AdoptedSessionCandidate,
  BatonSessionSummary,
  BatonFleetEntry,
  BatonProjectRef,
  ClaudeLiveSession,
  EnvironmentId,
  ProjectId,
} from "@t3tools/tessaya-contracts";

export interface EnvironmentLive {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly entries: ReadonlyArray<BatonFleetEntry>;
  readonly herdr: ReadonlyArray<AdoptedSessionCandidate>;
  readonly claude: ReadonlyArray<ClaudeLiveSession>;
}

export type BatonSessionRow =
  | {
      readonly kind: "work";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly box: string;
      readonly title: string;
      readonly state: string;
      readonly urgent: boolean;
      readonly updatedAt: string | null;
      readonly entry: BatonFleetEntry;
    }
  | {
      readonly kind: "claude";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly box: string;
      readonly title: string;
      readonly state: string;
      readonly urgent: boolean;
      readonly updatedAt: string | null;
      readonly account: string | null;
      readonly where: string;
      /** Herdr pane ref when typing is possible; null for a terminal or VS Code session. */
      readonly pane: string | null;
      readonly sessionId: string;
      readonly prompt: string | null;
    }
  | {
      readonly kind: "pane";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly box: string;
      readonly title: string;
      readonly state: string;
      readonly urgent: boolean;
      readonly updatedAt: string | null;
      readonly pane: string;
      readonly prompt: string | null;
    };

export interface BatonProjectGroup {
  readonly key: string;
  readonly label: string;
  readonly rows: ReadonlyArray<BatonSessionRow>;
  readonly boxes: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<string>;
  readonly urgent: boolean;
}

const leaf = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;
const folderRef = (cwd: string): BatonProjectRef => ({
  key: `dir:${leaf(cwd).toLowerCase()}`,
  label: leaf(cwd),
});

export function buildBatonProjects(input: {
  readonly environments: ReadonlyArray<EnvironmentLive>;
  readonly resolveWorkProject: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => BatonProjectRef | null;
}): ReadonlyArray<BatonProjectGroup> {
  const groups = new Map<string, { label: string; rows: BatonSessionRow[] }>();
  const add = (project: BatonProjectRef, row: BatonSessionRow) => {
    const group = groups.get(project.key) ?? { label: project.label, rows: [] };
    group.rows.push(row);
    groups.set(project.key, group);
  };

  for (const env of input.environments) {
    for (const entry of env.entries) {
      const project = input.resolveWorkProject(env.environmentId, entry.projectId) ??
        entry.project ?? {
          key: `t3:${env.environmentId}:${entry.projectId}`,
          label: entry.title,
        };
      add(project, {
        kind: "work",
        key: `work:${env.environmentId}:${entry.workSessionId}`,
        environmentId: env.environmentId,
        box: env.environmentLabel,
        title: entry.title,
        state: entry.state,
        urgent: entry.needsUser,
        updatedAt: entry.updatedAt,
        entry,
      });
    }
    const hosted = new Set<string>();
    for (const session of env.claude) {
      if (session.herdrPane !== null) hosted.add(session.herdrPane);
      const pane = env.herdr.find((c) => c.location.pane === session.herdrPane) ?? null;
      const blocked = pane?.state === "needs_input";
      add(session.project ?? folderRef(session.cwd), {
        kind: "claude",
        key: `claude:${session.sessionId}`,
        environmentId: env.environmentId,
        box: env.environmentLabel,
        title: session.name ?? leaf(session.cwd),
        state: blocked ? "blocked" : (session.status ?? "running"),
        urgent: blocked,
        updatedAt: session.updatedAt,
        account: session.account,
        where: session.herdrPane !== null ? "Herdr" : (session.entrypoint ?? "terminal"),
        pane: session.herdrPane,
        sessionId: session.sessionId,
        prompt: pane?.blockedPrompt ?? null,
      });
    }
    for (const candidate of env.herdr) {
      if (hosted.has(candidate.location.pane)) continue;
      const project =
        candidate.project ??
        (candidate.cwd == null
          ? folderRef(candidate.location.workspace)
          : folderRef(candidate.cwd));
      add(project, {
        kind: "pane",
        key: `pane:${env.environmentId}:${candidate.location.pane}`,
        environmentId: env.environmentId,
        box: env.environmentLabel,
        title: candidate.label,
        state:
          candidate.state === "needs_input"
            ? "blocked"
            : (candidate.state ?? candidate.runtimeState),
        urgent: candidate.state === "needs_input",
        updatedAt: null,
        pane: candidate.location.pane,
        prompt: candidate.blockedPrompt ?? null,
      });
    }
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      rows: group.rows.toSorted(
        (a, b) => Number(b.urgent) - Number(a.urgent) || a.key.localeCompare(b.key),
      ),
      boxes: [...new Set(group.rows.map((row) => row.box))],
      accounts: [
        ...new Set(
          group.rows.flatMap((row) =>
            row.kind === "claude" && row.account !== null ? [row.account] : [],
          ),
        ),
      ],
      urgent: group.rows.some((row) => row.urgent),
    }))
    .toSorted((a, b) => Number(b.urgent) - Number(a.urgent) || a.label.localeCompare(b.label));
}

/** Whether the session in this pane is waiting on a question or an approval now: keys typed there would answer it. */
export const paneWaiting = (
  groups: ReadonlyArray<BatonProjectGroup>,
  environmentId: string,
  pane: string,
): boolean =>
  groups.some((group) =>
    group.rows.some(
      (row) =>
        row.kind !== "work" &&
        row.environmentId === environmentId &&
        row.pane === pane &&
        row.urgent,
    ),
  );

/** The account a work session runs under: its live thread's provider instance, by the name a person gave it. */
export const workAccount = (
  entry: BatonFleetEntry,
  labelOf: (providerInstanceId: string) => string | null | undefined,
): string | null => {
  const instance = entry.threads.find(
    (thread) => thread.threadId === entry.activeThreadId,
  )?.providerInstanceId;
  return (instance == null ? null : labelOf(instance)?.trim()) || null;
};

// The states from Baton's ladder, Claude Code and Herdr that need him, and those that are busy.
const WAITING: ReadonlySet<string> = new Set(["needs_approval", "blocked", "needs_input"]);
const WORKING: ReadonlySet<string> = new Set(["working", "running", "busy", "starting"]);

/**
 * Every live session as Baton's own window lists it. The same rows the sidebar shows; Baton's
 * window cannot have a second source of sessions to disagree with it.
 */
export function batonSessionSummaries(
  groups: ReadonlyArray<BatonProjectGroup>,
  resolveAccount: (row: BatonSessionRow) => string | null,
): ReadonlyArray<BatonSessionSummary> {
  return groups.flatMap((group) =>
    group.rows.map((row): BatonSessionSummary => {
      const threadId =
        row.kind === "work"
          ? (row.entry.activeThreadId ?? row.entry.threads[0]?.threadId ?? null)
          : null;
      return {
        key: row.key,
        project: group.label,
        session: row.title,
        account: resolveAccount(row),
        state:
          row.urgent || WAITING.has(row.state)
            ? "waiting"
            : WORKING.has(row.state)
              ? "working"
              : "idle",
        urgent: row.urgent,
        box: row.box,
        updatedAt: row.updatedAt,
        thread: threadId === null ? null : { environmentId: row.environmentId, threadId },
        pane:
          row.kind === "work" || row.pane === null
            ? null
            : { environmentId: row.environmentId, pane: row.pane },
      };
    }),
  );
}
