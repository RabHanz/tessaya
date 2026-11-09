/**
 * A thread's Tessaya header parts (BatonThreadHeader), and on a live thread its session status: whether the terminal
 * session runs (BatonLiveBinding), a reply the safety classifier stopped, and the way back when a handoff session
 * answers it.
 */
import { ProviderInstanceId, type ModelSelection, type ScopedThreadRef } from "@t3tools/contracts";

import {
  classifierStopReason,
  isLiveThreadId,
  LIVE_INSTANCE,
  liveSessionIdOf,
} from "@t3tools/baton-shared/liveThread";
import { useAtomValue } from "@effect/atom-react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useQuietThreadShell, useThreadVisibleTurnItems } from "../../state/entities";
import { Button } from "../ui/button";
import { BatonLiveBinding } from "./BatonLiveBinding";
import { livePaneAtom } from "./BatonLiveModel";
import { BatonThreadHeader } from "./BatonThreadHeader";

export function BatonLiveStatus({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(threadRef);
  const live = isLiveThreadId(threadRef.threadId);
  const items = useThreadVisibleTurnItems(live ? threadRef : null);
  const pane = useAtomValue(livePaneAtom(liveSessionIdOf(threadRef.threadId) ?? ""));
  if (shell === null) return null;
  const header = <BatonThreadHeader threadRef={threadRef} shell={shell} pane={pane} />;
  if (!live) return header;
  const lastItem = items.at(-1)?.item;
  const stopped = classifierStopReason(
    lastItem?.type === "assistant_message" ? lastItem.text : null,
  );
  return (
    <>
      {header}
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
