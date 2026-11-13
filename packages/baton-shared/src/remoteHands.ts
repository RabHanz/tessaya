// @effect-diagnostics globalTimers:off
/**
 * Remote hands (docs/baton/REMOTE_HANDS.md): a remote session asks, the desktop does, and the server only brokers: it
 * checks the tool, holds the call for the desktop's long poll (the desktop owns the gate), and passes back the answer. A
 * brain turn's call reaches only the tools the desktop published, and names its turn for the gate.
 */

/** What a remote session may ask for: the hands, a window picture, and a few operations on the app. */
export const REMOTE_HANDS_TOOLS: ReadonlySet<string> = new Set([
  "ui_tree",
  "click_element",
  "act_batch",
  "wait_for",
  "window_capture",
  "type_text",
  "press_keys",
  "app_version",
  "log_tail",
  "process_list",
  "process_stop",
  "app_update",
  "open_page",
]);

export const ARGS_MAX_BYTES = 20_000;
export const CALL_TIMEOUT_MS = 60_000;
/** The desktop counts as listening if it asked for work this recently. */
export const HOST_LISTENING_MS = 45_000;
const AUDIT_KEEP = 200;

/** A tool the desktop offers a brain turn, as it publishes it. */
export interface HandsToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

/** The turn a brain call came from: the vessel that heard it and whose words they were. */
export interface HandsOrigin {
  readonly label: string;
  readonly hisVoice: boolean;
  readonly member: string | null;
  readonly assurance: number;
  readonly tainted: boolean;
}

export interface HandsCall {
  readonly id: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly session: string;
  /** Set for a brain turn's call; absent for a remote session's. */
  readonly origin?: HandsOrigin;
}

const SPECS_MAX = 64;
const SPEC_MAX_BYTES = 8_000;

/** What a desktop published, kept only where each spec has a name, a description and a schema of sane size. */
export const publishedSpecs = (raw: unknown): ReadonlyArray<HandsToolSpec> | null => {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, SPECS_MAX).flatMap((s: unknown): ReadonlyArray<HandsToolSpec> => {
    if (typeof s !== "object" || s === null) return [];
    const { name, description, input_schema } = s as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(name) ||
      typeof description !== "string" ||
      typeof input_schema !== "object" ||
      input_schema === null ||
      JSON.stringify(s).length > SPEC_MAX_BYTES
    )
      return [];
    return [{ name, description, input_schema: input_schema as Record<string, unknown> }];
  });
};

export interface HandsResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly images?: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
  readonly error?: string;
}

export interface HandsAudit {
  readonly at: number;
  readonly session: string;
  readonly tool: string;
  /** Short and never the text typed: its length only. */
  readonly what: string;
  readonly outcome: "done" | "refused" | "failed" | "timeout" | "not-listening";
  readonly ms: number;
}

/** Arguments for the log, without anything typed or secret. */
export const auditWhat = (tool: string, args: Readonly<Record<string, unknown>>): string => {
  const parts = Object.entries(args).map(([k, v]) =>
    k === "text" && typeof v === "string"
      ? `text(${v.length} chars)`
      : k === "steps" && Array.isArray(v)
        ? `steps(${v.length})`
        : `${k}=${JSON.stringify(v).slice(0, 60)}`,
  );
  return `${tool} ${parts.join(" ")}`.slice(0, 200);
};

export const createHandsBroker = (input: {
  readonly now: () => number;
  readonly newId: () => string;
  readonly callTimeoutMs?: number;
  readonly onAudit?: (entry: HandsAudit) => void;
}) => {
  const timeoutMs = input.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const queue: HandsCall[] = [];
  const waiting = new Map<string, (r: HandsResult) => void>();
  let taker: ((c: HandsCall | null) => void) | null = null;
  let lastTake = Number.NEGATIVE_INFINITY;
  const audit: HandsAudit[] = [];
  let published: ReadonlyArray<HandsToolSpec> = [];

  const record = (entry: HandsAudit) => {
    audit.push(entry);
    if (audit.length > AUDIT_KEEP) audit.shift();
    input.onAudit?.(entry);
  };
  const connected = () => input.now() - lastTake < HOST_LISTENING_MS;

  /** The desktop's long poll: resolves with the next call, or null after `waitMs`. `tools` replaces what it offers. */
  const take = (
    waitMs: number,
    tools?: ReadonlyArray<HandsToolSpec>,
  ): Promise<HandsCall | null> => {
    lastTake = input.now();
    if (tools !== undefined) published = tools;
    const next = queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => {
      taker?.(null);
      const timer = setTimeout(() => {
        taker = null;
        resolve(null);
      }, waitMs);
      taker = (c) => {
        clearTimeout(timer);
        taker = null;
        lastTake = input.now();
        resolve(c);
      };
    });
  };

  const call = (
    session: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    origin?: HandsOrigin,
  ): Promise<HandsResult> => {
    const started = input.now();
    const what = auditWhat(tool, args);
    const finish = (outcome: HandsAudit["outcome"], result: HandsResult): HandsResult => {
      record({ at: started, session, tool, what, outcome, ms: input.now() - started });
      return result;
    };
    // A remote session reaches only the hands; a brain turn, only what the desktop offers.
    if (
      origin === undefined
        ? !REMOTE_HANDS_TOOLS.has(tool)
        : !published.some((spec) => spec.name === tool)
    ) {
      return Promise.resolve(
        finish("refused", {
          ok: false,
          error:
            origin === undefined
              ? `${tool} is not a remote hands tool.`
              : `The desktop does not offer ${tool}.`,
        }),
      );
    }
    if (JSON.stringify(args).length > ARGS_MAX_BYTES) {
      return Promise.resolve(
        finish("refused", { ok: false, error: "The arguments are too large." }),
      );
    }
    if (!connected()) {
      return Promise.resolve(
        finish("not-listening", {
          ok: false,
          error: "The desktop app is not listening for remote hands.",
        }),
      );
    }
    const id = input.newId();
    const item: HandsCall = {
      id,
      tool,
      args,
      session,
      ...(origin === undefined ? {} : { origin }),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        // Told "timeout", the caller may retry: a late run would type into whatever has focus then.
        const queued = queue.indexOf(item);
        if (queued >= 0) queue.splice(queued, 1);
        resolve(finish("timeout", { ok: false, error: "The desktop did not answer in time." }));
      }, timeoutMs);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(finish(r.ok ? "done" : "failed", r));
      });
      if (taker !== null) taker(item);
      else queue.push(item);
    });
  };

  const reply = (id: string, result: HandsResult): boolean => {
    const done = waiting.get(id);
    if (done === undefined) return false;
    waiting.delete(id);
    done(result);
    return true;
  };

  return {
    call,
    take,
    reply,
    connected,
    /** What the desktop offers a brain turn now; nothing while it is not listening. */
    published: (): ReadonlyArray<HandsToolSpec> => (connected() ? published : []),
    audit: () => [...audit],
  };
};

export type HandsBroker = ReturnType<typeof createHandsBroker>;

/** Ids the ops tools handed out, so `process_stop` can only stop what `process_list` showed. */
export const createHandleRegistry = <T>(newId: () => string) => {
  const items = new Map<string, T>();
  return {
    add: (value: T): string => {
      const id = newId();
      items.set(id, value);
      return id;
    },
    get: (id: string): T | undefined => items.get(id),
    clear: () => items.clear(),
  };
};
