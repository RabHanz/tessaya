/**
 * A thread's Tessaya header parts (TessayaThreadHeader), and on a live thread its session status: whether the terminal
 * session runs (TessayaLiveBinding), a reply the safety classifier stopped, and the way back when a handoff session
 * answers it.
 */
import { ProviderInstanceId, type ModelSelection, type ScopedThreadRef } from "@t3tools/contracts";

import {
  classifierStopReason,
  isLiveThreadId,
  LIVE_INSTANCE,
  liveSessionIdOf,
  movedIntoTessaya,
} from "@t3tools/tessaya-shared/liveThread";
import { useAtomValue } from "@effect/atom-react";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import { Button } from "../ui/button";
import { TessayaLiveBinding } from "./TessayaLiveBinding";
import { livePaneAtom } from "./TessayaLiveModel";
import { TessayaThreadHeader } from "./TessayaThreadHeader";

export function TessayaLiveStatus({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(threadRef);
  const live = isLiveThreadId(threadRef.threadId);
  const items = useThreadVisibleTurnItems(live ? threadRef : null);
  const projection = useQuietThreadProjection(live ? threadRef : null)?.projection ?? null;
  const activeNativeId =
    projection?.providerThreads.find((p) => p.id === projection.thread.activeProviderThreadId)
      ?.nativeThreadRef?.nativeId ?? null;
  // The session it is on now: a main session restarted under a new id stays on this thread.
  const sessionId =
    shell?.providerInstanceId === LIVE_INSTANCE && activeNativeId !== null
      ? activeNativeId
      : liveSessionIdOf(threadRef.threadId);
  const pane = useAtomValue(livePaneAtom(sessionId ?? ""));
  if (shell === null) return null;
  const header = <TessayaThreadHeader threadRef={threadRef} shell={shell} pane={pane} />;
  if (!live) return header;
  // Moved into Tessaya: an ordinary thread on the same session, with no terminal to report on.
  if (movedIntoTessaya(threadRef.threadId, shell.providerInstanceId, activeNativeId)) return header;
  const lastItem = items.at(-1)?.item;
  const stopped = classifierStopReason(
    lastItem?.type === "assistant_message" ? lastItem.text : null,
  );
  return (
    <>
      {header}
      <TessayaLiveBinding threadRef={threadRef} sessionId={sessionId} />
      {stopped === null ? null : (
        <span
          className="shrink-0 text-2xs text-warning-foreground"
          data-testid="thread-classifier-stop"
        >
          {stopped}
        </span>
      )}
      {shell.providerInstanceId === LIVE_INSTANCE ? null : (
        <Button
          size="xs"
          variant="outline"
          className="shrink-0 [-webkit-app-region:no-drag]"
          data-testid="thread-handoff-banner"
          onClick={() =>
            useComposerDraftStore.getState().setModelSelection(threadRef, {
              ...shell.modelSelection,
              instanceId: ProviderInstanceId.make(LIVE_INSTANCE),
            } as ModelSelection)
          }
        >
          This thread is now answered by a new session (summary handoff). Switch back
        </Button>
      )}
    </>
  );
}
