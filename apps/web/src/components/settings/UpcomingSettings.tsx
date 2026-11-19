/**
 * Coming up: everything Tessaya will do later, soonest first, with a countdown, and each item cancelled, paused or
 * moved where its owner allows. The Tessaya window shows this page at `/tessaya/upcoming`.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { UpcomingItem, UpcomingListResult, UpcomingOp } from "@t3tools/tessaya-contracts";
import {
  countdownText,
  nextTickMs,
  UPCOMING_GROUP_LABEL,
  UPCOMING_SOURCE_LABEL,
  upcomingClock,
  upcomingGroup,
  type UpcomingGroup,
} from "@t3tools/tessaya-shared/upcoming";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const REFRESH_MS = 60_000;
const GROUPS: ReadonlyArray<UpcomingGroup> = ["soon", "today", "week", "waiting"];

export function UpcomingPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <UpcomingSections
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to see what is coming up.
        </p>
      )}
    </SettingsPageContainer>
  );
}

function UpcomingSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const quiet = { reportFailure: false } as const;
  const listCall = useAtomCommand(tessayaWorkSessions.upcomingList, quiet);
  const changeCall = useAtomCommand(tessayaWorkSessions.upcomingChange, quiet);
  const [view, setView] = useState<UpcomingListResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);

  const refresh = async () => {
    const result = await listCall({ environmentId, input: {} });
    if (result._tag === "Success") setView(result.value);
    setNow(Date.now());
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's list now and each minute, as new items appear there
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- refresh closes over this environment
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [environmentId]);

  const items = view?.items ?? [];
  // The countdown ticks on the minute, and each second only while something is in its last minute.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the wall clock, which React cannot derive
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), nextTickMs(items, now));
    return () => window.clearTimeout(timer);
  }, [items, now]);

  const change = async (
    item: UpcomingItem,
    op: UpcomingOp,
    when?: { readonly at?: number; readonly inMinutes?: number },
  ) => {
    if (busy) return;
    setBusy(true);
    setNote("");
    const result = await changeCall({
      environmentId,
      input: { id: item.id, op, ...when },
    });
    // The server's sentence when its owner refused; otherwise the connection failed.
    const reason =
      result._tag === "Success"
        ? null
        : (squashAtomCommandFailure(result) as { readonly reason?: unknown } | null)?.reason;
    setNote(
      result._tag === "Success"
        ? result.value.line
        : typeof reason === "string"
          ? reason
          : "Couldn’t reach this environment. Try again.",
    );
    setBusy(false);
    setMoving(null);
    await refresh();
  };

  if (view === null)
    return <p className="px-4 py-3 text-sm text-muted-foreground">Reading what is coming up…</p>;

  return (
    <>
      {note === "" ? null : <p className="px-4 py-2 text-sm text-muted-foreground">{note}</p>}
      {view.unreadable.length === 0 ? null : (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {`Couldn’t read ${view.unreadable.join(", ")} just now, so this list may be missing some.`}
        </p>
      )}
      {items.length === 0 ? (
        <SettingsSection title="Coming up">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Nothing is set to happen in the next 7 days, and nothing is waiting on a condition.
          </p>
        </SettingsSection>
      ) : (
        GROUPS.map((group) => {
          const rows = items.filter((item) => upcomingGroup(item, now) === group);
          if (rows.length === 0) return null;
          return (
            <SettingsSection key={group} title={UPCOMING_GROUP_LABEL[group]}>
              {rows.map((item) => (
                <UpcomingRow
                  key={item.id}
                  item={item}
                  now={now}
                  busy={busy}
                  moving={moving === item.id}
                  onMove={() => setMoving(moving === item.id ? null : item.id)}
                  onChange={(op, when) => void change(item, op, when)}
                />
              ))}
            </SettingsSection>
          );
        })
      )}
    </>
  );
}

function UpcomingRow({
  item,
  now,
  busy,
  moving,
  onMove,
  onChange,
}: {
  readonly item: UpcomingItem;
  readonly now: number;
  readonly busy: boolean;
  readonly moving: boolean;
  readonly onMove: () => void;
  readonly onChange: (
    op: UpcomingOp,
    when?: { readonly at?: number; readonly inMinutes?: number },
  ) => void;
}) {
  const clock = upcomingClock(item);
  const when = [countdownText(item, now), clock, item.repeats]
    .filter((p) => p !== null)
    .join(" · ");
  const detail = item.condition === null ? item.line : `${item.condition}. ${item.line}`;
  const by = (minutes: number) =>
    onChange("move", { at: Math.max(now + 60_000, item.at! + minutes * 60_000) });
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge size="sm" variant="secondary">
            {UPCOMING_SOURCE_LABEL[item.source]}
          </Badge>
          <span>{item.title}</span>
        </span>
      }
      description={
        <>
          <span className="font-medium tabular-nums text-foreground">{when}</span>
          {detail === "" ? null : <span>{` · ${detail}`}</span>}
        </>
      }
      control={
        <span className="flex flex-wrap justify-end gap-1.5">
          {item.can.move ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={onMove}>
              Change time
            </Button>
          ) : null}
          {item.can.pause ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onChange(item.paused ? "resume" : "pause")}
            >
              {item.paused ? "Resume" : item.source === "rule" ? "Switch off" : "Pause"}
            </Button>
          ) : null}
          {item.can.cancel ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => onChange("cancel")}
            >
              Cancel
            </Button>
          ) : null}
        </span>
      }
    >
      {moving && item.at !== null ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => by(-5)}>
            −5 min
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => by(5)}>
            +5 min
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => by(15)}>
            +15 min
          </Button>
          <div className="w-32">
            <Input
              type="time"
              aria-label="New time"
              disabled={busy}
              onChange={(event) => {
                const [h, m] = event.target.value.split(":").map(Number);
                if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m))
                  return;
                const at = new Date(now);
                at.setHours(h, m, 0, 0);
                if (at.getTime() <= now) at.setDate(at.getDate() + 1);
                onChange("move", { at: at.getTime() });
              }}
            />
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}
