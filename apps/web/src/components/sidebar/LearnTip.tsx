import { batonDesktopBridge, tessayaLink, tessayaPlaceOf } from "@t3tools/tessaya-contracts";
import {
  LEARN_ITEMS,
  pickTip,
  readLearnProgress,
  type LearnItem,
  type LearnOp,
} from "@t3tools/tessaya-shared/learn";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

/**
 * One of Tessaya's tips in T3's window, by the same list and rule as her own window, counted on his server so a tip
 * seen anywhere is not shown again here. Picked once when the sidebar mounts, never on a redraw.
 */
export function LearnTip(props: { readonly environmentId: EnvironmentId }): ReactNode {
  const learnCall = useAtomCommand(batonWorkSessions.learnCall, { reportFailure: false });
  const navigate = useNavigate();
  const [tip, setTip] = useState<LearnItem | null>(null);
  const act = (change: LearnOp) =>
    void learnCall({
      environmentId: props.environmentId,
      input: { kind: "act", op: change.op, args: { ...change } },
    });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads his progress from the server once, then picks one tip
  useEffect(() => {
    let live = true;
    void learnCall({ environmentId: props.environmentId, input: { kind: "read", op: "get" } }).then(
      (result) => {
        if (!live || result._tag !== "Success" || !result.value.ok) return;
        const picked = pickTip(
          LEARN_ITEMS,
          readLearnProgress(result.value.value),
          { page: "sessions", area: "agents" },
          Date.now(),
        );
        if (picked === null) return;
        setTip(picked);
        act({ op: "seen", id: picked.id, at: Date.now() });
      },
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per environment
  }, [props.environmentId]);
  if (tip === null) return null;
  const open = () => {
    setTip(null);
    act({ op: "use", place: tip.place });
    const openTessaya = batonDesktopBridge()?.openTessaya;
    const place = tessayaPlaceOf(tip.place);
    if (openTessaya !== undefined) openTessaya(place === null ? undefined : tessayaLink(place));
    else void navigate({ to: "/settings/tessaya", hash: `tessaya-${tip.place}` });
  };
  return (
    <div role="note" className="flex flex-col gap-1 rounded-lg border p-2 text-xs">
      <span className="font-medium text-foreground">{tip.title}</span>
      <span className="text-muted-foreground">{tip.body}</span>
      <div className="flex items-center gap-1">
        <Button size="xs" variant="outline" onClick={open}>
          {tip.action}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setTip(null)}>
          Not now
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="ms-auto"
          onClick={() => {
            setTip(null);
            act({ op: "mode", mode: "off" });
            act({ op: "dismiss", id: tip.id });
          }}
        >
          No more tips
        </Button>
      </div>
    </div>
  );
}
