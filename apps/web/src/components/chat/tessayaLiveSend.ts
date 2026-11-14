import { pinnedLiveSelection } from "@t3tools/tessaya-shared/liveThread";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";

/**
 * After a send the server pinned to a live thread's own session, the draft drops the other instance it remembered,
 * so the picker shows the session that answered and the next send does not carry the stale choice again.
 */
export function forgetStaleLiveSelection(
  threadRef: ScopedThreadRef,
  sent: ModelSelection,
  thread: EnvironmentThreadShell | undefined,
): void {
  if (thread === undefined) return;
  const pinned = pinnedLiveSelection(thread.id, sent, thread.modelSelection);
  if (pinned.instanceId === sent.instanceId && pinned.model === sent.model) return;
  useComposerDraftStore.getState().setModelSelection(threadRef, thread.modelSelection);
}
