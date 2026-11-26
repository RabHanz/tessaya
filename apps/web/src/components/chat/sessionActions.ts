import { msg } from "gt-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";

import { getClientSettings } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { readProjects } from "../../state/entities";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { toastManager } from "../ui/toast";
import { m } from "~/i18n/messages";

/**
 * Ends the thread's agent session so the next message starts a fresh one (new skills, plugins, MCP), then
 * refreshes the provider for the thread's folder. The command palette and the `thread.restartSession` command share it.
 */
export async function restartAgentSession(input: {
  readonly thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "runtime" | "modelSelection" | "worktreePath"
  >;
  readonly project: Pick<EnvironmentProject, "workspaceRoot"> | undefined;
  readonly stopThreadSession: (value: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly refreshProviders: (value: {
    environmentId: EnvironmentId;
    input: { instanceId: ProviderInstanceId; cwd: string; fresh: true };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<void> {
  const { thread, project } = input;
  const { environmentId } = thread;
  if (thread.runtime !== null) {
    const stopped = await input.stopThreadSession({
      environmentId,
      input: { threadId: thread.id },
    });
    if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
  }
  toastManager.add({
    type: "success",
    title: m(msg("Agent session will restart")),
    description: m(msg("Your next message restarts the agent. This conversation is kept.")),
  });
  if (!project) return;
  const refreshed = await input.refreshProviders({
    environmentId,
    input: {
      instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
      cwd: thread.worktreePath ?? project.workspaceRoot,
      fresh: true,
    },
  });
  if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
}

/** The sidebar's project group holding this project, read now, for commands that act on the current project. */
export function readProjectGroupOf(ref: ScopedProjectRef) {
  return (
    buildSidebarProjectSnapshots({
      projects: readProjects(),
      groupScratchProjects: true,
      settings: selectProjectGroupingSettings(getClientSettings()),
      primaryEnvironmentId: readPrimaryEnvironmentId(),
      resolveEnvironmentLabel: () => null,
    }).find((group) =>
      group.memberProjects.some(
        (member) => member.environmentId === ref.environmentId && member.id === ref.projectId,
      ),
    ) ?? null
  );
}
