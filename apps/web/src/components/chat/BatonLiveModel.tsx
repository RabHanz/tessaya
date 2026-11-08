/**
 * Changing the model and effort of a Claude Code session running in a terminal from T3's own composer picker (the
 * header menu is gone, P1). The session is told with its own `/model` and `/effort` in its Herdr pane, and the toast
 * says what the session itself answered, never what was only typed. A session not in Herdr offers to be brought in.
 */
import { effortCommand } from "@t3tools/baton-shared/liveModel";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderOptionSelection,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { newThreadId } from "~/lib/utils";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";
import type { TraitsSelectionInput } from "./TraitsPicker";

// baton-live4: is the current namespace; the older ones were retired but the id shape is the same.
export const liveSessionIdOf = (threadId: string): string | null =>
  /^baton-live\d*:/.test(threadId) ? threadId.replace(/^baton-live\d*:/, "") : null;

/** Model and effort changes of a mirrored terminal session, applied inside that session (never a new one). */
export function useLiveSessionChange(threadRef: ScopedThreadRef | null) {
  const sessionId = threadRef === null ? null : liveSessionIdOf(threadRef.threadId);
  const setModel = useAtomCommand(batonWorkSessions.liveSetModel, { reportFailure: false });
  const adopt = useAtomCommand(batonWorkSessions.liveAdopt, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const environmentId: EnvironmentId | null = threadRef?.environmentId ?? null;

  const apply = (wanted: { model?: string; effort?: string }, onApplied?: () => void) => {
    if (environmentId === null || sessionId === null) return;
    setBusy(true);
    void setModel({ environmentId, input: { sessionId, ...wanted } }).then((result) => {
      setBusy(false);
      if (result._tag !== "Success") {
        toastManager.add({ type: "error", title: "Could not reach the session" });
        return;
      }
      const { state, detail, confirmed } = result.value;
      if (state === "applied") {
        onApplied?.();
        toastManager.add({
          type: "success",
          title: "The session confirmed it",
          description: confirmed.join(" "),
        });
      } else if (state === "not_in_herdr") {
        toastManager.add({
          type: "warning",
          title: "This session is not in Herdr",
          description: detail,
          actionProps: {
            children: "Bring it in",
            onClick: () => {
              void adopt({ environmentId, input: { sessionId: sessionId } }).then((adopted) => {
                if (adopted._tag === "Success" && adopted.value.adopted) apply(wanted);
                else {
                  toastManager.add({
                    type: "error",
                    title: "Could not bring it into Herdr",
                    description:
                      adopted._tag === "Success" ? adopted.value.detail : "It did not answer.",
                  });
                }
              });
            },
          },
        });
      } else {
        toastManager.add({
          type: state === "busy" ? "warning" : "error",
          title: state === "busy" ? "It is working" : "Not changed",
          description: detail,
        });
      }
    });
  };
  return { sessionId, busy, apply };
}

/**
 * On a live thread, T3's own effort control applies inside the session at once, with the session's answer as a toast,
 * and only a confirmed pick is kept on the thread. Model picks go the same way through useComposerSelection.
 */
export function useLiveTraits(
  threadRef: ScopedThreadRef | null,
  traits: TraitsSelectionInput | null,
): TraitsSelectionInput | null {
  const { sessionId, busy, apply } = useLiveSessionChange(threadRef);
  if (sessionId === null || traits === null || traits.threadRef === undefined) return traits;
  const { threadRef: target, draftId: _draftId, ...rest } = traits;
  return {
    ...rest,
    onModelOptionsChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
      const effort = options?.find((option) => option.id === "effort")?.value;
      // One change at a time, as the header menu was; the thread keeps a confirmed pick so the label is not stale.
      if (busy || typeof effort !== "string" || effortCommand(effort) === null) return;
      apply({ effort }, () =>
        useComposerDraftStore.getState().setProviderModelOptions(target, traits.provider, options, {
          ...(traits.instanceId ? { instanceId: traits.instanceId } : {}),
          model: traits.model,
          persistSticky: true,
        }),
      );
    },
  };
}

/**
 * "Continue in <provider>" from a live thread: T3's own fork of the conversation into a new thread on that model, so
 * its first send hands the context over (T3's provider switch). The terminal session and its thread stay as they are.
 */
export function useContinueInNewThread() {
  const fork = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const navigate = useNavigate();
  return async (
    thread: EnvironmentThreadShell,
    selection: ModelSelection,
    providerName: string,
  ) => {
    const runId = thread.latestRun?.runId;
    if (runId === undefined) {
      toastManager.add({
        type: "info",
        title: "Nothing to continue yet",
        description: "Send a message in the session first.",
      });
      return;
    }
    const targetThreadId = newThreadId();
    const result = await fork({
      environmentId: thread.environmentId,
      input: {
        sourceThreadId: thread.id,
        targetThreadId,
        runId,
        title: `${thread.title} (${providerName})`,
      },
    });
    const target = scopeThreadRef(thread.environmentId, targetThreadId);
    if (result._tag !== "Success" || !(await waitForThreadShell(target))) {
      toastManager.add({ type: "error", title: `Could not continue in ${providerName}` });
      return;
    }
    useComposerDraftStore.getState().setModelSelection(target, selection, { explicit: true });
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };
}
