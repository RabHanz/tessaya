/**
 * "Run on": which machine a job's worker runs on. The job flow always ran on the server the window is paired with; with more
 * than one server connected (this computer and others) he can name where. Pure: it picks a connected server by its
 * label and says plainly when the name matches none, or the server is not connected.
 */

export interface RunTarget {
  readonly id: string;
  readonly label: string;
}

const HERE = new Set([
  "",
  "here",
  "this computer",
  "this machine",
  "local",
  "this one",
  "my computer",
]);

export type RunOnChoice =
  | { readonly ok: true; readonly id: string; readonly label: string }
  | { readonly ok: false; readonly why: string };

export const resolveRunOn = (
  wanted: string,
  targets: ReadonlyArray<RunTarget>,
  primaryId: string,
): RunOnChoice => {
  const name = wanted.trim().toLowerCase();
  const primary = targets.find((t) => t.id === primaryId);
  if (HERE.has(name)) return { ok: true, id: primaryId, label: primary?.label ?? "this computer" };
  const hit =
    targets.find((t) => t.label.trim().toLowerCase() === name) ??
    targets.find((t) => t.label.toLowerCase().startsWith(name));
  if (hit !== undefined) return { ok: true, id: hit.id, label: hit.label };
  const names = targets.map((t) => t.label).join(", ");
  return {
    ok: false,
    why: `"${wanted.trim()}" is not connected. Connected: ${names === "" ? "none" : names}. Say "this computer" to run it here.`,
  };
};

/** Where a job asked about by id lives: where it was started, else the primary server. */
export const homeOf = (
  jobId: string,
  homes: ReadonlyMap<string, string>,
  primaryId: string,
): string => homes.get(jobId) ?? primaryId;
