import type { DeviceView } from "@t3tools/tessaya-contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Run = (kind: "act" | "owner", op: string, args: Record<string, unknown>) => Promise<unknown>;

/** One id moved by `steps` within the order, clamped to its ends. */
const moved = (ids: ReadonlyArray<string>, id: string, steps: number): Array<string> => {
  const next = [...ids];
  const from = next.indexOf(id);
  if (from === -1) return next;
  next.splice(from, 1);
  next.splice(Math.min(Math.max(from + steps, 0), next.length), 0, id);
  return next;
};

/** A ranked list, first choice first; the step buttons reorder it. */
function RankedList(props: {
  readonly label: string;
  readonly rows: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly note: string;
  }>;
  readonly disabled: boolean;
  readonly onOrder: (order: ReadonlyArray<string>) => void;
  /** A Forget button per row, off while only one is left. */
  readonly onForget?: (id: string) => void;
}) {
  const ids = props.rows.map((r) => r.id);
  return (
    <ol
      aria-label={props.label}
      className="divide-y divide-border/60 rounded-lg border border-border/60"
    >
      {props.rows.map((r, i) => (
        <li
          key={r.id}
          className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 ps-3 pe-1.5"
        >
          <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span>
          <span className="min-w-0">
            <span className="block text-sm leading-5 break-words">{r.name}</span>
            {r.note === "" ? null : (
              <span className="block text-2xs text-muted-foreground">{r.note}</span>
            )}
          </span>
          <span className="flex items-center gap-0.5">
            {props.onForget === undefined ? null : (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                disabled={props.disabled || ids.length <= 1}
                aria-label={`Forget ${r.name}`}
                onClick={() => props.onForget?.(r.id)}
              >
                Forget
              </Button>
            )}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={props.disabled || i === 0}
              aria-label={`Move ${r.name} up`}
              onClick={() => props.onOrder(moved(ids, r.id, -1))}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={props.disabled || i === ids.length - 1}
              aria-label={`Move ${r.name} down`}
              onClick={() => props.onOrder(moved(ids, r.id, 1))}
            >
              <ArrowDownIcon />
            </Button>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Its saved Wi-Fi networks in his order, a new one by name and password, and his hubs in order. */
export function WifiSection(props: {
  readonly device: DeviceView;
  readonly busy: boolean;
  readonly run: Run;
}) {
  const d = props.device;
  const off = props.busy || d.online !== true;
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [hotspot, setHotspot] = useState(false);
  const [backup, setBackup] = useState(false);
  const nets = d.wifi ?? [];
  if (d.wifi === undefined && d.hubs === undefined) return null;
  const add = async () => {
    await props.run("act", "wifi", { id: d.id, action: "add", ssid, password, hotspot, backup });
    setPassword("");
    setSsid("");
  };
  return (
    <SettingsSection title={`Wi-Fi and hubs · ${d.id}`}>
      {d.wifi === undefined ? null : (
        <SettingsRow
          title="Wi-Fi order"
          description="It joins the first network in range, and moves back up when a higher one returns and it is idle."
        >
          <div className="flex flex-col gap-3 pt-2">
            <RankedList
              label="Wi-Fi networks, first choice first"
              rows={nets.map((n) => ({
                id: n.ssid,
                name: n.ssid,
                note: [
                  n.current ? "On it now" : "",
                  n.hotspot ? "Phone hotspot" : "",
                  n.badPass ? "Wrong password" : "",
                ]
                  .filter((s) => s !== "")
                  .join(" · "),
              }))}
              disabled={off}
              onOrder={(order) =>
                void props.run("act", "wifi", { id: d.id, action: "order", order })
              }
              onForget={(ssid) =>
                void props.run("act", "wifi", { id: d.id, action: "forget", ssid })
              }
            />
            <form
              className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <Input
                aria-label="Network name"
                placeholder="Network name"
                value={ssid}
                maxLength={32}
                disabled={off}
                onChange={(e) => setSsid(e.target.value)}
                className="sm:w-44"
              />
              <SecretInput
                aria-label="Password"
                placeholder="Password"
                value={password}
                maxLength={63}
                disabled={off}
                onChange={(e) => setPassword(e.target.value)}
                className="sm:w-44"
              />
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={hotspot} onCheckedChange={(on) => setHotspot(on === true)} />
                Phone hotspot
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={backup} onCheckedChange={(on) => setBackup(on === true)} />
                Only save as a backup
              </label>
              <Button
                type="submit"
                size="xs"
                variant="outline"
                disabled={off || ssid.trim() === ""}
              >
                Add network
              </Button>
            </form>
          </div>
        </SettingsRow>
      )}
      {d.hubs === undefined ? null : (
        <SettingsRow
          title="Servers it connects to"
          description="It uses the first one that answers, and moves back to the first when that one returns."
        >
          <div className="pt-2">
            <RankedList
              label="Servers, first choice first"
              rows={d.hubs.map((h) => ({
                id: h.id,
                name: h.label,
                note: h.current ? "Connected now" : "",
              }))}
              disabled={props.busy}
              onOrder={(order) => void props.run("owner", "hubs", { id: d.id, order })}
            />
          </div>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
