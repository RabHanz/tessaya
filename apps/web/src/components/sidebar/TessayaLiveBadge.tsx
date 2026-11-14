import { TerminalIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useTessayaLiveOnly } from "./tessayaLiveOnly";

/** A Claude Code session running in a terminal now, in T3's own thread row; T3's row already shows its state and machine. */
export function TessayaLiveBadge({ live }: { readonly live: boolean }) {
  if (!live) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="info" size="sm" />}>
        <TerminalIcon aria-hidden />
        Terminal
      </TooltipTrigger>
      <TooltipPopup>Running in a terminal; Tessaya controls it by typing into it.</TooltipPopup>
    </Tooltip>
  );
}

/** The list's empty state while Live only is on: its way out is turning the filter off. */
export function TessayaNoLiveSessions() {
  const [, setLiveOnly] = useTessayaLiveOnly();
  return (
    <>
      <span>No live sessions</span>
      <Button size="xs" variant="outline" onClick={() => setLiveOnly(false)}>
        Show all
      </Button>
    </>
  );
}
