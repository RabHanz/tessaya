// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * Memory between servers (MEMORY.md section 6), off by default. This app's own server carries it on its own clock and
 * keeps each peer's sync-only credential (GEN-6); the window only pairs (it reaches the other server) and lists them.
 * Credentials an older build kept here, encrypted, are handed to the server once and the file is deleted.
 */
import * as NodeFS from "node:fs";

import type { MemoryCall } from "./memoryClient.ts";

/** A server the window is connected to, and whether this machine holds a live sync credential for it. */
export interface SyncPeer {
  readonly environmentId: string;
  readonly label: string;
  /** This app's own server: it syncs through the app's own session and needs no credential. */
  readonly local: boolean;
  readonly paired: boolean;
  /** When the credential stops working (ms); it cannot be renewed, only paired again. */
  readonly expiresAt?: number;
}

/** What the window sends a server's sync calls with: the token, and the only origin it may go to. */
interface PeerCredential {
  readonly origin: string;
  /** Where the window reached it, with any relay path. */
  readonly baseUrl?: string;
  readonly token: string;
  readonly expiresAt: number;
}

/** The operating system's encryption (Electron `safeStorage`); null where it cannot encrypt for real. */
export interface SyncProtection {
  readonly protect: (plain: string) => string;
  readonly unprotect: (wrapped: string) => string;
}

export const createMemorySync = (input: {
  /** An older build's on/off file; read once for the move to the server. */
  readonly file: string;
  readonly call: MemoryCall;
  /** An older build's encrypted credentials; handed to the server once, then deleted. */
  readonly peersFile?: string;
  /** Asked each time: encryption can become unavailable, and then the old file cannot be read. */
  readonly protection?: () => SyncProtection | null;
  readonly now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  let lastPeers: ReadonlyArray<SyncPeer> = [];
  let state: {
    readonly enabled: boolean;
    readonly peers: ReadonlyArray<{ environmentId: string; label: string; expiresAt: number }>;
  } = { enabled: false, peers: [] };
  const readState = async () => {
    const out = (await input.call("syncState", {}).catch(() => null)) as typeof state | null;
    if (out !== null) state = out;
    return state;
  };

  /**
   * The older build's credentials, live and decryptable. Null when the file exists and cannot be read here (no
   * encryption, or it is not the file's JSON): then nothing may be deleted, and the move is tried at the next start.
   */
  const legacyPeers = (): Record<string, PeerCredential> | null => {
    if (input.peersFile === undefined || !NodeFS.existsSync(input.peersFile)) return {};
    const protection = input.protection?.() ?? null;
    if (protection === null) return null;
    let wrapped: Record<string, unknown>;
    try {
      wrapped = JSON.parse(NodeFS.readFileSync(input.peersFile, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
    const out: Record<string, PeerCredential> = {};
    for (const [id, value] of Object.entries(wrapped)) {
      if (typeof value !== "string") continue;
      try {
        const peer = JSON.parse(protection.unprotect(value)) as PeerCredential;
        if (
          typeof peer.token === "string" &&
          typeof peer.origin === "string" &&
          peer.expiresAt > now()
        )
          out[id] = peer;
      } catch {
        // This entry was already unusable here (another machine's key); the others still move.
      }
    }
    return out;
  };
  const legacyEnabled = (): boolean => {
    try {
      return (
        (JSON.parse(NodeFS.readFileSync(input.file, "utf8")) as { sync?: unknown }).sync === true
      );
    } catch {
      return false;
    }
  };

  /** Once: the old switch and credentials go to the server, and the local copies are deleted only after it took them. */
  const migrate = async (): Promise<void> => {
    const peers = legacyPeers();
    if (peers === null) return;
    const on = legacyEnabled();
    if (Object.keys(peers).length === 0 && !on && !NodeFS.existsSync(input.peersFile ?? "")) return;
    // His names for them, from the window's list when it is up.
    const listed = (await input.call("syncPeers", {}).catch(() => null)) as ReadonlyArray<{
      environmentId: string;
      label: string;
      baseUrl?: string;
    }> | null;
    // A relay peer is reached under a path the old file never kept; the window's connection knows it.
    const known = new Map<string, { label: string; baseUrl?: string }>(
      (listed ?? lastPeers).map((p) => [p.environmentId, p]),
    );
    for (const [environmentId, peer] of Object.entries(peers)) {
      const seen = known.get(environmentId);
      await input.call("syncAddPeer", {
        environmentId,
        label: seen?.label ?? environmentId,
        ...peer,
        ...(seen?.baseUrl === undefined ? {} : { baseUrl: seen.baseUrl }),
      });
    }
    if (on) await input.call("syncSetEnabled", { on: true });
    if (input.peersFile !== undefined) NodeFS.rmSync(input.peersFile, { force: true });
    NodeFS.rmSync(input.file, { force: true });
    await readState();
  };

  const run = async (): Promise<string> => {
    if (!(await readState()).enabled) return "Memory sync is off.";
    try {
      const out = (await input.call("syncRun", {})) as {
        servers?: number;
        applied?: number;
        refused?: ReadonlyArray<{ environmentId: string; label: string }>;
      } | null;
      const refused = (out?.refused ?? []).map(
        (gone) => `${gone.label} stopped accepting this computer's sync credential; pair it again.`,
      );
      const line =
        (out?.servers ?? 0) < 2
          ? "Only one server is syncing, so there is nothing to carry. Pair the others for memory sync."
          : `Synced ${out?.applied ?? 0} changes across ${out?.servers} servers.`;
      await readState();
      return [line, ...refused].join(" ");
    } catch (error) {
      return error instanceof Error ? error.message : "Sync did not work.";
    }
  };

  return {
    /** The server's switch as last read; a refresh happens with every list and run. */
    enabled: (): boolean => state.enabled,
    /** Resolves once the server has it; a refusal is his to read. */
    setEnabled: async (on: boolean): Promise<void> => {
      await input.call("syncSetEnabled", { on });
      state = { ...state, enabled: on };
    },
    run,
    migrate,
    /** The servers the window is connected to (the last list when it is closed), paired where this server holds a credential. */
    peers: async (): Promise<ReadonlyArray<SyncPeer>> => {
      const listed = (await input.call("syncPeers", {}).catch(() => null)) as ReadonlyArray<{
        environmentId: string;
        label: string;
        local: boolean;
      }> | null;
      const held = new Map((await readState()).peers.map((peer) => [peer.environmentId, peer]));
      const rows = listed ?? lastPeers;
      lastPeers = rows.map((p) => {
        const peer = held.get(p.environmentId);
        const live = peer !== undefined && peer.expiresAt > now();
        return {
          environmentId: p.environmentId,
          label: p.label,
          local: p.local,
          paired: p.local || live,
          ...(live ? { expiresAt: peer.expiresAt } : {}),
        };
      });
      return lastPeers;
    },
    /** A one-time code for another machine to pair with this app's own server; it expires in minutes. */
    issue: async (): Promise<string> =>
      ((await input.call("syncPair", {})) as { code: string }).code,
    /** Trades that server's one-time code for its sync-only credential, and hands it to this app's own server. */
    link: async (environmentId: string, code: string): Promise<void> => {
      const out = (await input.call("syncLink", { environmentId, code })) as PeerCredential;
      const label =
        lastPeers.find((p) => p.environmentId === environmentId)?.label ?? environmentId;
      await input.call("syncAddPeer", { environmentId, label, ...out });
      await readState();
    },
    /** Drops that server's credential here; revoking it there ("Tessaya memory sync" in Sharing & access) ends it. */
    forget: async (environmentId: string): Promise<void> => {
      await input.call("syncForget", { environmentId });
      state = { ...state, peers: state.peers.filter((p) => p.environmentId !== environmentId) };
    },
    /** The server runs the rounds; this moves an older build's credentials there and reads the switch. */
    start: (): (() => void) => {
      void migrate()
        .catch(() => undefined)
        .then(readState);
      return () => undefined;
    },
  };
};

export type MemorySync = ReturnType<typeof createMemorySync>;
