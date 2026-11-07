// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
/**
 * The catalog service against the real thing: Baton's window asks the T3 sidebar, which asks every connected
 * environment's server (the `baton.sessions.*` methods), and answers with plain JSON. A resume can take most of a
 * minute on the machine, so it waits longer than a click does and, when the server says "resuming", watches the list
 * until the session is running.
 */
import type { CatalogRow, CatalogService, CatalogState } from "./catalogRows.ts";
import type { SessionsBridge } from "./sessionsBridge.ts";

const RESUME_WAIT_MS = 70_000;
const LIST_WAIT_MS = 15_000;
const OPEN_WAIT_MS = 30_000;
const WATCH_MS = 3_000;
// A long conversation takes minutes to bring in as a thread; the row says "Importing" while this watches.
const WATCH_FOR_MS = 15 * 60_000;

const STATES: ReadonlyArray<CatalogState> = ["running", "stopped", "resuming", "failed"];
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Rows from the sidebar's JSON; anything malformed is dropped rather than shown as "undefined". */
export const rowsFromAnswer = (json: string): ReadonlyArray<CatalogRow> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: CatalogRow[] = [];
  for (const raw of parsed as ReadonlyArray<Record<string, unknown>>) {
    const sessionId = asString(raw["id"]);
    const environmentId = asString(raw["environmentId"]);
    const state = raw["state"] as CatalogState;
    if (sessionId === null || environmentId === null || !STATES.includes(state)) continue;
    const cwd = asString(raw["cwd"]) ?? "";
    rows.push({
      id: `${environmentId}:${sessionId}`,
      sessionId,
      environmentId,
      machine: asString(raw["machine"]) ?? environmentId,
      project: asString(raw["project"]) ?? cwd.split(/[\\/]/).at(-1) ?? "",
      cwd,
      title: asString(raw["title"]) ?? sessionId,
      lastActivityAt: asString(raw["lastActivityAt"]),
      account: asString(raw["account"]),
      state,
      source: raw["source"] === "history" ? "history" : "thread",
      canResume: raw["canResume"] === true,
      detail: asString(raw["detail"]),
      ...(raw["local"] === true ? { local: true } : {}),
      pane: asString(raw["pane"]),
      answeredBy: asString(raw["answeredBy"]),
      ...(typeof raw["waiting"] === "number" ? { waiting: raw["waiting"] } : {}),
      ...(raw["crashed"] === true ? { crashed: true } : {}),
      ...(asString(raw["threadId"]) === null ? {} : { threadId: asString(raw["threadId"])! }),
    });
  }
  return rows;
};

/** The server's plain reason from a failed answer's JSON, or null. */
export const reasonOf = (json: string): string | null => {
  try {
    const detail = (JSON.parse(json) as { detail?: unknown }).detail;
    return typeof detail === "string" && detail !== "" ? detail : null;
  } catch {
    return json.trim() === "" ? null : json.slice(0, 200);
  }
};

export const createBridgeCatalogService = (input: {
  readonly bridge: SessionsBridge;
  readonly openMainWindow: () => void;
  readonly wait?: (ms: number) => Promise<void>;
  /** Where the archived thread ids are written, so the clean-up can be undone. */
  readonly saveCleanupList?: (json: string) => void;
  /** One structured line for the resume record (baton-lifecycle.ndjson). */
  readonly note?: (event: string, detail: Record<string, unknown>) => void;
}): CatalogService => {
  const wait = input.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Where a resumed session's thread is, when the server made one (a machine with no Herdr). */
  const threads = new Map<string, string>();
  const list = async (query: string, background?: boolean) => {
    const answer = await input.bridge.request(
      { kind: "catalogList", query, ...(background === true ? { background: true } : {}) },
      LIST_WAIT_MS,
    );
    if (answer === null) throw new Error("The sessions view did not answer.");
    return rowsFromAnswer(answer.detail);
  };
  const service: CatalogService = {
    list,
    stop: async (row) => {
      const answer = await input.bridge.request(
        { kind: "catalogStop", environmentId: row.environmentId, sessionId: row.sessionId },
        LIST_WAIT_MS,
      );
      if (answer === null || !answer.ok) throw new Error("not stopped");
    },
    autoResume: async (action) => {
      const answer = await input.bridge.request(
        { kind: "catalogAutoResume", action },
        LIST_WAIT_MS,
      );
      if (answer === null) throw new Error("The sessions view did not answer.");
      return (JSON.parse(answer.detail) as { enabled?: boolean }).enabled === true;
    },
    cleanup: async (apply) => {
      const answer = await input.bridge.request({ kind: "catalogCleanup", apply }, LIST_WAIT_MS);
      if (answer === null) throw new Error("The sessions view did not answer.");
      const parsed = JSON.parse(answer.detail) as ReadonlyArray<{
        machine: string;
        failed: boolean;
        found?: ReadonlyArray<unknown>;
        left?: ReadonlyArray<unknown>;
        archived?: ReadonlyArray<string>;
      }>;
      // The archived ids are kept so the clean-up can be undone.
      if (apply) input.saveCleanupList?.(JSON.stringify(parsed, null, 2));
      return parsed.map((m) => ({
        machine: m.machine,
        failed: m.failed,
        found: m.found?.length ?? 0,
        left: m.left?.length ?? 0,
        archived: m.archived?.length ?? 0,
      }));
    },
    reattach: async (row, confirmPane) => {
      const answer = await input.bridge.request(
        {
          kind: "catalogReattach",
          environmentId: row.environmentId,
          sessionId: row.sessionId,
          cwd: row.cwd || null,
          ...(confirmPane === undefined ? {} : { confirmPane }),
        },
        LIST_WAIT_MS,
      );
      if (answer === null) throw new Error("The sessions view did not answer.");
      const parsed = JSON.parse(answer.detail) as {
        state?: unknown;
        pane?: unknown;
        detail?: unknown;
      };
      return {
        state: typeof parsed.state === "string" ? parsed.state : "failed",
        pane: asString(parsed.pane),
        detail: asString(parsed.detail) ?? "",
      };
    },
    resume: async (row) => {
      const answer = await input.bridge.request(
        {
          kind: "catalogResume",
          environmentId: row.environmentId,
          sessionId: row.sessionId,
          cwd: row.cwd || null,
        },
        RESUME_WAIT_MS,
      );
      if (answer === null)
        throw new Error("The sessions view did not answer. Open T3 and try again.");
      if (!answer.ok) throw new Error(reasonOf(answer.detail) ?? "not resumed");
      // "resuming" means the server is still bringing it back: watch the list until it is running.
      let state: unknown;
      try {
        const result = JSON.parse(answer.detail) as { state?: unknown; threadId?: unknown };
        state = result.state;
        if (typeof result.threadId === "string") threads.set(row.id, result.threadId);
      } catch {
        state = "running";
      }
      for (let waited = 0; state === "resuming" && waited < WATCH_FOR_MS; waited += WATCH_MS) {
        await wait(WATCH_MS);
        const now = (await list("")).find((r) => r.id === row.id);
        state = now?.state ?? "running";
        if (now?.threadId !== undefined) threads.set(row.id, now.threadId);
        if (state === "failed") throw new Error(now?.detail ?? "not resumed");
      }
      if (state === "failed") throw new Error("not resumed");
      if (state === "resuming")
        throw new Error(
          "Bringing that conversation in is taking longer than 15 minutes. Try Resume again later.",
        );
    },
    create: async ({ environmentId, cwd, model, effort, message }) => {
      const answer = await input.bridge.request(
        {
          kind: "catalogCreate",
          environmentId,
          cwd,
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(message === undefined ? {} : { message }),
        },
        RESUME_WAIT_MS,
      );
      if (answer === null)
        throw new Error("The sessions view did not answer. Open T3 and try again.");
      if (!answer.ok)
        throw new Error(reasonOf(answer.detail) ?? "That session could not be started there.");
      // A machine with no Herdr starts a thread: show it.
      try {
        const threadId = (JSON.parse(answer.detail) as { threadId?: unknown }).threadId;
        if (typeof threadId === "string") {
          input.openMainWindow();
          void input.bridge.request({ kind: "open", environmentId, threadId }, OPEN_WAIT_MS);
        }
      } catch {
        // The session is started either way.
      }
    },
    kept: async (row, discard) => {
      const answer = await input.bridge.request(
        {
          kind: "catalogWaiting",
          environmentId: row.environmentId,
          sessionId: row.sessionId,
          ...(discard === undefined ? {} : { discard }),
        },
        LIST_WAIT_MS,
      );
      if (answer === null || !answer.ok)
        throw new Error(answer === null ? "The sessions view did not answer." : answer.detail);
      const found = JSON.parse(answer.detail) as { messages?: unknown; sending?: unknown };
      return {
        messages: Array.isArray(found.messages)
          ? found.messages.filter((m): m is string => typeof m === "string")
          : [],
        sending: found.sending === true,
      };
    },
    folders: async (environmentId) => {
      const answer = await input.bridge.request(
        { kind: "catalogFolders", environmentId },
        LIST_WAIT_MS,
      );
      try {
        const parsed: unknown = JSON.parse(answer?.detail ?? "[]");
        return Array.isArray(parsed)
          ? parsed.filter((f): f is string => typeof f === "string")
          : [];
      } catch {
        return [];
      }
    },
    // The thread opens in T3's own window; a resumed session's own thread is selected there when the server made one.
    open: async (row) => {
      input.openMainWindow();
      const threadId = row.threadId ?? threads.get(row.id);
      if (threadId === undefined)
        throw new Error("This session has no thread in T3 yet. Press Resume again.");
      const answer = await input.bridge.request(
        { kind: "open", environmentId: row.environmentId, threadId },
        OPEN_WAIT_MS,
      );
      if (answer === null) throw new Error("T3 did not answer. Open the T3 window and try again.");
      if (!answer.ok) throw new Error(reasonOf(answer.detail) ?? answer.detail);
    },
  };
  // Every resume and open leaves a line a user can read: which session, how long, and the outcome.
  const note = input.note ?? (() => undefined);
  const timed = async (event: string, row: CatalogRow, run: () => Promise<void>): Promise<void> => {
    const startedAt = Date.now();
    const base = { sessionId: row.sessionId, folder: row.cwd, environmentId: row.environmentId };
    try {
      await run();
      note(event, {
        ...base,
        outcome: "ok",
        threadId: row.threadId ?? threads.get(row.id) ?? null,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      note(event, {
        ...base,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - startedAt,
      });
      throw error;
    }
  };
  return {
    ...service,
    resume: (row) => timed("resume", row, () => service.resume(row)),
    open: (row) => timed("resume-open", row, async () => service.open(row)),
  };
};
