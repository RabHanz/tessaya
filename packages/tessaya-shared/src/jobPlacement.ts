/**
 * Where a job runs, from his words (GEN-6): the project he named and the worker that takes it. The server
 * places a job this way, so the desktop, the phone and an agent all start one the same, with T3's window closed.
 */
import type { ServerProvider } from "@t3tools/contracts";

export interface PlacementProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?:
    | {
        readonly canonicalKey: string;
        readonly name?: string | null | undefined;
        readonly displayName?: string | null | undefined;
      }
    | null
    | undefined;
}

/** D72: a project's key is its repository's canonical key, else its folder name. */
export function tessayaProjectKey(project: PlacementProject): { key: string; label: string } {
  const identity = project.repositoryIdentity;
  if (identity != null) {
    return {
      key: identity.canonicalKey,
      label: identity.name ?? identity.displayName ?? project.title,
    };
  }
  const leaf = project.workspaceRoot.split("/").filter(Boolean).pop() ?? project.title;
  return { key: `dir:${leaf.toLowerCase()}`, label: leaf };
}

export interface Worker {
  readonly instanceId: string;
  readonly label: string;
  readonly driver: string;
  readonly model: string;
}

/** Instances that can take work now, each on its default model, as the model picker would offer them. */
export const readyWorkers = (providers: ReadonlyArray<ServerProvider>): ReadonlyArray<Worker> =>
  providers.flatMap((provider) => {
    if (!provider.enabled || provider.availability === "unavailable" || provider.status !== "ready")
      return [];
    const model = provider.models.find((entry) => entry.isDefault === true) ?? provider.models[0];
    return model === undefined
      ? []
      : [
          {
            instanceId: provider.instanceId,
            label: provider.displayName ?? provider.instanceId,
            driver: provider.driver,
            model: model.slug,
          },
        ];
  });

export type Placement<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly why: string };

/** A spoken or typed project name as words: case, punctuation, separators, a leading "the", a trailing "project". */
const spoken = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[-_./]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/ (project|repo|app)$/, "");

/** a and b differ by at most one insertion, deletion or substitution. Pure. */
const oneEditApart = (a: string, b: string): boolean => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};

/**
 * The project he means by a name said aloud: exact words first, then the same letters run together, then one slip
 * (a typo or a mishearing, for names of four letters or more). Two that fit equally are both returned, so she asks.
 */
export const projectsNamed = <P extends PlacementProject>(
  wanted: string,
  projects: ReadonlyArray<P>,
): ReadonlyArray<P> => {
  const names = (p: P) =>
    [tessayaProjectKey(p).label, p.title, p.workspaceRoot.split("/").filter(Boolean).pop() ?? ""]
      .map(spoken)
      .filter((n) => n !== "");
  const said = spoken(wanted);
  const tight = said.replace(/ /g, "");
  const passes: ReadonlyArray<(n: string) => boolean> = [
    (n) => n === said,
    (n) => n.replace(/ /g, "") === tight,
    (n) => tight.length >= 4 && oneEditApart(n.replace(/ /g, ""), tight),
  ];
  for (const fits of passes) {
    const found = projects.filter((p) => names(p).some(fits));
    if (found.length > 0) return found;
  }
  return [];
};

/** The project by the name he said, and the worker he named (`worker`), else the first ready Claude. */
export const placeJob = <P extends PlacementProject>(
  wanted: string,
  projects: ReadonlyArray<P>,
  providers: ReadonlyArray<ServerProvider>,
  worker?: string,
): Placement<{ readonly project: P; readonly label: string; readonly worker: Worker }> => {
  const found = projectsNamed(wanted, projects);
  if (found.length > 1)
    return {
      ok: false,
      why: `"${wanted}" could be ${found.map((entry) => tessayaProjectKey(entry).label).join(" or ")}. Ask him which.`,
    };
  const project = found[0];
  if (project === undefined) {
    const known = projects.map((entry) => tessayaProjectKey(entry).label).join(", ");
    return { ok: false, why: `No project is called "${wanted}". Projects: ${known}.` };
  }
  const label = tessayaProjectKey(project).label;
  if (worker !== undefined && worker.trim() !== "") {
    const named = handoffTarget(worker, providers);
    return named.ok ? { ok: true, value: { project, label, worker: named.value } } : named;
  }
  const claude = readyWorkers(providers).find((entry) => entry.driver === "claudeAgent");
  if (claude === undefined)
    return { ok: false, why: "No signed-in Claude is ready to be the worker." };
  return { ok: true, value: { project, label, worker: claude } };
};

/** The worker he named, by instance id, name or kind ("codex", "claude"): the first ready one that fits. */
export const handoffTarget = (
  wanted: string,
  providers: ReadonlyArray<ServerProvider>,
): Placement<Worker> => {
  const name = wanted.trim().toLowerCase();
  const workers = readyWorkers(providers);
  const target =
    workers.find(
      (entry) => entry.instanceId.toLowerCase() === name || entry.label.toLowerCase() === name,
    ) ?? workers.find((entry) => name !== "" && entry.driver.toLowerCase().startsWith(name));
  return target === undefined
    ? {
        ok: false,
        why: `No worker is called "${wanted}". Ready: ${workers.map((entry) => entry.label).join(", ") || "none"}.`,
      }
    : { ok: true, value: target };
};
