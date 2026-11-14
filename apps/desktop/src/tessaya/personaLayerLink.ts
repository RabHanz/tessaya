// @effect-diagnostics globalTimers:off
/**
 * The desktop's side of an owner-only persona layer (server: src/tessaya/PersonaLayers.ts): it tells the local server
 * when the screen locks, the machine sleeps or another app takes the camera or microphone, which ends a private
 * session, and keeps every window out of capture while one is open. On a server with no layer the route answers 404
 * and the link stops for good, so a public build sends one request and nothing more.
 */
export interface LayerLinkDeps {
  /** Posts a report; null when the server has no layer here. */
  readonly post: (body: {
    readonly key?: string;
    readonly signals: ReadonlyArray<string>;
  }) => Promise<{ readonly open: boolean } | null>;
  /** The device key, created and kept by the OS keystore on first use; null where none is available. */
  readonly deviceKey: () => string | null;
  /** Whether another app has the camera or microphone right now (a call or a recording). */
  readonly othersCapturing: () => Promise<boolean>;
  readonly shield: (on: boolean) => void;
  readonly everyMs?: number;
}

export const startPersonaLayerLink = (deps: LayerLinkDeps) => {
  let stopped = false;
  let open = false;
  let knownHere = false;
  const pending = new Set<string>();
  const tick = async (signal?: string) => {
    if (stopped) return;
    if (signal !== undefined) pending.add(signal);
    if (open && (await deps.othersCapturing().catch(() => false))) pending.add("call");
    // The key is made only once the server is known to have a layer, so a public build never makes one.
    const key = knownHere ? deps.deviceKey() : null;
    const sent = [...pending];
    const answer = await deps
      .post({ ...(key === null ? {} : { key }), signals: sent })
      .catch(() => undefined);
    if (answer === undefined) return;
    if (answer === null) return stop();
    for (const s of sent) pending.delete(s);
    if (answer.open !== open) {
      open = answer.open;
      deps.shield(open);
    }
    if (!knownHere) {
      knownHere = true;
      await tick();
    }
  };
  const timer = setInterval(() => void tick(), deps.everyMs ?? 10_000);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (open) deps.shield(false);
    open = false;
  };
  return {
    /** Settles once the first report (and, on a server with a layer, the first keyed one) is answered. */
    ready: tick(),
    signal: (kind: string) => tick(kind),
    stop,
    isOpen: () => open,
  };
};

/**
 * Windows' record of which apps use the camera or microphone (`reg query ...\ConsentStore\<webcam|microphone> /s`):
 * an app is using it now when it started and has not stopped. This app's own folder (its voice sidecar) never counts.
 */
export const capturingApps = (regOutput: string, ownDir: string): ReadonlyArray<string> => {
  const own = ownDir.replaceAll("\\", "#").toLowerCase();
  const busy: Array<string> = [];
  let key: string | null = null;
  let start = false;
  let stop = false;
  const flush = () => {
    if (key !== null && start && !stop && !key.toLowerCase().includes(own)) busy.push(key);
  };
  for (const line of regOutput.split(/\r?\n/)) {
    if (line.startsWith("HKEY_")) {
      flush();
      key = line.trim();
      start = false;
      stop = false;
      continue;
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i.exec(line);
    if (m === null) continue;
    if (m[1] === "LastUsedTimeStart") start = m[2] !== "0";
    else stop = m[2] !== "0";
  }
  flush();
  return busy;
};
