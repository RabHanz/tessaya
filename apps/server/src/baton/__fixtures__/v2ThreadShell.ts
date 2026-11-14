/** A v2 thread shell for Baton's tests, shaped like upstream's own client-runtime fixture. */
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/tessaya-contracts";
import * as DateTime from "effect/DateTime";

export const at = (iso: string) => DateTime.makeUnsafe(iso);

export function v2Shell(
  overrides: Partial<OrchestrationV2ThreadShell> & { readonly id?: ThreadId } = {},
): OrchestrationV2ThreadShell {
  const id = overrides.id ?? ThreadId.make("thread-1");
  const instanceId = ProviderInstanceId.make("claude-a");
  return {
    id,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "sonnet" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at("2026-09-18T05:00:00.000Z"),
    updatedAt: at("2026-09-18T05:00:30.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  } as OrchestrationV2ThreadShell;
}

/** A run that finished at 05:00:30 and that nobody has looked at: `done_unseen`. */
export const finishedShell = (id?: ThreadId) =>
  v2Shell({
    ...(id === undefined ? {} : { id }),
    status: "completed",
    latestRunId: RunId.make("run-1"),
    latestRunCompletedAt: at("2026-09-18T05:00:30.000Z"),
  });

/** Mid-run: `working`. */
export const workingShell = (id?: ThreadId) =>
  v2Shell({
    ...(id === undefined ? {} : { id }),
    status: "running",
    latestRunId: RunId.make("run-2"),
    activeRunId: RunId.make("run-2"),
  });
