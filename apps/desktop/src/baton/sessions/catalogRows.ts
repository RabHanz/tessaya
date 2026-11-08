// @effect-diagnostics globalTimers:off globalDate:off
/**
 * The Sessions browser (the Director's "resume and continue any claude session in any folder on any environment"):
 * one list of every session on every connected environment, running or stopped, with search and filters, a one-tap
 * Resume, and New session in a folder on a machine. The rows come from a CatalogService (the server's session
 * catalog); this file holds the shape the window needs, the pure rows, and the small state machine for a resume.
 */
import { bindingOf } from "@t3tools/baton-shared/liveThread";

import type { HomeControl, HomeOption } from "../home/batonHome.ts";

export type CatalogState = "running" | "stopped" | "resuming" | "failed";

export interface CatalogRow {
  readonly id: string;
  /** The Claude session id on that machine (`id` is unique across machines). */
  readonly sessionId: string;
  /** Why it cannot be resumed, or why it failed, in plain words. */
  readonly detail: string | null;
  readonly environmentId: string;
  /** The machine's display name. */
  readonly machine: string;
  readonly project: string;
  readonly cwd: string;
  readonly title: string;
  readonly lastActivityAt: string | null;
  readonly account: string | null;
  readonly state: CatalogState;
  /** A live thread, or an old session found in the history index. */
  readonly source: "thread" | "history";
  readonly canResume: boolean;
  /** The row is on the computer this app runs on. */
  readonly local?: boolean;
  /** Where a resumed session lives, when the server has made the thread. */
  readonly threadId?: string;
  /** A turn runs in the thread a resume brought back. */
  readonly turnRunning?: boolean;
  /** The Herdr pane a running session is in. */
  readonly pane?: string | null;
  /** The provider instance answering its thread; not `baton-live` means a handoff session. */
  readonly answeredBy?: string | null;
  /** Messages it keeps until it can take them. */
  readonly waiting?: number;
  /** Stopped because it died mid-turn and was not brought back. */
  readonly crashed?: boolean;
}

export interface KeptMessages {
  readonly messages: ReadonlyArray<string>;
  /** Being sent right now, so none can be discarded until that ends. */
  readonly sending: boolean;
}

export interface CatalogService {
  readonly list: (query: string, background?: boolean) => Promise<ReadonlyArray<CatalogRow>>;
  /** Ends a running session and keeps it stopped (the watchdog leaves it alone). */
  readonly stop?: (row: CatalogRow) => Promise<void>;
  /** The Auto-resume switch: its state, or turn it on or off everywhere. */
  readonly autoResume?: (action: "status" | "on" | "off") => Promise<boolean>;
  /** Helper threads on every machine: what there is (apply false), or archives them (true). */
  readonly cleanup?: (apply: boolean) => Promise<ReadonlyArray<CleanupMachine>>;
  /** Binds the session's thread to its running session again; "confirm" carries the one pane it would use. */
  readonly reattach?: (
    row: CatalogRow,
    confirmPane?: string,
  ) => Promise<{ readonly state: string; readonly pane: string | null; readonly detail: string }>;
  /** Makes the thread live; resolves when it is. */
  readonly resume: (row: CatalogRow) => Promise<void>;
  readonly create: (target: {
    environmentId: string;
    cwd: string;
    model?: string;
    effort?: string;
    message?: string;
  }) => Promise<void>;
  /** Recent folders on a machine, for the New session box. */
  readonly folders: (environmentId: string) => Promise<ReadonlyArray<string>>;
  /** Opens a live session's thread. */
  readonly open: (row: CatalogRow) => void | Promise<void>;
  /** The messages it keeps; `discard` drops one, named by place and text. */
  readonly kept?: (
    row: CatalogRow,
    discard?: { readonly index: number; readonly text: string },
  ) => Promise<KeptMessages>;
}

export interface CleanupMachine {
  readonly machine: string;
  readonly failed: boolean;
  readonly found: number;
  readonly left: number;
  readonly archived: number;
}

export interface CatalogView {
  readonly query: string;
  readonly machine: string;
  readonly state: "all" | "running" | "stopped";
  readonly shown: number;
  /** Show background runs too. */
  readonly background: boolean;
  readonly creating: boolean;
  readonly newMachine: string;
}

export const CATALOG_PAGE = 25;

export const INITIAL_VIEW: CatalogView = {
  query: "",
  machine: "all",
  state: "all",
  shown: CATALOG_PAGE,
  background: false,
  creating: false,
  newMachine: "",
};

const STATE_WORDS: Readonly<Record<CatalogState, string>> = {
  running: "Running",
  stopped: "Stopped",
  resuming: "Importing history...",
  failed: "Could not resume",
};

/** "5 min ago", "3 h ago", "yesterday", "12 d ago". */
export const agoWords = (iso: string | null, now: number): string => {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} d ago`;
};

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word typed is somewhere in the title, project, folder, machine or account. */
export const matches = (row: CatalogRow, query: string): boolean => {
  const hay =
    `${row.title} ${row.project} ${row.cwd} ${row.machine} ${row.account ?? ""}`.toLowerCase();
  return words(query).every((w) => hay.includes(w));
};

export const visibleRows = (
  rows: ReadonlyArray<CatalogRow>,
  view: CatalogView,
): ReadonlyArray<CatalogRow> =>
  rows
    .filter(
      (r) =>
        matches(r, view.query) &&
        (view.machine === "all" || r.environmentId === view.machine) &&
        (view.state === "all" || (view.state === "running") === (r.state === "running")),
    )
    .toSorted(
      (a, b) =>
        (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0),
    );

const WORDS = {
  search: "Search sessions, folders and machines",
  new: "New session",
  newTitle: "Start a new session",
  startNew: "Start new session",
  recent: "Recent folders",
  earlier: "earlier sessions here",
  latest: "Resume latest",
  startFresh: "Start new",
  background: "Show background runs",
  tidy: "Clean up helper threads",
  autoResume: "Auto-resume",
  autoResumeHint: "Brings back a session that stopped in the middle of a turn",
  stop: "Stop",
  keptSending: "Being sent now; discard is back when that ends.",
  discard: "Discard",
  tidyApply: "Archive them",
  resumeHint: "Continues this conversation with its full history",
  machine: "Machine",
  folder: "Folder, for example C:\\work\\project",
  model: "Model",
  effort: "Effort",
  message: "First message (optional)",
  cancel: "Cancel",
  more: "Show more",
} as const;

const runningBinding = (r: CatalogRow) => bindingOf({ ...r, source: "live" });

export const catalogControls = (input: {
  readonly rows: ReadonlyArray<CatalogRow>;
  readonly view: CatalogView;
  readonly now: number;
  readonly folders: ReadonlyArray<string>;
  readonly status: string;
  readonly loaded: boolean;
  readonly tidyFound?: number;
  readonly autoResume?: boolean | null;
  /** Rows whose Reattach found one other running pane and waits for his yes: row id -> pane. */
  readonly reattachOffers?: ReadonlyMap<string, string>;
  readonly kept?: ReadonlyMap<string, KeptMessages>;
}): ReadonlyArray<HomeControl> => {
  const { rows, view } = input;
  const reattachOffers = input.reattachOffers ?? new Map<string, string>();
  const machines: HomeOption[] = [{ value: "all", label: "All machines" }];
  for (const r of rows)
    if (!machines.some((m) => m.value === r.environmentId))
      machines.push({
        value: r.environmentId,
        label: r.local === true ? `${r.machine} (this computer)` : r.machine,
      });
  const shownRows = visibleRows(rows, view);
  const states: HomeOption[] = [
    { value: "all", label: "All" },
    { value: "running", label: "Running" },
    { value: "stopped", label: "Stopped" },
  ];
  // Folders that already hold stopped sessions: the form says so, so Resume and Start new are never confused.
  const earlierByFolder = new Map<string, { cwd: string; count: number; id: string }>();
  for (const r of rows.toSorted(
    (a, b) => (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0),
  )) {
    if (r.state === "running" || !r.canResume || r.cwd === "") continue;
    const key = r.cwd.toLowerCase().replace(/[\\/]+$/, "");
    const have = earlierByFolder.get(key);
    earlierByFolder.set(
      key,
      have === undefined ? { cwd: r.cwd, count: 1, id: r.id } : { ...have, count: have.count + 1 },
    );
  }
  const bar: HomeControl = {
    id: "c.bar",
    section: "Sessions",
    label: input.loaded ? `${shownRows.length} of ${rows.length} sessions` : "Loading sessions",
    kind: "catalogBar",
    lead: true,
    query: view.query,
    machine: view.machine,
    stateFilter: view.state,
    machines,
    states,
    words: WORDS,
    creating: view.creating,
    // New session starts on the computer the app runs on unless he picks another.
    newMachine:
      view.newMachine ||
      rows.find((r) => r.local === true)?.environmentId ||
      machines[1]?.value ||
      "",
    folders: input.folders,
    earlierHere: [...earlierByFolder.values()],
    background: view.background,
    tidyFound: input.tidyFound ?? 0,
    autoResume: input.autoResume ?? null,
    models: [
      { value: "", label: "Default model" },
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet" },
    ],
    efforts: [
      { value: "", label: "Default effort" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "max", label: "Max" },
    ],
    status: input.status,
    remaining: Math.max(0, shownRows.length - view.shown),
  };
  const list = shownRows.slice(0, view.shown).map((r): HomeControl => ({
    id: `c:${r.id}`,
    section: "Sessions",
    label: r.title,
    kind: "catalogRow",
    project: r.project,
    machine: r.machine,
    when: agoWords(r.lastActivityAt, input.now),
    state: r.state,
    stateLabel: r.state === "stopped" && r.crashed === true ? "Crashed" : STATE_WORDS[r.state],
    resumeLabel:
      r.state === "stopped" || r.state === "failed" ? (r.canResume ? "Resume" : null) : null,
    note: (r.state === "stopped" || r.state === "failed") && r.canResume ? WORDS.resumeHint : "",
    // A resumed thread with no turn running has nothing to stop.
    stopLabel:
      r.state === "running" && (r.threadId === undefined || !!r.pane || r.turnRunning === true)
        ? WORDS.stop
        : null,
    source: r.detail ?? (r.source === "history" ? "From history" : ""),
    // A stopped row says "Stopped" already.
    // A session resumed as a T3 thread (no Herdr) is that thread, not a plain terminal.
    binding:
      r.state !== "running"
        ? ""
        : r.threadId !== undefined && !r.pane
          ? "T3 thread"
          : (runningBinding(r)?.text ?? ""),
    reattachLabel:
      r.state === "running" && runningBinding(r)?.kind === "handoff"
        ? reattachOffers.has(r.id)
          ? `Reattach to ${reattachOffers.get(r.id)}?`
          : "Reattach"
        : null,
    keptLabel:
      (r.waiting ?? 0) > 0 ? `${r.waiting} kept message${r.waiting === 1 ? "" : "s"}` : null,
    kept: input.kept?.get(r.id)?.messages ?? null,
    keptNote: input.kept?.get(r.id)?.sending === true ? WORDS.keptSending : "",
    discardLabel: WORDS.discard,
  }));
  return [bar, ...list];
};

const KEPT_RECHECK_MS = 2_000;

/** The window's side of the catalog: the rows, the view, and a resume that shows "Resuming..." until it is live. */
export const createCatalog = (input: {
  readonly service: CatalogService;
  readonly onChange: () => void;
  readonly now?: () => number;
  /** Runs `run` after `ms`; tests run it when they choose. */
  readonly later?: (run: () => void, ms: number) => void;
}) => {
  const later = input.later ?? ((run: () => void, ms: number) => void setTimeout(run, ms));
  let rows: ReadonlyArray<CatalogRow> = [];
  let view = INITIAL_VIEW;
  let loaded = false;
  let status = "";
  // Running means the thread exists; if T3 cannot show it, say why and leave the title button as the retry.
  const openRow = async (row: CatalogRow): Promise<void> => {
    try {
      await input.service.open(row);
      status = `Opened "${row.title}" in T3.`;
      input.onChange();
    } catch (error: unknown) {
      status =
        error instanceof Error && error.message !== ""
          ? error.message
          : "T3 could not open that thread.";
      input.onChange();
    }
  };
  let folders: ReadonlyArray<string> = [];
  let tidyFound = 0;
  let autoResume: boolean | null = null;
  const reattachOffers = new Map<string, string>();
  /** Rows whose kept messages are open, with what the server last said. */
  const kept = new Map<string, KeptMessages>();
  const readKept = (row: CatalogRow, discard?: { index: number; text: string }) =>
    (input.service.kept?.(row, discard) ?? Promise.reject(new Error("no kept")))
      .then((found) => {
        if (found.messages.length === 0) kept.delete(row.id);
        else kept.set(row.id, found);
        set({ id: row.id, waiting: found.messages.length });
        // Mid-send the list changes as it goes; look again once it may have ended, while it is open.
        if (found.sending)
          later(() => {
            if (kept.has(row.id)) void readKept(row);
          }, KEPT_RECHECK_MS);
      })
      .catch(() => {
        status = "Its kept messages could not be read.";
        input.onChange();
      });
  const now = input.now ?? (() => Date.now());
  const set = (patch: Partial<CatalogRow> & { id: string }) => {
    rows = rows.map((r) => (r.id === patch.id ? { ...r, ...patch } : r));
    input.onChange();
  };
  const refresh = async () => {
    try {
      rows = await input.service.list("", view.background);
      autoResume = (await input.service.autoResume?.("status").catch(() => null)) ?? autoResume;
      status = "";
    } catch {
      status = "The session list is not reachable right now.";
    }
    loaded = true;
    input.onChange();
  };
  const loadFolders = async (environmentId: string) => {
    folders = await input.service.folders(environmentId).catch(() => []);
    input.onChange();
  };
  const wordsOf = (row: CatalogRow): string =>
    `${row.title} | ${row.project} on ${row.machine} | ${row.state}${row.canResume ? "" : " (cannot be resumed)"} | id ${row.sessionId}`;
  /** The same moves as the window, for the assistant: find, bring back, start. Each answers in plain words. */
  const tools = {
    find: async (query: string): Promise<string> => {
      const found = (await input.service.list(query).catch(() => null)) ?? rows;
      const hits = found.filter((r) => query.trim() === "" || matches(r, query)).slice(0, 15);
      return hits.length === 0 ? "No session matches that." : hits.map(wordsOf).join("\n");
    },
    resume: async (sessionId: string): Promise<string> => {
      const row = rows.find((r) => r.sessionId === sessionId);
      if (row === undefined) return "There is no session by that id. Use sessions_find.";
      if (row.state === "running") return `${row.title} is already running.`;
      if (!row.canResume) return row.detail ?? "That session cannot be resumed.";
      set({ id: row.id, state: "resuming" });
      try {
        await input.service.resume(row);
        set({ id: row.id, state: "running" });
        await openRow(row);
        return `${row.title} is running again on ${row.machine}.`;
      } catch {
        set({ id: row.id, state: "failed" });
        return `${row.title} could not be resumed on ${row.machine}.`;
      }
    },
    start: async (cwd: string, machine: string): Promise<string> => {
      const target = rows.find(
        (r) => machine === "" || r.machine.toLowerCase() === machine.toLowerCase(),
      )?.environmentId;
      if (target === undefined) return "I do not know that machine. Use sessions_find to see them.";
      try {
        await input.service.create({ environmentId: target, cwd });
        await refresh();
        return `A new session is starting in ${cwd}.`;
      } catch {
        return `A session could not be started in ${cwd}.`;
      }
    },
  };
  return {
    tools,
    refresh,
    controls: () =>
      catalogControls({
        rows,
        view,
        now: now(),
        folders,
        status,
        loaded,
        tidyFound,
        autoResume,
        reattachOffers,
        kept,
      }),
    /** An action from the window; true when it was the catalog's. */
    apply: (id: string, value: string | boolean | null): boolean => {
      if (!id.startsWith("c.") && !id.startsWith("c:")) return false;
      const text = typeof value === "string" ? value : "";
      if (id === "c.query") {
        view = { ...view, query: text, shown: CATALOG_PAGE };
        // The history index is only searched with words, so a typed query asks the service for more rows.
        if (text.trim().length >= 3)
          void input.service
            .list(text)
            .then((found) => {
              const have = new Set(rows.map((r) => r.id));
              rows = [...rows, ...found.filter((r) => !have.has(r.id))];
              input.onChange();
            })
            .catch(() => undefined);
      } else if (id === "c.autoResume") {
        const next = !(autoResume ?? false);
        autoResume = next;
        void (input.service.autoResume?.(next ? "on" : "off") ?? Promise.resolve(next))
          .then((now) => {
            autoResume = now;
            input.onChange();
          })
          .catch(() => {
            autoResume = !next;
            status = "Could not change Auto-resume.";
            input.onChange();
          });
      } else if (id === "c.background") {
        view = { ...view, background: !view.background, shown: CATALOG_PAGE };
        void refresh();
      } else if (id === "c.tidy" || id === "c.tidyApply") {
        const apply = id === "c.tidyApply";
        status = apply ? "Archiving helper threads..." : "Looking for helper threads...";
        void (input.service.cleanup?.(apply) ?? Promise.resolve([]))
          .then((machines) => {
            const found = machines.reduce((n, m) => n + m.found, 0);
            const left = machines.reduce((n, m) => n + m.left, 0);
            const archived = machines.reduce((n, m) => n + m.archived, 0);
            tidyFound = apply ? 0 : found;
            const where = machines
              .map((m) =>
                m.failed
                  ? `${m.machine}: no answer`
                  : `${m.machine}: ${apply ? m.archived : m.found}`,
              )
              .join(", ");
            status = apply
              ? `Archived ${archived} helper threads (${where}). They can be restored from T3's archive.`
              : `${found} helper threads to archive (${where})${left > 0 ? `; ${left} left alone` : ""}.`;
            input.onChange();
          })
          .catch(() => {
            status = "Could not reach the machines to clean up.";
            input.onChange();
          });
      } else if (id === "c.machine")
        view = { ...view, machine: text || "all", shown: CATALOG_PAGE };
      else if (id === "c.state")
        view = {
          ...view,
          state: text === "running" || text === "stopped" ? text : "all",
          shown: CATALOG_PAGE,
        };
      else if (id === "c.more") view = { ...view, shown: view.shown + CATALOG_PAGE };
      else if (id === "c.new") {
        view = { ...view, creating: !view.creating };
        if (view.creating)
          void loadFolders(
            view.newMachine ||
              rows.find((r) => r.local === true)?.environmentId ||
              rows[0]?.environmentId ||
              "",
          );
      } else if (id === "c.newMachine") {
        view = { ...view, newMachine: text };
        void loadFolders(text);
      } else if (id === "c.start") {
        // The form sends one JSON line: folder, model, effort and the first message.
        let form: { cwd?: unknown; model?: unknown; effort?: unknown; message?: unknown } = {};
        try {
          form = JSON.parse(text) as typeof form;
        } catch {
          form = { cwd: text };
        }
        const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
        const folder = str(form.cwd);
        const environmentId =
          view.newMachine ||
          rows.find((r) => r.local === true)?.environmentId ||
          rows[0]?.environmentId ||
          "";
        if (folder === "" || environmentId === "") return true;
        view = { ...view, creating: false };
        status = "Starting a session...";
        void input.service
          .create({
            environmentId,
            cwd: folder,
            ...(str(form.model) === "" ? {} : { model: str(form.model) }),
            ...(str(form.effort) === "" ? {} : { effort: str(form.effort) }),
            ...(str(form.message) === "" ? {} : { message: str(form.message) }),
          })
          .then(() => {
            status = "";
            return refresh();
          })
          .catch((error: unknown) => {
            status =
              error instanceof Error && error.message !== ""
                ? error.message
                : "That session could not be started there.";
            input.onChange();
          });
      } else if (id.startsWith("c:")) {
        const row = rows.find((r) => `c:${r.id}` === id);
        if (row === undefined) return true;
        if (value === "kept") {
          if (kept.delete(row.id)) input.onChange();
          else void readKept(row);
          return true;
        }
        if (typeof value === "string" && value.startsWith("discard:")) {
          const index = Number(value.slice("discard:".length));
          const text = kept.get(row.id)?.messages[index];
          if (text !== undefined) void readKept(row, { index, text });
          return true;
        }
        if (value === null && row.state === "running") void openRow(row);
        else if (value === "stop" && row.state === "running") {
          void (input.service.stop?.(row) ?? Promise.resolve())
            .then(() => {
              set({ id: row.id, state: "stopped" });
            })
            .catch(() => {
              status = "That session could not be stopped.";
              input.onChange();
            });
          return true;
        } else if (value === "reattach" && row.state === "running") {
          void (
            input.service.reattach?.(row, reattachOffers.get(row.id)) ??
            Promise.reject(new Error("no reattach"))
          )
            .then((result) => {
              if (result.state === "confirm" && result.pane !== null) {
                reattachOffers.set(row.id, result.pane);
                status = "";
              } else {
                reattachOffers.delete(row.id);
                status =
                  result.state === "reattached" || result.state === "already-bound"
                    ? "Reattached to its session."
                    : result.detail;
              }
              void refresh();
            })
            .catch(() => {
              status = "That session could not be reattached.";
              input.onChange();
            });
          return true;
        } else if (row.state === "stopped" || row.state === "failed") {
          set({ id: row.id, state: "resuming" });
          void input.service
            .resume(row)
            .then(() => {
              set({ id: row.id, state: "running" });
              void openRow(row);
            })
            .catch((error: unknown) =>
              set({
                id: row.id,
                state: "failed",
                detail:
                  error instanceof Error && error.message !== "not resumed" ? error.message : null,
              }),
            );
          return true;
        }
      }
      input.onChange();
      return true;
    },
  };
};
