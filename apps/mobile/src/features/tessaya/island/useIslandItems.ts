import { useAtomValue } from "@effect/atom-react";
import { fromUpcoming, islandItems, type IslandFeed } from "@t3tools/tessaya-shared/island";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { steadyNavigationThreadShellsAtom } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { resolveThreadListV2Status } from "../../threads/threadListV2";
import { useHerPhase } from "./herPhase";

/** Coming up is read again each minute while the app is in front, as its own page does. */
const UPCOMING_MS = 60_000;

/** The island's items on this phone: her phase here, his agents' threads, and Coming up for the next day. */
export function useIslandItems() {
  const her = useHerPhase();
  const shells = useAtomValue(steadyNavigationThreadShellsAtom);
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const listUpcoming = useAtomCommand(tessayaWorkSessions.upcomingList, { reportFailure: false });
  const [later, setLater] = useState<Pick<IslandFeed, "timers" | "upcoming">>({
    timers: [],
    upcoming: [],
  });
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's Coming up each minute while the app is in front
  useEffect(() => {
    if (environmentId === null) return;
    const read = () => {
      if (AppState.currentState !== "active") return;
      setNow(Date.now());
      void listUpcoming({ environmentId, input: { days: 1 } }).then((r) => {
        if (r._tag === "Success") setLater(fromUpcoming(r.value.items));
      });
    };
    read();
    const timer = setInterval(read, UPCOMING_MS);
    const sub = AppState.addEventListener("change", (s) => s === "active" && read());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per environment; the command is stable
  }, [environmentId]);
  const waiting = shells.filter((t) => {
    const s = resolveThreadListV2Status(t);
    return s === "approval" || s === "input" || s === "request";
  });
  const first = waiting[0];
  return islandItems(
    {
      her,
      jobs: {
        needYou: waiting.length,
        working: shells.filter((t) => resolveThreadListV2Status(t) === "working").length,
        first:
          first === undefined
            ? null
            : {
                title: first.title,
                href: `/threads/${encodeURIComponent(first.environmentId)}/${encodeURIComponent(first.id)}`,
              },
      },
      ...later,
    },
    now,
  );
}
