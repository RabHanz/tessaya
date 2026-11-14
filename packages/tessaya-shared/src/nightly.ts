/**
 * The nightly self-check's one status file: which checks ran on which build, and what the Now page says about the last run.
 * Pure; the workflow builds the file, the desktop reads it. It creates no issue and sends no notification.
 */

export type CheckResult = "pass" | "fail" | "skipped";
export type NightlyRef = "main" | "release";

export interface NightlyCheck {
  readonly name: string;
  readonly ref: NightlyRef;
  readonly result: CheckResult;
}

export interface NightlyStatus {
  readonly generatedAt: string;
  readonly runUrl: string;
  /** The commit of main and the release tag the checks ran on (null: no release yet). */
  readonly versions: { readonly main: string; readonly release: string | null };
  readonly checks: ReadonlyArray<NightlyCheck>;
}

/** A job's outcome from GitHub's `needs` context: success, failure, cancelled or skipped. */
export const resultOf = (outcome: string | undefined): CheckResult =>
  outcome === "success"
    ? "pass"
    : outcome === "skipped" || outcome === undefined
      ? "skipped"
      : "fail";

export const buildNightly = (input: {
  readonly now: string;
  readonly runUrl: string;
  readonly main: string;
  readonly release: string | null;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly ref: NightlyRef;
    readonly outcome: string | undefined;
  }>;
}): NightlyStatus => ({
  generatedAt: input.now,
  runUrl: input.runUrl,
  versions: { main: input.main, release: input.release },
  checks: input.checks.map((c) => ({ name: c.name, ref: c.ref, result: resultOf(c.outcome) })),
});

const RESULTS = new Set(["pass", "fail", "skipped"]);

/** The file as read from the status branch; null if it is not a status file. */
export const parseNightly = (text: string): NightlyStatus | null => {
  try {
    const v = JSON.parse(text) as Partial<NightlyStatus>;
    if (
      typeof v.generatedAt !== "string" ||
      Number.isNaN(Date.parse(v.generatedAt)) ||
      typeof v.versions?.main !== "string" ||
      !Array.isArray(v.checks) ||
      !v.checks.every(
        (c) =>
          typeof c?.name === "string" &&
          (c.ref === "main" || c.ref === "release") &&
          RESULTS.has(c.result),
      )
    ) {
      return null;
    }
    return v as NightlyStatus;
  } catch {
    return null;
  }
};

const ago = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000);
  return h < 1 ? "less than an hour ago" : h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
};

/** One row for "What works right now". Unknown when there is no file, and stale after two days. */
export const nightlyRow = (
  status: NightlyStatus | null,
  now: number,
): {
  readonly name: string;
  readonly state: "works" | "limited" | "unknown";
  readonly why: string;
} => {
  const name = "Nightly self-check";
  if (status === null)
    return {
      name,
      state: "unknown",
      why: "Unknown: the last nightly result could not be read here (it needs the GitHub command line, signed in).",
    };
  const age = now - Date.parse(status.generatedAt);
  const ran = status.checks.filter((c) => c.result !== "skipped");
  const failed = ran.filter((c) => c.result === "fail");
  const when = ago(age);
  if (failed.length > 0) {
    const list = failed
      .map(
        (c) =>
          `${c.name} on ${c.ref === "main" ? "main" : (status.versions.release ?? "the release")}`,
      )
      .join(", ");
    return {
      name,
      state: "limited",
      why: `${failed.length} of ${ran.length} checks failed ${when}: ${list}.`,
    };
  }
  if (age > 2 * 86_400_000)
    return {
      name,
      state: "limited",
      why: `The last nightly ran ${when}; it should run every night.`,
    };
  return { name, state: "works", why: `All ${ran.length} checks passed ${when}.` };
};

/** `upstream-sync.json` as the nightly sync writes it (scripts/tessaya/sync-status.mjs). */
export interface SyncStatus {
  readonly at: string;
  readonly result: string;
  readonly ok: boolean;
  readonly behindCommits: number | null;
  readonly conflictingFiles: ReadonlyArray<string>;
  readonly touching?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export const parseSync = (text: string): SyncStatus | null => {
  try {
    const v = JSON.parse(text) as Partial<SyncStatus>;
    return typeof v.at === "string" &&
      typeof v.result === "string" &&
      Array.isArray(v.conflictingFiles)
      ? (v as SyncStatus)
      : null;
  } catch {
    return null;
  }
};

/** The sync debt, in commits and in words: how far behind upstream, and why if the last run stopped. */
export const syncRow = (
  status: SyncStatus | null,
  now: number,
): {
  readonly name: string;
  readonly state: "works" | "limited" | "unknown";
  readonly why: string;
} => {
  const name = "Upstream sync";
  if (status === null)
    return { name, state: "unknown", why: "Unknown: the last sync result could not be read here." };
  const behind =
    status.behindCommits === null ? "an unknown number of" : String(status.behindCommits);
  const when = ago(now - Date.parse(status.at));
  if (status.result === "conflict") {
    const files = status.conflictingFiles.slice(0, 4).join(", ");
    return {
      name,
      state: "limited",
      why: `${behind} commits behind upstream. The last run (${when}) stopped on a conflict in ${files === "" ? "the patch series" : files}.`,
    };
  }
  if (!status.ok)
    return {
      name,
      state: "limited",
      why: `${behind} commits behind upstream. The last run (${when}) ended: ${status.result}.`,
    };
  return {
    name,
    state: "works",
    why: `${behind} commits behind upstream as of ${when}; the last run: ${status.result}.`,
  };
};
