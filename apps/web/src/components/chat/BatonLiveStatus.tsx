/**
 * A live thread's session status in its header: whether the terminal session runs (BatonLiveBinding), a reply the
 * safety classifier stopped, and the way back when a handoff session answers it. Account, room left and the pin are
 * in the composer's model picker (BatonPickerAccount).
 */
import { ProviderInstanceId, type ModelSelection, type ScopedThreadRef } from "@t3tools/contracts";

import {
  classifierStopReason,
  isLiveThreadId,
  LIVE_INSTANCE,
} from "@t3tools/baton-shared/liveThread";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useQuietThreadShell, useThreadVisibleTurnItems } from "../../state/entities";
import { Button } from "../ui/button";
import { BatonLiveBinding } from "./BatonLiveBinding";

export function BatonLiveStatus({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(threadRef);
  const live = isLiveThreadId(threadRef.threadId);
  const items = useThreadVisibleTurnItems(live ? threadRef : null);
  if (shell === null || !live) return null;
  const lastItem = items.at(-1)?.item;
  const stopped = classifierStopReason(
    lastItem?.type === "assistant_message" ? lastItem.text : null,
  );
  return (
    <>
      <BatonLiveBinding threadRef={threadRef} />
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
