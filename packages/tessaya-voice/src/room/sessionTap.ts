// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * The raw aligned uplink (16-byte header and the mic as the R1 sent it, before any cancelling) and her downlink with its
 * sample count, so the echo path and every check on it can be replayed offline. Off unless the host names a private
 * folder (R1_SESSION_TAP_DIR); hourly files, 0700/0600, oldest dropped past the cap or the age. Never stops the loop.
 *
 * Record: u8 kind (1 up, 2 down), f64 ms, u32 down sample (0 for up), u32 bytes, the bytes; little-endian.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const TAP_UP = 1;
export const TAP_DOWN = 2;

export const createSessionTap = (opts: {
  readonly dir: string;
  readonly capBytes: number;
  readonly maxAgeMs: number;
  readonly log: (line: string) => void;
}) => {
  let pending: Buffer[] = [];
  let failed = false;
  const fileOf = (device: string, atMs: number) =>
    NodePath.join(
      opts.dir,
      `${device}-${new Date(atMs).toISOString().slice(0, 13).replace(/[-:]/g, "")}.tap`,
    );
  let file = "";
  const prune = () => {
    const files = NodeFS.readdirSync(opts.dir)
      .filter((f) => f.endsWith(".tap"))
      .map((f) => {
        const path = NodePath.join(opts.dir, f);
        const st = NodeFS.statSync(path);
        return { path, size: st.size, at: st.mtimeMs };
      })
      .toSorted((a, b) => b.at - a.at);
    let total = 0;
    for (const f of files) {
      total += f.size;
      if (total > opts.capBytes || Date.now() - f.at > opts.maxAgeMs) NodeFS.rmSync(f.path);
    }
  };
  // Off the event loop, one write at a time so records keep their order: a sync append blocked the loop for up to
  // 989 ms on onnyx's busy disk (27 Nov), and the tap writes between sessions too.
  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    if (pending.length === 0 || file === "" || failed) return;
    const out = Buffer.concat(pending);
    const to = file;
    pending = [];
    writing = writing
      .then(() => NodeFS.promises.mkdir(opts.dir, { recursive: true, mode: 0o700 }))
      .then(() => NodeFS.promises.appendFile(to, out, { mode: 0o600 }))
      .catch((error: unknown) => {
        if (!failed) opts.log(`session tap off: ${String(error)}`);
        failed = true;
      });
  };
  const timer = setInterval(flush, 1_000);
  timer.unref();
  const pruner = setInterval(() => {
    try {
      prune();
    } catch {
      // A folder that is not there yet has nothing to prune.
    }
  }, 600_000);
  pruner.unref();
  const add = (kind: number, device: string, bytes: Uint8Array, sample: number, atMs: number) => {
    const next = fileOf(device, atMs);
    if (next !== file) {
      flush();
      file = next;
    }
    const head = Buffer.alloc(17);
    head.writeUInt8(kind, 0);
    head.writeDoubleLE(atMs, 1);
    head.writeUInt32LE(sample >>> 0, 9);
    head.writeUInt32LE(bytes.length, 13);
    pending.push(head, Buffer.from(bytes));
  };
  return {
    /** Everything handed over so far, on disk. */
    drained: () => {
      flush();
      return writing;
    },
    up: (device: string, frame: Uint8Array, atMs: number) => add(TAP_UP, device, frame, 0, atMs),
    down: (device: string, frame: Uint8Array, sample: number, atMs: number) =>
      add(TAP_DOWN, device, frame, sample, atMs),
  };
};

/** Reads a tap file back, in the order it was written. */
export const readTap = (buffer: Buffer) => {
  const out: Array<{ kind: number; atMs: number; sample: number; bytes: Uint8Array }> = [];
  for (let at = 0; at + 17 <= buffer.length;) {
    const len = buffer.readUInt32LE(at + 13);
    out.push({
      kind: buffer.readUInt8(at),
      atMs: buffer.readDoubleLE(at + 1),
      sample: buffer.readUInt32LE(at + 9),
      bytes: buffer.subarray(at + 17, at + 17 + len),
    });
    at += 17 + len;
  }
  return out;
};
