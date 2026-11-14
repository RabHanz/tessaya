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

/** The project by the name he said, and the worker he named (`worker`), else the first ready Claude. */
export const placeJob = <P extends PlacementProject>(
  wanted: string,
  projects: ReadonlyArray<P>,
  providers: ReadonlyArray<ServerProvider>,
  worker?: string,
): Placement<{ readonly project: P; readonly label: string; readonly worker: Worker }> => {
  const name = wanted.trim().toLowerCase();
  const project = projects.find(
    (entry) =>
      tessayaProjectKey(entry).label.toLowerCase() === name || entry.title.toLowerCase() === name,
  );
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
