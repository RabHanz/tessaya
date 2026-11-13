// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * This desktop as one of Tessaya's vessels (R1-P13): it describes itself to its server's device registry (its
 * microphones and output, webcams, Windows Hello, screens, power, and the USB and Bluetooth peripherals plugged in)
 * and applies the writes the registry sends back. Writes to its voice choices go through the same setters as his own
 * clicks in Settings, so there is one way each one changes.
 */
import * as NodeChildProcess from "node:child_process";

import type { DeviceItem, DeviceManifest, DeviceWrite } from "@t3tools/baton-contracts";

import type { HomeControl } from "../home/batonHome.ts";

/** Voice choices that are this machine's hardware, as registry items. */
const CONTROL_ITEMS: Readonly<
  Record<
    string,
    { readonly id: string; readonly safety: DeviceItem["safety"]; readonly description: string }
  >
> = {
  "v.mic": {
    id: "audio.input",
    safety: "confirm",
    description: "the microphone Tessaya listens on at this computer",
  },
  "v.headphones": {
    id: "audio.output",
    safety: "free",
    description:
      "whether she plays to headphones or speakers here, which decides if talking over her cuts in",
  },
  "v.micAwake": {
    id: "mic.awake",
    safety: "confirm",
    description:
      "how long the microphone stays open after a dictation, so the next one starts at once",
  },
};
/** Stable across restarts and readable in a list: "desktop-rabee-laptop". */
export const desktopDeviceId = (host: string): string =>
  `desktop-${
    host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "pc"
  }`;

/** A choice's "" (Automatic) as an item value. */
const AUTOMATIC = "Automatic";

export interface PeripheralScan {
  readonly cameras: ReadonlyArray<string>;
  readonly biometrics: ReadonlyArray<string>;
  readonly bluetooth: ReadonlyArray<string>;
  readonly usb: ReadonlyArray<string>;
  readonly cardReaders: ReadonlyArray<string>;
  readonly battery: { readonly pct: number; readonly charging: boolean } | null;
}

export interface DesktopFacts {
  readonly controls: ReadonlyArray<HomeControl>;
  readonly screens: ReadonlyArray<string>;
  readonly onBattery: boolean;
  readonly locked: boolean;
  readonly idleSeconds: number;
  readonly scan: PeripheralScan | null;
}

const PLUMBING =
  /root hub|host controller|composite|generic usb hub|enumerator|radio|microsoft bluetooth|bluetooth le generic|rfcomm|avrcp|transport|device identification|usb input device|hid-compliant (vendor|system|consumer)|attribute profile|service discovery/i;

/** `Get-PnpDevice` rows (present, status OK) sorted into what a person would call his peripherals. Pure. */
export const classifyPnp = (
  rows: ReadonlyArray<{
    readonly Class?: unknown;
    readonly FriendlyName?: unknown;
    readonly InstanceId?: unknown;
  }>,
  battery: { readonly EstimatedChargeRemaining?: unknown; readonly BatteryStatus?: unknown } | null,
): PeripheralScan => {
  const names = (test: (cls: string, id: string) => boolean) =>
    [
      ...new Set(
        rows.flatMap((r) => {
          const name = typeof r.FriendlyName === "string" ? r.FriendlyName.trim() : "";
          const cls = typeof r.Class === "string" ? r.Class : "";
          const id = typeof r.InstanceId === "string" ? r.InstanceId : "";
          return name !== "" && !PLUMBING.test(name) && test(cls, id) ? [name.slice(0, 80)] : [];
        }),
      ),
    ].toSorted();
  const pct =
    typeof battery?.EstimatedChargeRemaining === "number" ? battery.EstimatedChargeRemaining : null;
  return {
    cameras: names((cls) => cls === "Camera" || cls === "Image"),
    biometrics: names((cls) => cls === "Biometric"),
    // Paired devices enumerate under BTHENUM or BTHLE; the radio itself sits on USB or PCI.
    bluetooth: names(
      (cls, id) =>
        /^(BTHENUM|BTHLE)\\DEV_/i.test(id) || (cls === "Bluetooth" && !/^(USB|PCI)\\/i.test(id)),
    ),
    usb: names(
      (cls, id) =>
        id.startsWith("USB\\") &&
        !["USB", "Camera", "Image", "Biometric", "Bluetooth"].includes(cls),
    ),
    cardReaders: names((cls) => cls === "SmartCardReader" || cls === "SDHost"),
    // Win32_Battery's BatteryStatus 2 is on mains; 6 to 9 are charging.
    battery:
      pct === null
        ? null
        : { pct, charging: [2, 6, 7, 8, 9].includes(Number(battery?.BatteryStatus)) },
  };
};

const item = (
  id: string,
  label: string,
  type: string,
  group: string,
  description: string,
  extra: Partial<DeviceItem> = {},
): DeviceItem => ({
  id,
  label,
  type,
  access: "read",
  safety: "free",
  report: "on-change",
  group,
  description,
  ...extra,
});

/** The manifest from what this machine has now. Pure: the same facts give the same manifest. */
export const desktopManifest = (input: {
  readonly deviceId: string;
  readonly name: string;
  readonly appVersion: string;
  readonly facts: DesktopFacts;
}): DeviceManifest => {
  const { facts } = input;
  const controlItems = input.facts.controls.flatMap((c): Array<DeviceItem> => {
    const spec = CONTROL_ITEMS[c.id];
    if (spec === undefined || c.kind !== "choice") return [];
    return [
      item(spec.id, c.label, "enum", "audio", spec.description, {
        access: "read,write",
        safety: spec.safety,
        values: c.options.map((o) => (o.value === "" ? AUTOMATIC : o.value)).slice(0, 40),
      }),
    ];
  });
  const scanned = facts.scan;
  return {
    deviceId: input.deviceId,
    kind: "desktop",
    name: input.name,
    firmware: input.appVersion,
    schema: 1,
    items: [
      ...controlItems,
      item("screen.list", "Screens", "string", "system", "the screens connected to this computer"),
      item(
        "power.on_battery",
        "On battery",
        "bool",
        "power",
        "whether this computer runs on its battery",
      ),
      ...(scanned?.battery == null
        ? []
        : [
            item(
              "power.battery_pct",
              "Battery",
              "number",
              "power",
              "battery level of this computer",
              {
                unit: "%",
                range: [0, 100],
              },
            ),
            item(
              "power.charging",
              "Charging",
              "bool",
              "power",
              "whether this computer is charging",
            ),
          ]),
      item("presence.locked", "Locked", "bool", "presence", "whether his screen is locked here"),
      item(
        "presence.idle",
        "Idle",
        "number",
        "presence",
        "seconds since his last keyboard or mouse input here",
        {
          unit: "s",
        },
      ),
      ...(scanned === null
        ? []
        : [
            item("camera.devices", "Webcams", "string", "peripherals", "the webcams connected", {
              privacy: true,
            }),
            item(
              "biometric.hello",
              "Windows Hello",
              "bool",
              "peripherals",
              "whether a Windows Hello fingerprint or face sensor is present",
              {
                privacy: true,
              },
            ),
            item(
              "peripherals.usb",
              "USB devices",
              "string",
              "peripherals",
              "the USB devices plugged in",
            ),
            item(
              "peripherals.bluetooth",
              "Bluetooth devices",
              "string",
              "peripherals",
              "the Bluetooth devices paired and present",
            ),
            item(
              "peripherals.cardreader",
              "Card readers",
              "string",
              "peripherals",
              "smart card and SD readers",
            ),
          ]),
    ],
  };
};

/** The values that go with it. */
export const desktopValues = (
  facts: DesktopFacts,
): ReadonlyArray<{ itemId: string; value: unknown }> => {
  const out: Array<{ itemId: string; value: unknown }> = [];
  for (const c of facts.controls) {
    const spec = CONTROL_ITEMS[c.id];
    if (spec !== undefined && c.kind === "choice")
      out.push({ itemId: spec.id, value: c.value === "" ? AUTOMATIC : c.value });
  }
  const list = (xs: ReadonlyArray<string>) => (xs.length === 0 ? "none" : xs.join(", "));
  out.push(
    { itemId: "screen.list", value: list(facts.screens) },
    { itemId: "power.on_battery", value: facts.onBattery },
    { itemId: "presence.locked", value: facts.locked },
    // In whole minutes, so a value changes about once a minute rather than every call.
    { itemId: "presence.idle", value: Math.floor(facts.idleSeconds / 60) * 60 },
  );
  const s = facts.scan;
  if (s !== null) {
    if (s.battery !== null)
      out.push(
        { itemId: "power.battery_pct", value: s.battery.pct },
        { itemId: "power.charging", value: s.battery.charging },
      );
    out.push(
      { itemId: "camera.devices", value: list(s.cameras) },
      {
        itemId: "biometric.hello",
        value: s.biometrics.length > 0 || s.cameras.some((c) => /\bIR\b|hello/i.test(c)),
      },
      { itemId: "peripherals.usb", value: list(s.usb) },
      { itemId: "peripherals.bluetooth", value: list(s.bluetooth) },
      { itemId: "peripherals.cardreader", value: list(s.cardReaders) },
    );
  }
  return out;
};

/** A write for one of its items, as the voice setting it changes; null for an item it does not take writes on. */
export const settingOfWrite = (
  write: Pick<DeviceWrite, "itemId" | "value">,
): readonly [string, string] | null => {
  const entry = Object.entries(CONTROL_ITEMS).find(([, spec]) => spec.id === write.itemId);
  if (entry === undefined || typeof write.value !== "string") return null;
  return [entry[0], write.value === AUTOMATIC ? "" : write.value];
};

const SCAN = `$d = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' } | Select-Object Class,FriendlyName,InstanceId)
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus
@{ devices = $d; battery = $b } | ConvertTo-Json -Compress -Depth 3`;
/** Prints a line on every device arrival or removal, so a plug is seen at once without polling. */
const WATCH = `Register-CimIndicationEvent -ClassName Win32_DeviceChangeEvent -SourceIdentifier tessayaDc | Out-Null
while ($true) { $e = Wait-Event -SourceIdentifier tessayaDc; Remove-Event -EventIdentifier $e.EventIdentifier; [Console]::Out.WriteLine('change'); [Console]::Out.Flush() }`;

const ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

const scanWindows = (): Promise<PeripheralScan | null> =>
  new Promise((resolve) =>
    NodeChildProcess.execFile(
      "powershell.exe",
      [...ARGS, SCAN],
      { timeout: 20_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) return resolve(null);
        try {
          const parsed = JSON.parse(stdout) as { devices?: unknown; battery?: unknown };
          const rows = Array.isArray(parsed.devices) ? parsed.devices : [];
          const battery =
            typeof parsed.battery === "object" ? (parsed.battery as Record<string, unknown>) : null;
          resolve(classifyPnp(rows as never, battery));
        } catch {
          resolve(null);
        }
      },
    ),
  );

/** One call of the devices door's vessel kind: report, and collect writes. */
type Publish = (body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

const LONG_WAIT_MS = 12_000;
const RETRY_MS = 20_000;

export const startDesktopDevice = (input: {
  readonly publish: Publish;
  readonly deviceId: string;
  readonly name: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly facts: () => Omit<DesktopFacts, "scan">;
  readonly applySetting: (id: string, value: string) => void;
  /** Calls `poke` when something it reads changed (a screen, power, lock); returns how to stop. */
  readonly onChange: (poke: () => void) => () => void;
}) => {
  let scan: PeripheralScan | null = null;
  let sentVersion: string | null = null;
  const sentValues = new Map<string, string>();
  let acks: Array<{ id: string; ok: boolean; error?: string }> = [];
  let stopped = false;
  const facts = (): DesktopFacts => ({ ...input.facts(), scan });

  /** What to send now: the manifest when it changed, and the values that changed since the last answered call. */
  const body = (waitMs: number) => {
    const f = facts();
    const manifest = desktopManifest({
      deviceId: input.deviceId,
      name: input.name,
      appVersion: input.appVersion,
      facts: f,
    });
    const version = JSON.stringify(manifest.items);
    const values = desktopValues(f).filter(
      (v) => sentValues.get(v.itemId) !== JSON.stringify(v.value),
    );
    return {
      version,
      values,
      body: {
        deviceId: input.deviceId,
        ...(version === sentVersion ? {} : { manifest }),
        ...(values.length === 0 ? {} : { values }),
        ...(acks.length === 0 ? {} : { acks }),
        waitMs,
      },
    };
  };
  const call = async (waitMs: number) => {
    const next = body(waitMs);
    const sentAcks = acks;
    acks = [];
    try {
      const answer = (await input.publish(next.body, waitMs + 8_000)) as {
        writes?: unknown;
      } | null;
      sentVersion = next.version;
      for (const v of next.values) sentValues.set(v.itemId, JSON.stringify(v.value));
      const writes = Array.isArray(answer?.writes) ? (answer.writes as Array<DeviceWrite>) : [];
      for (const w of writes) {
        const setting = settingOfWrite(w);
        if (setting === null)
          acks.push({ id: w.id, ok: false, error: "This computer does not take that." });
        else {
          input.applySetting(setting[0], setting[1]);
          acks.push({ id: w.id, ok: true });
        }
      }
      return true;
    } catch {
      // The server did not get them: resend everything next time.
      acks = [...sentAcks, ...acks];
      sentVersion = null;
      sentValues.clear();
      return false;
    }
  };
  const loop = async (): Promise<void> => {
    if (stopped) return;
    const ok = await call(LONG_WAIT_MS);
    if (!ok) await new Promise((r) => setTimeout(r, RETRY_MS).unref());
    return loop();
  };
  // A change goes out at once, outside the long wait; the long wait's own answer then sends only what is left.
  const poke = () => void (acks.length > 0 || body(0).values.length > 0 ? call(0) : undefined);

  let rescanTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: NodeChildProcess.ChildProcess | null = null;
  const rescan = () => {
    if (input.platform !== "win32") return;
    void scanWindows().then((found) => {
      if (found === null) return;
      scan = found;
      poke();
    });
  };
  if (input.platform === "win32") {
    rescan();
    watcher = NodeChildProcess.spawn("powershell.exe", [...ARGS, WATCH], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    watcher.stdout?.on("data", () => {
      // A plug fires several events at once: one scan after they settle.
      if (rescanTimer !== null) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(rescan, 2_000);
      rescanTimer.unref();
    });
    watcher.on("error", () => undefined);
  }
  const unwatch = input.onChange(poke);
  void loop();
  return {
    stop: () => {
      stopped = true;
      unwatch();
      if (rescanTimer !== null) clearTimeout(rescanTimer);
      watcher?.kill();
    },
  };
};
