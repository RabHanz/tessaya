// @effect-diagnostics nodeBuiltinImport:off
/**
 * Resets a Tessel whose stack is wedged on a joined link (27 Nov: ARP answered, nothing else) with the firmware's
 * remote reset frame (r1bt_netreset.h), UDP to port 9 so no raw socket is needed; the CP checks it before either IP
 * stack. A Tessel silent past `silentMs` gets one, then one per backoff step, then none until it is heard again.
 */
import * as NodeCrypto from "node:crypto";

const INFO = "tessel-net-reset";

/** The 53-byte reset payload: "TSLRST" | 1 | MAC | counter (ms, big-endian) | HMAC-SHA256 under the reset key. */
export const resetFrame = (deviceKey: string, mac: string, counter: number): Buffer => {
  const key = NodeCrypto.createHmac("sha256", deviceKey).update(INFO).digest();
  const head = Buffer.alloc(21);
  head.write("TSLRST\x01", 0, "latin1");
  Buffer.from(mac.replaceAll(":", ""), "hex").copy(head, 7);
  head.writeBigUInt64BE(BigInt(counter), 13);
  return Buffer.concat([head, NodeCrypto.createHmac("sha256", key).update(head).digest()]);
};

export interface ArpEntry {
  readonly ip: string;
  readonly mac: string;
  /** The kernel has a resolved address for it (flags 0x2): it answered ARP. */
  readonly complete: boolean;
}

/** /proc/net/arp rows. */
export const parseArp = (text: string): Array<ArpEntry> =>
  text
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 4 && /^[0-9a-f:]{17}$/i.test(c[3]!))
    .map((c) => ({ ip: c[0]!, mac: c[3]!.toLowerCase(), complete: (Number(c[2]) & 2) !== 0 }));

/** A Tessel's id ends with its MAC's last three bytes (r1-3d57b3 is …:3d:57:b3). */
export const arpFor = (id: string, rows: ReadonlyArray<ArpEntry>): ArpEntry | null => {
  const hex = /([0-9a-f]{6})$/i.exec(id)?.[1]?.toLowerCase();
  if (hex === undefined) return null;
  const tail = hex.match(/../g)!.join(":");
  return rows.find((r) => r.mac.endsWith(tail) && r.mac !== "00:00:00:00:00:00") ?? null;
};

export interface LinkWatchDeps {
  readonly now: () => number;
  readonly arp: () => ReadonlyArray<ArpEntry>;
  /** Sends the frame to the device's address, UDP port 9. */
  readonly send: (ip: string, frame: Buffer) => void;
  /** One provenance row per reset sent (the hub logs a Tessel's events as actions). */
  readonly report: (id: string, body: object) => void;
  readonly log: (line: string) => void;
  readonly deviceKey: string;
  readonly silentMs?: number;
}

/** After the first reset, the next ones wait this much longer each (ms). */
const BACKOFF_MS = [5 * 60_000, 10 * 60_000];

export const createLinkWatch = (deps: LinkWatchDeps) => {
  const silentMs = deps.silentMs ?? 150_000;
  const heardAt = new Map<string, number>();
  const tries = new Map<string, { n: number; at: number; checked: boolean }>();
  const known = new Map<string, ArpEntry>();
  return {
    /** Anything the Tessel itself sent. */
    heard: (id: string) => {
      heardAt.set(id, deps.now());
      const t = tries.get(id);
      if (t !== undefined) {
        tries.delete(id);
        deps.log(`[${id}] heard again after ${t.n} remote reset${t.n === 1 ? "" : "s"}`);
      }
    },
    /**
     * Every 30 s or so: a Tessel heard before and silent past silentMs gets its next reset, if one is due. A stale ARP
     * row still reads resolved, so the row is judged one tick after a send, once the kernel has probed it.
     */
    tick: () => {
      const now = deps.now();
      const rows = deps.arp();
      for (const [id, at] of heardAt) {
        const row = arpFor(id, rows);
        if (row !== null) known.set(id, row);
        const silent = now - at;
        if (silent < silentMs) continue;
        const t = tries.get(id) ?? { n: 0, at: 0, checked: true };
        if (!t.checked) {
          t.checked = true;
          const on = row?.complete === true;
          deps.log(
            `[${id}] silent ${Math.round(silent / 1000)} s; ${on ? `answers ARP at ${row.ip}: a wedged link, reset sent` : "no ARP answer: off or away"}`,
          );
          if (on) deps.report(id, { silent_s: Math.round(silent / 1000), try: t.n, arp: true });
        }
        if (t.n > BACKOFF_MS.length || (t.n > 0 && now - t.at < BACKOFF_MS[t.n - 1]!)) continue;
        const target = row ?? known.get(id);
        if (target === undefined) continue; // never seen on this LAN: nothing to reset from here
        tries.set(id, { n: t.n + 1, at: now, checked: false });
        deps.send(target.ip, resetFrame(deps.deviceKey, target.mac, now));
      }
    },
  };
};
