import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useBatonLiveOnly } from "./batonLiveOnly";

/** A Claude Code session running in a terminal now, in T3's own thread row; T3's row already shows its state and machine. */
export function BatonLiveBadge({ live }: { readonly live: boolean }) {
  if (!live) return null;
  return (
    <Badge variant="info" size="sm">
      Live
    </Badge>
  );
}

/** The list's empty state while Live only is on: its way out is turning the filter off. */
export function BatonNoLiveSessions() {
  const [, setLiveOnly] = useBatonLiveOnly();
  return (
    <>
      <span>No live sessions</span>
      <Button size="xs" variant="outline" onClick={() => setLiveOnly(false)}>
        Show all
      </Button>
    </>
  );
}
