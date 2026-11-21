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
    readonly world?: { readonly fullscreen: boolean; readonly opened?: boolean };
  }) => Promise<{
    readonly open: boolean;
    readonly page: string | null;
    /** The persona its open session was opened with: only that companion takes the private form (M-122). */
    readonly persona?: string | null;
  } | null>;
  /** Her desk world now, sent with each report: a full-screen app in front keeps her own wishes out of his way. */
  readonly world?: () => { readonly fullscreen: boolean; readonly opened?: boolean };
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
  let page: string | null = null;
  let persona: string | null = null;
  const pending = new Set<string>();
  const tick = async (signal?: string) => {
    if (stopped) return;
    if (signal !== undefined) pending.add(signal);
    if (open && (await deps.othersCapturing().catch(() => false))) pending.add("call");
    // The key is made only once the server is known to have a layer, so a public build never makes one.
    const key = knownHere ? deps.deviceKey() : null;
    const sent = [...pending];
    const answer = await deps
      .post({
        ...(key === null ? {} : { key }),
        signals: sent,
        ...(deps.world === undefined ? {} : { world: deps.world() }),
      })
      .catch(() => undefined);
    if (answer === undefined) return;
    if (answer === null) return stop();
    for (const s of sent) pending.delete(s);
    page = answer.page;
    persona = answer.open ? (answer.persona ?? null) : null;
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
    /** Reports now, with no signal: what changed in her world reaches the server at once. */
    report: () => tick(),
    stop,
    isOpen: () => open,
    /** The layer's own page on this server (its path), or null where there is none. */
    page: () => page,
    /** Who the open session is with, or null (none open, or the layer doesn't say). */
    persona: () => persona,
  };
};

/**
 * Closing his private window ends the private moment there (Director's call, 19 Nov; at once, 21 Nov): when the last
 * one closes, her private form leaves the desk and `end` runs, on that call.
 */
export const createWindowCloseEnd = (deps: {
  readonly end: () => void;
  /** His last private window closed (or crashed), or one came back: her private form on the desk goes, or returns (M-122). */
  readonly shown?: (on: boolean) => void;
}) => {
  let open = 0;
  return {
    opened: () => {
      open += 1;
      if (open === 1) deps.shown?.(true);
    },
    closed: () => {
      if (open === 0) return;
      open -= 1;
      if (open > 0) return;
      deps.shown?.(false);
      deps.end();
    },
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

/**
 * Windows Hello for a layer page that asked (it opens `<page>/hello?for=<chat|viewer|lab>`, which the app catches): on
 * a verified Hello this app itself sends the step-up, so the page never claims Hello; anything else sends nothing and
 * the page keeps its PIN. One prompt at a time.
 */
export const createLayerHello = (deps: {
  readonly hello: () => Promise<"verified" | "declined" | "unavailable">;
  /** The layer's POST `op`, on this desktop's session; the answer's JSON, or null when it refused. */
  readonly post: (op: string, body: unknown) => Promise<Record<string, unknown> | null>;
  /** This Windows account (`host\\user`), which the household maps to him. */
  readonly account: string;
}) => {
  let busy = false;
  return async (kind: string): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    try {
      if ((await deps.hello()) !== "verified") return false;
      const stepUp = { hello: deps.account };
      if (kind === "lab") return (await deps.post("unlock", { stepUp })) !== null;
      const w = await deps.post("window", { surface: "desktop" });
      if (typeof w?.["vessel"] !== "string") return false;
      return (
        (await deps.post("activate", { surface: "desktop", vessel: w["vessel"], stepUp })) !== null
      );
    } finally {
      busy = false;
    }
  };
};
