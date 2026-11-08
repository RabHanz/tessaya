import { isLiveThreadId } from "@t3tools/baton-shared/liveThread";
import { Badge } from "../ui/badge";

/** A Claude Code session mirrored from a terminal, in T3's own thread row; T3's row already shows its state and machine. */
export function BatonLiveBadge({ threadId }: { readonly threadId: string }) {
  if (!isLiveThreadId(threadId)) return null;
  return (
    <Badge variant="info" size="sm">
      Live
    </Badge>
  );
}
