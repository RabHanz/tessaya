/**
 * Changing the model and effort of a Claude Code session running in a terminal from T3's own composer picker (the
 * header menu is gone, P1). The session is told with its own `/model` and `/effort` in its Herdr pane, and the toast
 * says what the session itself answered, never what was only typed. A session not in Herdr offers to be brought in.
 */
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { accountForInstance, type BatonAccount } from "@t3tools/baton-contracts";
import { effortCommand, withRealEffort } from "@t3tools/baton-shared/liveModel";
import { liveSessionIdOf } from "@t3tools/baton-shared/liveThread";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderOptionSelection,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
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

const NO_POOL = Atom.make(AsyncResult.initial<never, never>(false));
const NO_STATE = Atom.make(AsyncResult.initial<never, never>(false));

const liveStateAtom = (threadRef: ScopedThreadRef | null) => {
  const sessionId = threadRef === null ? null : liveSessionIdOf(threadRef.threadId);
  return threadRef === null || sessionId === null
    ? NO_STATE
    : batonWorkSessions.liveStateQuery({
        environmentId: threadRef.environmentId,
        input: { sessionId },
      });
};

/** A terminal session's real effort and the change waiting for it to go idle, with a way to cancel that change. */
export function useLiveState(threadRef: ScopedThreadRef | null) {
  const atom = liveStateAtom(threadRef);
  const state = Option.getOrNull(AsyncResult.value(useAtomValue(atom)));
  const refresh = useAtomRefresh(atom);
  const cancelQueued = useAtomCommand(batonWorkSessions.liveCancelQueued, { reportFailure: false });
  const sessionId = threadRef === null ? null : liveSessionIdOf(threadRef.threadId);
  const cancel = () => {
    if (threadRef === null || sessionId === null) return;
    void cancelQueued({ environmentId: threadRef.environmentId, input: { sessionId } }).then(
      refresh,
    );
  };
  return { effort: state?.effort ?? null, queued: state?.queued ?? null, refresh, cancel };
}

/** The login each live session runs as, from the session catalog the header's binding reads (by session id). */
export const liveLoginAtom = Atom.family((_sessionId: string) => Atom.make<string | null>(null));

/**
 * The machine logins (cswap) on a live thread's environment, with `active` marking the session's own login once the
 * catalog has named it (a session in its own config dir can run on any of them); empty elsewhere.
 */
export function useLiveAccounts(threadRef: ScopedThreadRef | null): ReadonlyArray<BatonAccount> {
  const sessionId = threadRef === null ? null : liveSessionIdOf(threadRef.threadId);
  const pool = useAtomValue(
    threadRef !== null && sessionId !== null
      ? batonWorkSessions.accountPoolQuery({ environmentId: threadRef.environmentId, input: {} })
      : NO_POOL,
  );
  const login = useAtomValue(liveLoginAtom(sessionId ?? ""));
  const accounts = Option.getOrNull(AsyncResult.value(pool))?.accounts ?? [];
  return login === null
    ? accounts
    : accounts.map((account) => ({ ...account, active: account.email?.split("@")[0] === login }));
}

/** How an instance's login relates to the terminal session's: /model there, a live move, or not known. */
export const liveLoginOf = (
  instanceId: string,
  accounts: ReadonlyArray<BatonAccount>,
): { readonly relation: "same" | "other" | "unknown"; readonly key: string | null } => {
  const active = accounts.find((account) => account.active);
  const picked = accountForInstance(instanceId, accounts);
  if (active === undefined || picked === undefined) return { relation: "unknown", key: null };
  return { relation: picked.key === active.key ? "same" : "other", key: picked.key };
};

/** Moves a live session to another login while it runs; a session on the shared login offers its one restart. */
export function useLiveAccountSwitch(threadRef: ScopedThreadRef | null) {
  const sessionId = threadRef === null ? null : liveSessionIdOf(threadRef.threadId);
  const { refresh } = useLiveState(threadRef);
  const setAccount = useAtomCommand(batonWorkSessions.liveSetAccount, { reportFailure: false });
  const setLogin = useAtomSet(liveLoginAtom(sessionId ?? ""));
  const switchTo = (account: BatonAccount, restart = false): void => {
    if (threadRef === null || sessionId === null) return;
    const label = account.label;
    void setAccount({
      environmentId: threadRef.environmentId,
      input: { sessionId, accountKey: account.key, ...(restart ? { restart: true } : {}) },
    }).then((result) => {
      if (result._tag !== "Success") {
        toastManager.add({ type: "error", title: "Could not reach the session" });
        return;
      }
      const { state, detail } = result.value;
      if (result.value.queued === true) {
        refresh();
        toastManager.add({ type: "info", title: `${label} next`, description: detail });
      } else if (state === "switched" || state === "unchanged") {
        // The catalog the header polls catches up within 30 s; the label should not wait for it.
        setLogin(account.email?.split("@")[0] ?? null);
        toastManager.add({ type: "success", title: `On ${label}`, description: detail });
      } else if (state === "needs_restart")
        toastManager.add({
          type: "warning",
          title: "Make this thread switchable",
          description: detail,
          actionProps: {
            children: "Restart once and switch",
            onClick: () => switchTo(account, true),
          },
        });
      else
        toastManager.add({
          type: state === "busy" ? "warning" : "error",
          title: "Not switched",
          description: detail,
        });
    });
  };
  return switchTo;
}

/** Model and effort changes of a mirrored terminal session, applied inside that session (never a new one). */
export function useLiveSessionChange(threadRef: ScopedThreadRef | null) {
  const sessionId = threadRef === null ? null : liveSessionIdOf(threadRef.threadId);
  const setModel = useAtomCommand(batonWorkSessions.liveSetModel, { reportFailure: false });
  const adopt = useAtomCommand(batonWorkSessions.liveAdopt, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const environmentId: EnvironmentId | null = threadRef?.environmentId ?? null;
  const { refresh } = useLiveState(threadRef);

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
      if (result.value.queued === true) {
        refresh();
        toastManager.add({ type: "info", title: "Queued", description: detail });
      } else if (state === "applied") {
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
  const { effort } = useLiveState(threadRef);
  if (sessionId === null || traits === null || traits.threadRef === undefined) return traits;
  const { threadRef: target, draftId: _draftId, ...rest } = traits;
  const real = withRealEffort(traits.models, traits.modelOptions, effort);
  return {
    ...rest,
    models: real.models,
    modelOptions: real.options,
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
  const setMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
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
    // On the thread itself, so the choice holds on every device, not only in this composer's draft.
    const set = await setMetadata({
      environmentId: thread.environmentId,
      input: { threadId: targetThreadId, modelSelection: selection, providerChangeApproved: true },
    });
    if (set._tag !== "Success")
      useComposerDraftStore.getState().setModelSelection(target, selection, { explicit: true });
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };
}
