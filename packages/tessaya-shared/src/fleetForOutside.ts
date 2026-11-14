/**
 * The fleet as an outside agent or a linked environment reads it (GEN-6): what is live and its state, never what was
 * said. No synopsis, no pane's blocked prompt, no folders, no account names; a walled project's work shows only its project's name.
 */
import type { BatonFleet, BatonProjectRef } from "@t3tools/tessaya-contracts";

import { isWalled, type OsPack } from "./osPack.ts";

export const fleetForOutside = (
  fleet: BatonFleet,
  pack: OsPack,
  projectTitle: (projectId: string) => string | null,
  /** For a linked server of his: each entry's project and account, which it cannot resolve itself; accounts are kept. */
  linked?: {
    readonly project: (projectId: string) => BatonProjectRef | null;
    readonly account: (entry: BatonFleet["entries"][number]) => string | null;
  },
): BatonFleet => {
  const walled = (project: string | null | undefined) => project != null && isWalled(pack, project);
  const refLabel = (ref: BatonProjectRef | undefined) => ref?.label ?? null;
  return {
    ...fleet,
    entries: fleet.entries.map((entry) => {
      const project = projectTitle(entry.projectId);
      const hidden = walled(project);
      return {
        ...entry,
        title: hidden && project !== null ? project : entry.title,
        synopsis: null,
        ...(linked === undefined
          ? {}
          : (() => {
              const ref = linked.project(entry.projectId);
              return { ...(ref === null ? {} : { project: ref }), account: linked.account(entry) };
            })()),
        threads: entry.threads.map((thread) => ({
          ...thread,
          title: hidden && project !== null ? project : thread.title,
          worktreePath: null,
          branch: hidden ? null : thread.branch,
        })),
        adopted: entry.adopted.map((adopted) => ({
          ...adopted,
          label: hidden && project !== null ? project : adopted.label,
        })),
      };
    }),
    ...(fleet.herdr === undefined
      ? {}
      : {
          herdr: fleet.herdr.map((pane) => {
            const project = refLabel(pane.project);
            const { blockedPrompt: _said, cwd: _folder, foreground: _shown, ...rest } = pane;
            return walled(project) && project !== null ? { ...rest, label: project } : rest;
          }),
        }),
    ...(fleet.claudeSessions === undefined
      ? {}
      : {
          claudeSessions: fleet.claudeSessions.map((session) => {
            const project = refLabel(session.project);
            const { configDir: _home, ...rest } = session;
            return {
              ...rest,
              cwd: project ?? "-",
              name: walled(project) ? project : session.name,
              account: linked === undefined ? null : session.account,
            };
          }),
        }),
  };
};
