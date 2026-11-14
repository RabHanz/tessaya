/**
 * Answers Tessaya's own window (its Sessions tab and the voice core) from this window: open a thread, type to a
 * pane, the session catalog, and "show live sessions". Renders nothing; it was part of the Projects block, which
 * the one-list decision (P5) removed.
 */
import {
  batonDesktopBridge,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type TessayaProjectRef,
} from "@t3tools/tessaya-contracts";
import { buildTessayaProjects, paneWaiting } from "@t3tools/tessaya-shared/tessayaProjects";
import { answerCatalogRequest } from "@t3tools/tessaya-shared/catalogRequests";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { tessayaWorkSessions, useTessayaFleets } from "../../state/tessayaWorkSessions";
import { waitForThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";

/** The section can render twice; one answers Tessaya's window. */
let sessionListenerClaimed = false;

export function TessayaSessionRequests(props: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly resolveWorkProject: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => TessayaProjectRef | null;
  readonly onOpenThreadById: (environmentId: EnvironmentId, threadId: string) => void;
  readonly onShowLive: () => void;
}): null {
  const fleets = useTessayaFleets(props.environmentIds);
  const groupsOf = (current: typeof fleets, p: typeof props) =>
    buildTessayaProjects({
      environments: current.flatMap(({ environmentId, fleet }) =>
        fleet === null
          ? []
          : [
              {
                environmentId,
                environmentLabel: p.resolveEnvironmentLabel(environmentId) ?? environmentId,
                entries: fleet.entries,
                herdr: fleet.herdr ?? [],
                claude: fleet.claudeSessions ?? [],
              },
            ],
      ),
      resolveWorkProject: p.resolveWorkProject,
    });

  const sendToPane = useAtomCommand(tessayaWorkSessions.herdrSend, { reportFailure: false });
  const catalogList = useAtomCommand(tessayaWorkSessions.sessionsList, { reportFailure: false });
  const catalogResume = useAtomCommand(tessayaWorkSessions.sessionsResume, {
    reportFailure: false,
  });
  const catalogReattach = useAtomCommand(tessayaWorkSessions.sessionsReattach, {
    reportFailure: false,
  });
  const catalogCreate = useAtomCommand(tessayaWorkSessions.sessionsCreate, {
    reportFailure: false,
  });
  const catalogAutoResume = useAtomCommand(tessayaWorkSessions.sessionsAutoResume, {
    reportFailure: false,
  });
  const catalogCleanup = useAtomCommand(tessayaWorkSessions.sessionsCleanup, {
    reportFailure: false,
  });
  const catalogFolders = useAtomCommand(tessayaWorkSessions.sessionsFolders, {
    reportFailure: false,
  });
  const catalogWaiting = useAtomCommand(tessayaWorkSessions.sessionsWaiting, {
    reportFailure: false,
  });
  const localEnvironmentId = usePrimaryEnvironmentId();
  const catalogDeps = useRef({
    localEnvironmentId: localEnvironmentId as string | null,
    commands: {
      list: catalogList,
      resume: catalogResume,
      reattach: catalogReattach,
      create: catalogCreate,
      folders: catalogFolders,
      cleanup: catalogCleanup,
      autoResume: catalogAutoResume,
      waiting: catalogWaiting,
    },
    environmentIds: props.environmentIds as ReadonlyArray<string>,
    label: (id: string) => props.resolveEnvironmentLabel(id as EnvironmentId) ?? id,
  });
  const navigate = useNavigate();
  const answerWindow = useRef({
    navigate,
    open: props.onOpenThreadById,
    send: sendToPane,
    showLive: props.onShowLive,
  });
  // Built only when a send needs it: which pane is waiting on a question.
  const latest = useRef({ fleets, props });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shell's handler on the latest callbacks
  useEffect(() => {
    answerWindow.current = {
      navigate,
      open: props.onOpenThreadById,
      send: sendToPane,
      showLive: props.onShowLive,
    };
    latest.current = { fleets, props };
    catalogDeps.current = {
      localEnvironmentId: localEnvironmentId as string | null,
      commands: {
        list: catalogList,
        resume: catalogResume,
        reattach: catalogReattach,
        create: catalogCreate,
        folders: catalogFolders,
        cleanup: catalogCleanup,
        autoResume: catalogAutoResume,
        waiting: catalogWaiting,
      },
      environmentIds: props.environmentIds as ReadonlyArray<string>,
      label: (id: string) => props.resolveEnvironmentLabel(id as EnvironmentId) ?? id,
    };
  });
  // Baton's window asks this sidebar to open a thread or type to a pane: the same handlers a click uses.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop shell outside React
  useEffect(() => {
    const subscribe = batonDesktopBridge()?.onBatonSessionRequest;
    if (subscribe === undefined || sessionListenerClaimed) return;
    sessionListenerClaimed = true;
    const unsubscribe = subscribe(async (request) => {
      const catalog = await answerCatalogRequest(request, catalogDeps.current as never);
      if (catalog !== null) return catalog;
      if (request.kind === "navigate") {
        // Tessaya's search opens one of T3's own pages; only those, never an outside address.
        if (!/^\/(settings|tessaya)\/[a-z-]+$/.test(request.path))
          return { ok: false, detail: "Not a T3 page." };
        void answerWindow.current.navigate({ to: request.path as never });
        return { ok: true, detail: "Opened." };
      }
      if (request.kind !== "open" && request.kind !== "send" && request.kind !== "showLive")
        return { ok: false, detail: "Not understood." };
      if (request.kind === "open") {
        // An imported thread reaches the client a moment after the server made it: open it only once it is there.
        const known = await waitForThreadShell(
          scopeThreadRef(request.environmentId as EnvironmentId, request.threadId as ThreadId),
          20_000,
        );
        if (!known)
          return {
            ok: false,
            detail: "The conversation was imported but T3 does not show it yet. Try Open again.",
          };
        answerWindow.current.open(request.environmentId as EnvironmentId, request.threadId);
        return { ok: true, detail: "Opened." };
      }
      if (request.kind === "showLive") {
        answerWindow.current.showLive();
        return { ok: true, detail: "Showing live sessions." };
      }
      // Read from this window's live fleets: Tessaya's list can be seconds old, and keys typed at a question answer it.
      if (
        paneWaiting(
          groupsOf(latest.current.fleets, latest.current.props),
          request.environmentId,
          request.pane,
        )
      )
        return {
          ok: false,
          detail:
            "That session is waiting on a question or an approval in its terminal, so nothing was sent. Answer it there first, then send again.",
        };
      const result = await answerWindow.current.send({
        environmentId: request.environmentId as EnvironmentId,
        input: { pane: request.pane, text: request.text },
      });
      return result._tag === "Success" && result.value.delivered
        ? { ok: true, detail: "Sent." }
        : { ok: false, detail: result._tag === "Success" ? result.value.detail : "Not sent." };
    });
    return () => {
      unsubscribe();
      sessionListenerClaimed = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- subscribes once; the latest fleets come through refs
  }, []);
  return null;
}
