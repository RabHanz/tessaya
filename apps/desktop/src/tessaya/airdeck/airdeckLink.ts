// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The Airdeck remote as one of Tessaya's inputs (L-142 slice 2). airdeck-core owns the receiver (WinUSB) and serves its
 * presses on loopback; this is its Tessaya client: it claims the buttons Tessaya acts on, hears every press, and
 * describes each remote to the device registry, so a press is a registry event that rules and agents see.
 * Protocol: the line format at the top of RabHanz/airdeck core/src/api.rs.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type { DeviceItem, DeviceManifest } from "@t3tools/tessaya-contracts";

export interface RemoteButton {
  readonly id: string;
  readonly label: string;
  readonly tapOnly: boolean;
}
export interface Remote {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly buttons: ReadonlyArray<RemoteButton>;
}

export type CoreEvent =
  | { readonly ev: "hello"; readonly remotes: ReadonlyArray<Remote> }
  | {
      readonly ev: "button";
      readonly remote: string;
      readonly button: string;
      readonly down: boolean;
      readonly owner: string | null;
    }
  | { readonly ev: "device"; readonly remote: string; readonly connected: boolean };

const str = (v: unknown, max = 40): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

/** One line from the core; anything else (claims, errors, a newer event) is null. The core is local but untrusted. */
export const parseCoreLine = (line: string): CoreEvent | null => {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  if (v["ev"] === "hello" && Array.isArray(v["remotes"])) {
    const remotes = (v["remotes"] as Array<Record<string, unknown>>).flatMap((r): Remote[] => {
      const id = str(r?.["id"]);
      if (id === null || !Array.isArray(r["buttons"])) return [];
      const buttons = (r["buttons"] as Array<Record<string, unknown>>).flatMap(
        (b): RemoteButton[] => {
          const bid = str(b?.["id"]);
          return bid === null
            ? []
            : [{ id: bid, label: str(b["label"]) ?? bid, tapOnly: b["tap_only"] === true }];
        },
      );
      return [{ id, name: str(r["name"]) ?? id, connected: r["connected"] === true, buttons }];
    });
    return { ev: "hello", remotes };
  }
  const remote = str(v["remote"]);
  if (remote === null) return null;
  if (v["ev"] === "button") {
    const button = str(v["button"]);
    return button === null || typeof v["down"] !== "boolean"
      ? null
      : { ev: "button", remote, button, down: v["down"], owner: str(v["owner"]) };
  }
  if (v["ev"] === "device" && typeof v["connected"] === "boolean")
    return { ev: "device", remote, connected: v["connected"] };
  return null;
};

// shortcut: a fixed set of buttons whose stock key does nothing useful at a desk (Voice, Home, Menu, the digits) is
// always Tessaya's, so registry rules can use them; make it a per-button choice if he wants one of them stock again.
const ALWAYS_TESSAYA = /^(mic|home|menu|num_\d)$/;

/** The "remote/button" keys Tessaya claims: everything bound on the bindings page, and the always-hers set. */
export const claimsFor = (
  remotes: ReadonlyArray<Remote>,
  bound: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const known = new Set(remotes.flatMap((r) => r.buttons.map((b) => `${r.id}/${b.id}`)));
  const always = remotes.flatMap((r) =>
    r.buttons.filter((b) => ALWAYS_TESSAYA.test(b.id)).map((b) => `${r.id}/${b.id}`),
  );
  return [...new Set([...bound.filter((k) => known.has(k)), ...always])].toSorted();
};

export const deckDeviceId = (remote: string): string => `airdeck-${remote}`;

/** A remote in the registry: one event per button, and whether its receiver is plugged in. No outputs: it has none. */
export const deckManifest = (remote: Remote): DeviceManifest => ({
  deviceId: deckDeviceId(remote.id),
  kind: "deck",
  name: `${remote.name} remote`,
  schema: 1,
  items: [
    {
      id: "connected",
      label: "Receiver plugged in",
      type: "bool",
      access: "read",
      safety: "free",
      report: "on-change",
      group: "status",
      description: "whether the remote's USB receiver is in this computer",
    },
    ...remote.buttons.map((b): DeviceItem => ({
      id: `press.${b.id}`,
      label: `${b.label} pressed`,
      type: "event",
      access: "event",
      safety: "free",
      group: "buttons",
      description: `fires each time the ${b.label} button on the ${remote.name} remote is pressed`,
    })),
  ],
});

interface CoreInfo {
  readonly port: number;
  readonly token: string;
}

const readInfo = (dir: string): CoreInfo | null => {
  try {
    const v = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "core.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return typeof v["port"] === "number" && typeof v["token"] === "string"
      ? { port: v["port"], token: v["token"] }
      : null;
  } catch {
    return null;
  }
};

const RETRY_MS = 10_000;

/**
 * Connects to airdeck-core, starting it first when it is installed and nobody hosts it, and reconnects for as long as
 * Tessaya runs. Windows only; without an Airdeck install it waits quietly.
 */
export const startAirdeckLink = (input: {
  /** %LOCALAPPDATA%: core.json under Airdeck, the exe under Programs\Airdeck. */
  readonly localAppData: string;
  readonly onHello: (remotes: ReadonlyArray<Remote>) => void;
  readonly onButton: (remote: string, button: string, down: boolean, mine: boolean) => void;
  readonly onDevice: (remote: string, connected: boolean) => void;
  readonly log: (line: string) => void;
}) => {
  const dir = NodePath.join(input.localAppData, "Airdeck");
  const exe = NodePath.join(input.localAppData, "Programs", "Airdeck", "airdeck-core.exe");
  let socket: NodeNet.Socket | null = null;
  let claims: ReadonlyArray<string> = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const send = (v: unknown) => socket?.write(`${JSON.stringify(v)}\n`);
  const later = () => {
    if (stopped) return;
    timer = setTimeout(connect, RETRY_MS);
    timer.unref();
  };
  const startCore = () => {
    if (!NodeFS.existsSync(exe)) return;
    // Exits at once with code 3 when another process (the Airdeck app) already hosts it.
    const child = NodeChildProcess.spawn(exe, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => undefined);
    child.unref();
  };
  function connect() {
    if (stopped) return;
    const info = readInfo(dir);
    if (info === null) {
      startCore();
      return later();
    }
    let buffer = "";
    const s = NodeNet.connect({ host: "127.0.0.1", port: info.port });
    socket = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
      send({ op: "hello", token: info.token, client: "tessaya" });
      if (claims.length > 0) send({ op: "claim", buttons: claims });
    });
    s.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const e = parseCoreLine(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
        if (e?.ev === "hello") input.onHello(e.remotes);
        else if (e?.ev === "button")
          input.onButton(e.remote, e.button, e.down, e.owner === "tessaya");
        else if (e?.ev === "device") input.onDevice(e.remote, e.connected);
      }
      // A line that long is not the core's.
      if (buffer.length > 1_000_000) s.destroy();
    });
    s.on("error", () => undefined);
    s.on("close", () => {
      if (socket === s) socket = null;
      // A stale core.json (its host gone) is replaced when the core starts again.
      startCore();
      later();
    });
  }
  connect();
  return {
    /** The buttons Tessaya acts on; sent again on every reconnect. */
    claim: (next: ReadonlyArray<string>) => {
      const gone = claims.filter((c) => !next.includes(c));
      claims = next;
      if (gone.length > 0) send({ op: "release", buttons: gone });
      if (next.length > 0) send({ op: "claim", buttons: next });
      input.log(`airdeck claims ${next.join(" ") || "none"}`);
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      socket?.destroy();
    },
  };
};
