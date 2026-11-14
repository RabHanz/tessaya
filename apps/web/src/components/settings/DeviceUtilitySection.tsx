/**
 * Settings → Hardware → Device utility (DEVICE-UTILITY.md): update, repair and tune an R1 at three levels. Easy is one
 * button; Normal picks a version, keeps it or resumes; Developer sends raw commands and reads the device's log. Over the
 * air only here; repair by cable is the desktop app's or the standalone r1flash tool's.
 */
import {
  batonDesktopBridge,
  type BatonDevicesCallResult,
  type DeviceView,
  type RegisteredDevice,
} from "@t3tools/baton-contracts";
import { r1EasyAction, type R1UpdatesView } from "@t3tools/baton-shared/r1Firmware";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const LEVELS = [
  ["easy", "Easy"],
  ["normal", "Normal"],
  ["developer", "Developer"],
] as const;
type Level = (typeof LEVELS)[number][0];
const LevelSchema = Schema.Literals(["easy", "normal", "developer"]);
const R1FLASH_URL = "https://github.com/RabHanz/tessaya/releases?q=r1flash";
const TAIL_MS = 1000;

type Run = (
  kind: "read" | "act" | "owner",
  op: string,
  args: Record<string, unknown>,
  done?: (value: unknown) => string,
) => Promise<unknown>;
/** A call with no note, busy state or refresh: for the log, read every second. */
type Call = (
  kind: "owner",
  op: string,
  args: Record<string, unknown>,
) => Promise<BatonDevicesCallResult | null>;

export function DeviceUtilitySection({
  devices,
  registry,
  updates,
  busy,
  run,
  call,
}: {
  readonly call: Call;
  readonly devices: ReadonlyArray<DeviceView>;
  readonly registry: ReadonlyArray<RegisteredDevice>;
  readonly updates: R1UpdatesView | null;
  readonly busy: boolean;
  readonly run: Run;
}) {
  const [level, setLevel] = useLocalStorage<Level, Level>(
    "tessaya:device-utility-level",
    "easy",
    LevelSchema,
  );
  const r1s = devices.filter((d) => d.configured);
  if (r1s.length === 0 || updates === null) return null;
  return (
    <SettingsSection title="Device utility">
      <SettingsRow
        title="Level"
        description="Easy updates or repairs with one button. Normal picks a version. Developer reaches everything."
        control={
          <Select value={level} onValueChange={(v) => setLevel(v as Level)}>
            <SelectTrigger size="sm" aria-label="Device utility level">
              <SelectValue>{LEVELS.find(([v]) => v === level)?.[1]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {LEVELS.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {r1s.map((d) => (
        <DeviceUtility
          key={d.id}
          device={d}
          registered={registry.find((r) => r.deviceId === d.id)}
          updates={updates}
          level={level}
          busy={busy}
          run={run}
          call={call}
        />
      ))}
    </SettingsSection>
  );
}

function DeviceUtility({
  device: d,
  registered,
  updates,
  level,
  busy,
  run,
  call,
}: {
  readonly call: Call;
  readonly device: DeviceView;
  readonly registered: RegisteredDevice | undefined;
  readonly updates: R1UpdatesView;
  readonly level: Level;
  readonly busy: boolean;
  readonly run: Run;
}) {
  const u = updates.devices.find((x) => x.id === d.id);
  const recommended = updates.releases.find((r) => r.recommended)?.version ?? updates.pinned;
  const action = r1EasyAction(d.online === true, u, recommended);
  const cable = batonDesktopBridge()?.r1flash !== undefined;
  // The cable image to write: the recommended release when it has one, else the newest that does.
  const cableVersion =
    updates.releases.find((r) => r.recommended && r.cable)?.version ??
    updates.releases.find((r) => r.cable)?.version ??
    null;
  const [pick, setPick] = useState<string | null>(null);
  const version = pick ?? u?.firmware ?? recommended ?? "";
  const has = (itemId: string) => registered?.items.some((i) => i.id === itemId) === true;
  const status =
    action.kind === "busy"
      ? `Installing ${action.version}${d.ota === null ? "" : `: ${d.ota.line}`}. It restarts and comes back by itself.`
      : action.kind === "usb"
        ? "It's offline. If it doesn't come back, plug it into a computer with its USB cable to repair it."
        : (u?.line ?? "");
  return (
    <>
      <SettingsRow
        title={`${d.id} · ${u?.firmware ?? d.firmware ?? "firmware not reported"}`}
        description={status}
        control={
          action.kind === "usb" ? (
            cable ? undefined : (
              <Button size="sm" variant="outline" render={<a href={R1FLASH_URL} target="_blank" />}>
                Get r1flash
              </Button>
            )
          ) : (
            <Button
              size="sm"
              disabled={busy || action.kind !== "update"}
              onClick={() =>
                action.kind === "update" &&
                void run("owner", "update", { id: d.id, version: action.version })
              }
            >
              {action.kind === "update"
                ? `Update to ${action.version}`
                : action.kind === "busy"
                  ? "Updating…"
                  : "Up to date"}
            </Button>
          )
        }
      />
      {action.kind === "usb" && !cable ? (
        <SettingsRow
          title="Repair by cable"
          description="Open the Tessaya desktop app on the computer it's plugged into, or run r1flash there: one file, no install. Either restores it even when it won't start."
        />
      ) : null}
      {cable && (action.kind === "usb" || level !== "easy") ? (
        <UsbRepair
          id={d.id}
          online={d.online === true}
          version={cableVersion}
          busy={busy}
          run={run}
        />
      ) : null}

      {level === "easy" ? null : (
        <>
          <SettingsRow
            title="Version"
            description="Every signed release. An older one is a way back, and automatic updates then wait until you resume them."
          >
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Select value={version} onValueChange={(v) => setPick(v)}>
                <SelectTrigger size="sm" aria-label="Firmware version">
                  <SelectValue>{version}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {updates.releases.map((r) => (
                    <SelectItem key={r.version} value={r.version}>
                      {r.version}
                      {r.recommended ? " (recommended)" : ""}
                      {r.version === u?.firmware ? " (installed)" : ""}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || d.online !== true || version === u?.firmware || version === ""}
                onClick={() => void run("owner", "update", { id: d.id, version })}
              >
                Install
              </Button>
            </div>
          </SettingsRow>
          {u?.hold == null ? null : (
            <SettingsRow
              title="Automatic updates"
              description={`Paused: kept on ${u.hold}.`}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run("owner", "updateHold", { id: d.id, version: null })}
                >
                  Resume automatic updates
                </Button>
              }
            />
          )}
          <SettingsRow
            title="Wi-Fi and pairing"
            description={
              has("setup.open")
                ? "Setup mode shows its Wi-Fi and pairing codes on the eyes; then add it below, as a new R1."
                : "Hold S1 and S3 together for 5 seconds to open setup mode, then add it below as a new R1."
            }
            control={
              has("setup.open") ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || d.online !== true}
                  onClick={() => void run("act", "set", { id: d.id, itemId: "setup.open" })}
                >
                  Open setup mode
                </Button>
              ) : undefined
            }
          />
          {has("sys.factory_reset") ? <FactoryReset id={d.id} busy={busy} run={run} /> : null}
        </>
      )}

      {level === "developer" ? <Developer id={d.id} busy={busy} run={run} call={call} /> : null}
      {level === "developer" && cable ? <UsbConsole /> : null}
    </>
  );
}

function FactoryReset({ id, busy, run }: { id: string; busy: boolean; run: Run }) {
  const [typed, setTyped] = useState("");
  return (
    <SettingsRow
      title="Factory reset"
      description={`Clears its Wi-Fi, its key and its server, and keeps its radio calibration. It restarts in setup mode. Type ${id} to confirm.`}
    >
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Input
          size="sm"
          value={typed}
          aria-label="Type the device id to confirm"
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={busy || typed !== id}
          onClick={() => void run("act", "set", { id, itemId: "sys.factory_reset" })}
        >
          Reset
        </Button>
      </div>
    </SettingsRow>
  );
}

function Developer({ id, busy, run, call }: { id: string; busy: boolean; run: Run; call: Call }) {
  const [path, setPath] = useState("imu/stats");
  const [body, setBody] = useState('{"s":10}');
  const [log, setLog] = useState<ReadonlyArray<{ at: string; topic: string; text: string }>>([]);
  const parsed = (() => {
    try {
      const v: unknown = JSON.parse(body);
      return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  })();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the device's log on the server while open
  useEffect(() => {
    let since = 0;
    let stopped = false;
    const read = async () => {
      const reply = await call("owner", "tail", { id, since });
      const v = reply?.ok === true ? (reply.value as { next: number; lines: typeof log }) : null;
      if (stopped || v === null || v.lines.length === 0) return;
      since = v.next;
      setLog((was) => [...was, ...v.lines].slice(-200));
    };
    void read();
    const timer = window.setInterval(() => void read(), TAIL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per device; `call` is a new closure each render
  }, [id]);
  return (
    <>
      <SettingsRow
        title="Raw command"
        description="Sent as cmd/<path> with a JSON body, as the bench does (imu/stats, aec/param, net/use…). Replies show in the log."
      >
        <div className="flex flex-col gap-2 pt-2">
          <Input
            size="sm"
            value={path}
            aria-label="Command path"
            onChange={(e) => setPath(e.target.value)}
          />
          <Textarea
            value={body}
            aria-label="Command body (JSON)"
            onChange={(e) => setBody(e.target.value)}
          />
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || parsed === null}
              onClick={() => void run("owner", "raw", { id, path, payload: parsed })}
            >
              Send
            </Button>
          </div>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Log"
        description="Its state and events as the server hears them, newest last."
      >
        <pre className="mt-2 max-h-64 overflow-auto text-xs whitespace-pre-wrap">
          {log
            .map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.topic} ${l.text}`)
            .join("\n") || "Nothing yet."}
        </pre>
      </SettingsRow>
    </>
  );
}

/** What a cable job says now, in his words. Pure. */
const cableLine = (ev: Readonly<Record<string, unknown>>): string | null => {
  const msg = typeof ev["msg"] === "string" ? ev["msg"] : null;
  if (ev["ev"] === "progress" && typeof ev["done"] === "number" && typeof ev["total"] === "number")
    return `Writing ${Math.floor((100 * ev["done"]) / Math.max(1, ev["total"]))}%`;
  if (ev["ev"] === "phase" || ev["ev"] === "result") return msg;
  return null;
};

/**
 * Repair by cable through the desktop's r1flash: it waits for the R1's loader (an online R1 is restarted into it from
 * here), keeps its settings, writes the signed cable image and checks it. Never stopped midway.
 */
function UsbRepair({
  id,
  online,
  version,
  busy,
  run,
}: {
  id: string;
  online: boolean;
  version: string | null;
  busy: boolean;
  run: Run;
}) {
  const [line, setLine] = useState<string | null>(null);
  const [going, setGoing] = useState(false);
  const start = async () => {
    const r1flash = batonDesktopBridge()?.r1flash;
    if (r1flash === undefined || version === null) return;
    setGoing(true);
    setLine("Looking for it on this computer's USB ports…");
    let rebooted = false;
    const out = await r1flash({ op: "flash", version }, (ev) => {
      // While r1flash waits for the loader, an R1 still on the hub is restarted into it.
      if (ev["ev"] === "phase" && ev["phase"] === "link" && online && !rebooted) {
        rebooted = true;
        void run("owner", "reboot", { id }, () => "");
      }
      const next = cableLine(ev);
      if (next !== null) setLine(next);
    });
    setGoing(false);
    if (out.code !== 0)
      setLine(
        out.error ??
          (out.code === 3
            ? "It didn't answer on the cable. Unplug and replug its battery, then try again."
            : "The repair did not finish. Keep it plugged in and try again; its settings are kept."),
      );
  };
  return (
    <SettingsRow
      title="Repair by cable"
      description={
        line ??
        (version === null
          ? "No release has a cable image yet."
          : `Plug the R1 into this computer with its USB cable. This writes ${version} and keeps its settings, even when it won't start.`)
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={busy || going || version === null}
          onClick={() => void start()}
        >
          {going ? "Repairing…" : "Repair over USB"}
        </Button>
      }
    />
  );
}

/** The R1's own console on the cable, for the bench: its lines, and a line typed back. */
function UsbConsole() {
  const [lines, setLines] = useState<ReadonlyArray<string>>([]);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const bridge = batonDesktopBridge();
  const start = async () => {
    if (bridge?.r1flash === undefined) return;
    setOpen(true);
    const out = await bridge.r1flash({ op: "console" }, (ev) => {
      const text = ev["ev"] === "console" ? ev["line"] : cableLine(ev);
      if (typeof text === "string") setLines((was) => [...was, text].slice(-300));
    });
    setOpen(false);
    if (out.error !== undefined) setLines((was) => [...was, out.error!]);
  };
  return (
    <SettingsRow
      title="USB console"
      description="Its serial console on the cable (115200, without resetting it)."
      control={
        <Button
          size="sm"
          variant="outline"
          onClick={() => (open ? bridge?.r1flashStop?.() : void start())}
        >
          {open ? "Close" : "Open"}
        </Button>
      }
    >
      {open || lines.length > 0 ? (
        <div className="flex flex-col gap-2 pt-2">
          <pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap">
            {lines.join("\n")}
          </pre>
          <Input
            size="sm"
            value={typed}
            disabled={!open}
            aria-label="Console line"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              bridge?.r1flashInput?.(typed);
              setTyped("");
            }}
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}
