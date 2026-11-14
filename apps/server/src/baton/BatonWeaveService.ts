/* oxlint-disable t3code/prefer-effect-fn -- Baton file predating the rule (D82) */
// @effect-diagnostics cryptoRandomUUID:off nodeBuiltinImport:off
/**
 * Weaving (D149): one session messages another by name, read first and typed only into an empty input, else queued in
 * order. The table is also the one queue for everything waiting to be typed into a live session (item 5): `session|<id>`
 * rows are typed by the server's drainer, `unbound` rows go through their thread once it binds (LiveSessionMirror), and
 * `catalog` rows are sent by the sessions list on a send or Resume. One owner per row, so nothing is typed twice.
 */
import {
  BatonWeaveError,
  type AdoptedDiscoverResult,
  type AdoptedSession,
  type AdoptedSessionCandidate,
  type BatonWeave,
} from "@t3tools/tessaya-contracts";
import {
  extractReply,
  nextStep,
  paneInputState,
  refuseWeave,
  resolveTarget,
  type WeaveRecord,
} from "@t3tools/tessaya-shared/weave";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import {
  appendLiveQueue,
  holdServerLock,
  listOwned,
  liveQueueDir,
  moveAside,
  readInbound,
  readQueueFiles,
  releaseServerLock,
  takeOverQueueFile,
  takeQueueLock,
  writeOwned,
} from "./BatonLiveQueue.ts";
import { BatonRecordService } from "./BatonRecordService.ts";
import { BatonWeaveBoxes, type SessionPane, type WeaveBox } from "./BatonWeaveBoxes.ts";
import { sendOutcome } from "./SessionCatalog.ts";
import { readKeptFile } from "./SessionCatalogLive.ts";
import { pendingKept, readKept, readLedger } from "./UnboundMessages.ts";

interface Row {
  readonly id: string;
  readonly from_label: string;
  readonly to_label: string;
  readonly to_pane: string;
  readonly text: string;
  readonly status: string;
  readonly reason: string | null;
  readonly job: string | null;
  readonly tries: number;
  readonly created_at: number;
  readonly delivered_at: number | null;
  readonly replied_at: number | null;
  readonly reply: string | null;
  readonly source: string | null;
}

const fromRow = (r: Row): WeaveRecord => ({
  id: r.id,
  from: r.from_label,
  toLabel: r.to_label,
  toPane: r.to_pane,
  text: r.text,
  status: r.status as WeaveRecord["status"],
  reason: r.reason,
  job: r.job,
  tries: r.tries,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
  repliedAt: r.replied_at,
  reply: r.reply,
});

/** Nothing waits on a reply longer than this; the message stays "delivered". */
const REPLY_WINDOW_MS = 6 * 3_600_000;
const SCREEN_LINES = 60;
const newId = (): string => globalThis.crypto.randomUUID().slice(0, 8);
/** How often the server's drainer runs: the bridge's own drainer ran every 3 s. */
const DRAIN_EVERY = "3 seconds";
/** Settings key: how far into `inbound.ndjson` the server has imported. */
const INBOUND_OFFSET = "weave.inbound.offset";
const CATALOG_DONE = "weave.migrated.catalog";
const BACKOFF_FIRST_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;
/** A session the bridge just promised to send to ("Resumed… Sending now") is looked at at least this often. */
const BACKOFF_SESSION_MAX_MS = 10_000;
const NOT_OWNER_WARN_MS = 60_000;
/** A stable id for a row taken from an old store, so taking it again (a crash before the move) changes nothing. */
const takenId = (...parts: ReadonlyArray<string>): string =>
  `m-${NodeCrypto.createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16)}`;
const preview = (text: string): string => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

/** An unbound message waiting for its thread: `thread` once known, else the thread's native session id. */
export interface UnboundRow {
  readonly id: string;
  readonly at: number;
  readonly text: string;
  readonly thread: string | null;
  readonly native: string | null;
}

interface NewRow {
  readonly id: string;
  readonly from: string;
  readonly toLabel: string;
  readonly toPane: string;
  readonly text: string;
  readonly createdAt: number;
  readonly source: "thread" | "unbound" | "catalog";
}

export class BatonWeaveService extends Context.Service<
  BatonWeaveService,
  {
    readonly send: (input: {
      readonly to: string;
      readonly text: string;
      readonly from?: string;
      readonly job?: string;
    }) => Effect.Effect<BatonWeave, BatonWeaveError>;
    readonly list: (limit?: number) => Effect.Effect<ReadonlyArray<BatonWeave>>;
    readonly tick: Effect.Effect<{ delivered: number; replied: number }>;
    /** Takes in what the old stores and the bridge left, then types what can go now. The drainer runs it. */
    readonly deliver: Effect.Effect<number>;
    /** The sessions list's kept messages, oldest first per session. */
    readonly catalogKept: Effect.Effect<Record<string, ReadonlyArray<string>>>;
    readonly setCatalogKept: (all: Record<string, ReadonlyArray<string>>) => Effect.Effect<void>;
    readonly unbound: Effect.Effect<ReadonlyArray<UnboundRow>>;
    readonly stampUnbound: (native: string, threadId: string) => Effect.Effect<void>;
    /** Marks it sent before the send, so it is never sent twice; false when it was not waiting. */
    readonly claimUnbound: (id: string) => Effect.Effect<boolean>;
    readonly releaseUnbound: (id: string) => Effect.Effect<void>;
  }
>()("t3/baton/BatonWeaveService") {}

/**
 * Where the bridge's files and the old stores are. Only the server provides it (`storesLayer`): without it nothing is
 * read or written outside the table, so a test never touches the real live-queue folder.
 */
export class WeaveStores extends Context.Service<
  WeaveStores,
  { readonly liveQueueDir: () => string; readonly catalogFile: string }
>()("t3/baton/BatonWeaveService/WeaveStores") {}

/**
 * A server on another base dir than `~/.t3` (a dev worktree's `.t3`) keeps its own folder there, and hands it to the
 * bridges it starts through `BATON_LIVE_QUEUE_DIR`, so it never imports or types the real install's messages.
 */
export const queueDirFor = (baseDir: string, home: string): string | null =>
  NodePath.resolve(baseDir) === NodePath.resolve(home, ".t3")
    ? null
    : NodePath.join(baseDir, "tessaya", "live-queue");

export const storesLayer = Layer.effect(
  WeaveStores,
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const own =
      (yield* HostProcess.Environment)["TESSAYA_LIVE_QUEUE_DIR"] ??
      (yield* HostProcess.Environment)["BATON_LIVE_QUEUE_DIR"] ??
      (Option.isSome(config) ? queueDirFor(config.value.baseDir, NodeOS.homedir()) : null);
    // The bridges this server starts read the folder from the environment they inherit.
    // Both names: a bridge from before the rename reads only the BATON_ one.
    if (own !== null)
      yield* Effect.sync(() => {
        // @effect-diagnostics-next-line processEnvInEffect:off
        process.env["TESSAYA_LIVE_QUEUE_DIR"] = own;
        // @effect-diagnostics-next-line processEnvInEffect:off
        process.env["BATON_LIVE_QUEUE_DIR"] = own;
      });
    return {
      // Read each time otherwise: the folder can move to ~/.t3/tessaya while the server runs.
      liveQueueDir: own === null ? liveQueueDir : () => own,
      // The sessions list kept its messages beside the auto-resume state (BatonSessionCatalogService).
      catalogFile: NodePath.join(
        Option.isSome(config) ? NodePath.dirname(config.value.dbPath) : NodeOS.homedir(),
        "baton-catalog-kept.json",
      ),
    };
  }),
);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const boxes = yield* BatonWeaveBoxes;
  const stores = yield* Effect.serviceOption(WeaveStores);
  const nowMs = Clock.currentTimeMillis;
  /** One drain at a time: the drainer, a send and a client's tick must never type the same row twice. */
  const draining = yield* Semaphore.make(1);
  /**
   * One server owns a live-queue folder (`holdServerLock`, kept by a heartbeat on every pass): only it imports from
   * the folder and types, so two servers on one machine never both type a message.
   */
  const token = NodeCrypto.randomUUID();
  let folder: { readonly dir: string } | null = null;
  let holder: number | null = null;
  const ownFolder = Effect.sync((): string | null => {
    if (Option.isNone(stores)) return null;
    const dir = stores.value.liveQueueDir();
    if (folder !== null && folder.dir !== dir) releaseServerLock(folder.dir, token);
    const held = holdServerLock(dir, token);
    folder = held.owned ? { dir } : null;
    holder = held.holder;
    return folder?.dir ?? null;
  });
  /** A server that does not own the folder could otherwise sit silent forever: it says so once a minute. */
  let warnedAt = Number.NEGATIVE_INFINITY;
  const notOwner = Effect.gen(function* () {
    const now = yield* nowMs;
    if (now - warnedAt < NOT_OWNER_WARN_MS) return;
    warnedAt = now;
    yield* Effect.logWarning(
      "Tessaya: another server owns this machine's live-queue folder, so this one does not import or type its messages",
      { dir: Option.isSome(stores) ? stores.value.liveQueueDir() : null, holderPid: holder },
    );
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (folder !== null) releaseServerLock(folder.dir, token);
    }),
  );
  /** Targets not there now are looked at less often, up to once a minute, so a gone session costs little. */
  const backoff = new Map<string, { readonly until: number; readonly delay: number }>();

  const get = (id: string) =>
    sql<Row>`SELECT * FROM fabric_weaves WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))),
      Effect.orDie,
    );

  const record = yield* Effect.serviceOption(BatonRecordService);

  // Untraced: it runs inside each delivery's own span.
  const setState = Effect.fnUntraced(function* (
    id: string,
    patch: {
      status: WeaveRecord["status"];
      reason: string | null;
      tries: number;
      deliveredAt?: number | null;
      repliedAt?: number | null;
      reply?: string | null;
    },
    /** A message of his own (a thread's, not a weave) is not Record news. */
    quiet = false,
  ) {
    yield* sql`
      UPDATE fabric_weaves SET status = ${patch.status}, reason = ${patch.reason}, tries = ${patch.tries},
        delivered_at = COALESCE(${patch.deliveredAt ?? null}, delivered_at),
        replied_at = COALESCE(${patch.repliedAt ?? null}, replied_at),
        reply = COALESCE(${patch.reply ?? null}, reply)
      WHERE id = ${id}
    `.pipe(Effect.orDie);
    // A retry that stays queued is not news; delivered, replied and lost are.
    if (patch.status === "queued" || quiet || record._tag === "None") return;
    const weave = yield* get(id);
    if (weave === null) return;
    yield* record.value.append({
      kind: "weave",
      actor: weave.from,
      ref: weave.id,
      subject: `to ${weave.toLabel}: ${weave.text}`,
      outcome: weave.status,
      detail: weave.reply ?? weave.reason ?? "",
    });
  });

  /** The pane key stored in a record: which machine, and the pane there. */
  const paneKey = (box: string, pane: string) => `${box}|${pane}`;
  const splitKey = (key: string): { box: string; pane: string } => {
    const at = key.indexOf("|");
    return at < 0 ? { box: "here", pane: key } : { box: key.slice(0, at), pane: key.slice(at + 1) };
  };
  const boxNamed = (name: string): WeaveBox | undefined => boxes.find((b) => b.name === name);
  /** Addressed to a Claude session, not a pane: its pane is looked up each time it is typed. */
  const bySession = (box: string) => box === "session" || box === "live";

  /** What Herdr shows, read once per pass and shared by every target in it. */
  const newPass = () => {
    let agents: ReadonlyMap<string, SessionPane> | null = null;
    const found = new Map<string, AdoptedDiscoverResult>();
    const here = boxes.find((b) => b.agents !== undefined);
    return {
      here,
      agents: Effect.suspend(() =>
        agents !== null || here?.agents === undefined
          ? Effect.succeed(agents ?? new Map<string, SessionPane>())
          : Effect.map(here.agents, (all) => (agents = all)),
      ),
      discover: (box: WeaveBox) =>
        Effect.suspend(() => {
          const seen = found.get(box.name);
          return seen !== undefined
            ? Effect.succeed(seen)
            : Effect.tap(box.adapter.discover, (r) => Effect.sync(() => found.set(box.name, r)));
        }),
    };
  };
  type Pass = ReturnType<typeof newPass>;

  /** Only the pane and label are read by the adapter; no stored session is involved. */
  const synth = (c: AdoptedSessionCandidate): AdoptedSession =>
    ({
      id: `weave:${c.location.pane}`,
      runtime: "herdr",
      workSessionId: null,
      label: c.label,
      location: c.location,
      agentKind: c.agentKind,
      state: "idle",
      capabilities: {
        readConversation: false,
        sendInput: true,
        approvals: false,
        diffs: false,
        stop: false,
        showTerminal: true,
      },
    }) as unknown as AdoptedSession;

  /** A line in the session's own thread, which the bridge shows (a note is never typed). */
  const note = (row: Row, sessionId: string, text: string) =>
    row.source === "thread" && folder !== null
      ? Effect.sync(() =>
          appendLiveQueue(folder!.dir, sessionId, {
            text,
            shown: text,
            kind: "note",
          }),
        )
      : Effect.void;

  /**
   * A row for a Claude session: typed through Herdr's `agent prompt` into the pane found by the session's id, which
   * refuses while a question is up. Only a definite refusal keeps it; an answer that may mean it was typed drops it.
   */
  const attemptSession = Effect.fn("BatonWeaveService.attemptSession")(function* (
    row: Row,
    sessionId: string,
    pass: Pass,
  ) {
    const rec = fromRow(row);
    const quiet = row.source !== null;
    const now = yield* nowMs;
    const here = pass.here;
    const where = (yield* pass.agents).get(sessionId) ?? null;
    const step = nextStep(rec, { present: where !== null, busy: false, input: "empty" }, now);
    const wait = (reason: string, tries = rec.tries) =>
      setState(rec.id, { status: "queued", reason, tries }, quiet).pipe(
        Effect.as("waiting" as const),
      );
    if (step.do === "lose") {
      yield* setState(rec.id, { status: "lost", reason: step.why, tries: rec.tries }, quiet);
      yield* note(row, sessionId, `Not delivered: ${step.why}. Your message was: "${rec.text}"`);
      return "lost" as const;
    }
    if (here === undefined || where === null)
      return yield* wait("the session is not in a Herdr pane here now").pipe(
        Effect.as("absent" as const),
      );
    if (where.status === "blocked")
      return yield* wait("it is waiting on a question or an approval in its terminal");
    const sent = yield* here.adapter.sendInput({
      session: synth({
        runtime: "herdr",
        label: rec.toLabel,
        location: { workspace: "", pane: where.pane, host: null },
        agentKind: "claude",
        runtimeState: where.status,
        state: null,
      } as unknown as AdoptedSessionCandidate),
      text: rec.text,
      submit: true,
    });
    const outcome = sendOutcome(sent);
    if (outcome === "sent") {
      yield* setState(
        rec.id,
        { status: "delivered", reason: null, tries: rec.tries + 1, deliveredAt: now },
        quiet,
      );
      yield* note(row, sessionId, `Delivered: ${preview(rec.text)}`);
      return "delivered" as const;
    }
    if (outcome === "blocked")
      return yield* wait("it is waiting on a question or an approval in its terminal");
    if (outcome === "refused") return yield* wait(sent.detail, rec.tries + 1);
    const unsure =
      "Herdr did not answer in time, so it may already be in the session; it is not sent again in case it is";
    yield* setState(rec.id, { status: "lost", reason: unsure, tries: rec.tries + 1 }, quiet);
    yield* note(row, sessionId, `Maybe delivered: ${unsure}. Your message was: "${rec.text}"`);
    return "lost" as const;
  });

  /** Looks at the target now and, if it can take the message, types it. Waiting does not use up a try. */
  const attempt = (row: Row, pass: Pass) =>
    Effect.gen(function* () {
      const rec = fromRow(row);
      const now = yield* nowMs;
      const { box: boxName, pane } = splitKey(rec.toPane);
      if (bySession(boxName)) return yield* attemptSession(row, pane, pass);
      const box = boxNamed(boxName);
      const found = box === undefined ? null : yield* pass.discover(box);
      const cand = found?.candidates.find((c) => c.location.pane === pane);
      if (box === undefined || cand === undefined) {
        const step = nextStep(rec, { present: false, busy: false, input: "unknown" }, now);
        yield* setState(rec.id, {
          status: step.do === "lose" ? "lost" : "queued",
          reason: step.do === "send" ? null : step.why,
          tries: rec.tries,
        });
        return step.do === "lose" ? ("lost" as const) : ("absent" as const);
      }
      const busy = cand.runtimeState === "working" || cand.runtimeState === "blocked";
      const session = synth(cand);
      const out = yield* box.adapter.readOutput({ session, lines: SCREEN_LINES });
      const input = out.available ? paneInputState(out.output) : "unknown";
      const step = nextStep(rec, { present: true, busy, input }, now);
      if (step.do === "send") {
        const sent = yield* box.adapter.sendInput({ session, text: rec.text, submit: true });
        const outcome = sendOutcome(sent);
        if (outcome === "sent") {
          yield* setState(rec.id, {
            status: "delivered",
            reason: null,
            tries: rec.tries + 1,
            deliveredAt: now,
          });
          return "delivered" as const;
        }
        // Only a definite refusal is tried again; anything else may already be in the pane (a timeout, the text
        // without its return), so it is reported and never typed twice.
        if (outcome === "unsure") {
          yield* setState(rec.id, {
            status: "lost",
            reason: `it may already be in the pane, so it is not sent again: ${sent.detail || "no answer"}`,
            tries: rec.tries + 1,
          });
          return "lost" as const;
        }
        yield* setState(rec.id, {
          status: "queued",
          reason: sent.detail || "the pane did not take it",
          tries: outcome === "refused" ? rec.tries + 1 : rec.tries,
        });
        return "waiting" as const;
      }
      if (step.do === "lose") {
        yield* setState(rec.id, { status: "lost", reason: step.why, tries: rec.tries });
        return "lost" as const;
      }
      yield* setState(rec.id, { status: "queued", reason: step.why, tries: rec.tries });
      return "waiting" as const;
    }).pipe(
      Effect.catchCause(() =>
        setState(
          row.id,
          { status: "queued", reason: "the pane could not be read", tries: row.tries + 1 },
          row.source !== null,
        ).pipe(Effect.as("waiting" as const)),
      ),
    );

  /** Oldest first; stops at the first message that cannot go yet, so the order is kept. */
  const drainPane = Effect.fn("BatonWeaveService.drainPane")(function* (pane: string, pass: Pass) {
    const rows = yield* sql<Row>`
        SELECT * FROM fabric_weaves WHERE status = 'queued' AND to_pane = ${pane}
          AND (source IS NULL OR source = 'thread')
        ORDER BY created_at, rowid
      `.pipe(Effect.orDie);
    let delivered = 0;
    for (const row of rows) {
      // Touched before each row: a long pass must not let the lock go stale and a second server type too.
      if (Option.isSome(stores) && (yield* ownFolder) === null) return { delivered, absent: false };
      const r = yield* attempt(row, pass);
      if (r === "delivered") {
        delivered += 1;
        continue;
      }
      if (r === "lost") continue;
      return { delivered, absent: r === "absent" };
    }
    return { delivered, absent: false };
  });

  const setSetting = (key: string, value: string) => sql`
    INSERT INTO fabric_settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `;
  /** Set in the same transaction as an old store's rows: a file that could not be moved aside is never sent again. */
  const isDone = (key: string) =>
    sql<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.orDie,
    );

  const inboundOffset = sql<{ value: string }>`
    SELECT value FROM fabric_settings WHERE key = ${INBOUND_OFFSET}
  `.pipe(
    Effect.map((rows) => Number(rows[0]?.value ?? 0)),
    Effect.orDie,
  );

  /** Marks each session whose waiting messages the server types, for the bridge (`writeOwned`). */
  const markOwned = Effect.gen(function* () {
    const dir = folder?.dir;
    if (dir === undefined) return;
    // Listed before anything is counted: a marker the bridge writes after this is never removed by this pass.
    const markers = listOwned(dir);
    const rows = yield* sql<{ to_pane: string; n: number }>`
      SELECT to_pane, COUNT(*) AS n FROM fabric_weaves
      WHERE status = 'queued' AND (source IS NULL OR source = 'thread')
        AND (to_pane LIKE 'session|%' OR to_pane LIKE 'live|%')
      GROUP BY to_pane
    `.pipe(Effect.orDie);
    const waiting = new Map(rows.map((r) => [splitKey(r.to_pane).pane, Number(r.n)]));
    // Lines the bridge appended since the last import are the server's too, though not in the table yet.
    for (const line of readInbound(dir, yield* inboundOffset).lines)
      if (!line.unbound) waiting.set(line.sessionId, (waiting.get(line.sessionId) ?? 0) + 1);
    yield* Effect.sync(() => writeOwned(dir, waiting, markers));
  });

  const insertRows = (rows: ReadonlyArray<NewRow>) =>
    Effect.forEach(
      rows,
      (r) => sql`
        INSERT OR IGNORE INTO fabric_weaves (id, from_label, to_label, to_pane, text, status, tries, created_at, source)
        VALUES (${r.id}, ${r.from}, ${r.toLabel}, ${r.toPane}, ${r.text}, 'queued', 0, ${r.createdAt}, ${r.source})
      `,
      { discard: true },
    );

  /**
   * Takes in the old stores, in this order: the bridge's per-session files (under its drain lock, so no bridge is
   * mid-send), the unbound file less what its ledger claimed, the sessions list's kept file. Each is moved aside after
   * its rows commit; their ids are stable, so a crash before the move only takes the same rows again, which is a no-op.
   * Then the lines the bridge appended to `inbound.ndjson` since last time.
   */
  const takeOver = Effect.fn("BatonWeaveService.takeOver")(function* () {
    if (Option.isNone(stores)) return;
    const now = yield* nowMs;
    const catalogFile = stores.value.catalogFile;
    const dir = yield* ownFolder;
    if (dir !== null && readQueueFiles(dir).length > 0) {
      const release = takeQueueLock(dir);
      if (release !== null) {
        yield* Effect.gen(function* () {
          const files = readQueueFiles(dir);
          yield* sql.withTransaction(
            insertRows(
              files.flatMap((q) =>
                q.texts.map((t, i) => ({
                  id: takenId("live", q.sessionId, String(i), t.at, t.text),
                  from: "thread",
                  toLabel: `session ${q.sessionId.slice(0, 8)}`,
                  toPane: paneKey("session", q.sessionId),
                  text: t.text,
                  createdAt: Date.parse(t.at) || now,
                  source: "thread" as const,
                })),
              ),
            ),
          );
          // Marked before the files move, while the bridge is still locked out.
          yield* markOwned;
          for (const q of files) takeOverQueueFile(q, now);
        }).pipe(Effect.ensuring(Effect.sync(release)));
      }
    }
    const keptFile = dir === null ? null : NodePath.join(dir, "unbound-messages.ndjson");
    // No done marker here: rows keep their stable `u-<id>` and are never deleted, so a file an older bridge writes
    // again is taken in without sending anything twice.
    if (dir !== null && keptFile !== null && NodeFS.existsSync(keptFile)) {
      const pending = pendingKept(readKept(dir), readLedger(dir));
      yield* sql.withTransaction(
        insertRows(
          pending.map((e) => ({
            id: `u-${e.id}`,
            from: "thread",
            toLabel: "its thread",
            toPane:
              e.thread !== null
                ? paneKey("thread", e.thread)
                : paneKey("unbound", e.sessionId ?? e.id),
            text: e.text,
            createdAt: Date.parse(e.at) || now,
            source: "unbound" as const,
          })),
        ),
      );
      moveAside(keptFile, now);
      moveAside(NodePath.join(dir, "unbound-ledger.ndjson"), now);
    }
    // The catalog file is this server's own (beside its database), so it is taken in whether or not it owns the folder.
    if (NodeFS.existsSync(catalogFile) && !(yield* isDone(CATALOG_DONE))) {
      const { kept, problem } = readKeptFile(catalogFile);
      if (problem !== null) yield* Effect.logWarning("Tessaya kept messages", problem);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* insertRows(
            Object.entries(kept).flatMap(([sessionId, texts]) =>
              texts.map((text, i) => ({
                id: takenId("catalog", sessionId, String(i), text),
                from: "Sessions",
                toLabel: `session ${sessionId.slice(0, 8)}`,
                toPane: paneKey("session", sessionId),
                text,
                createdAt: now,
                source: "catalog" as const,
              })),
            ),
          );
          yield* setSetting(CATALOG_DONE, String(now));
        }),
      );
      moveAside(catalogFile, now);
    }
    if (dir === null) return;
    const offset = yield* inboundOffset;
    const { lines, next } = readInbound(dir, offset);
    if (next === offset && lines.length === 0) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* insertRows(
          lines.map((l) => ({
            id: `in-${l.id}`,
            from: "thread",
            toLabel: l.label ?? `session ${l.sessionId.slice(0, 8)}`,
            toPane: l.unbound
              ? l.threadId !== null
                ? paneKey("thread", l.threadId)
                : paneKey("unbound", l.sessionId)
              : paneKey("session", l.sessionId),
            text: l.text,
            createdAt: Math.min(l.at, now),
            source: l.unbound ? ("unbound" as const) : ("thread" as const),
          })),
        );
        yield* setSetting(INBOUND_OFFSET, String(next));
        for (const l of lines) if (!l.unbound) backoff.delete(paneKey("session", l.sessionId));
      }),
    );
    // Marked at once, so a message the bridge gets next joins the end instead of going first.
    yield* markOwned;
  });

  const deliverUnlocked = Effect.gen(function* () {
    yield* takeOver().pipe(Effect.orDie);
    // Another server owns this machine's folder: it drains, this one does not.
    if (Option.isSome(stores) && folder === null) {
      yield* notOwner;
      return 0;
    }
    const panes = yield* sql<{ to_pane: string }>`
      SELECT DISTINCT to_pane FROM fabric_weaves
      WHERE status = 'queued' AND (source IS NULL OR source = 'thread')
    `.pipe(Effect.orDie);
    const now = yield* nowMs;
    const pass = newPass();
    const queued = new Set(panes.map((p) => p.to_pane));
    for (const target of backoff.keys()) if (!queued.has(target)) backoff.delete(target);
    let delivered = 0;
    for (const { to_pane } of panes) {
      const wait = backoff.get(to_pane);
      if (wait !== undefined && wait.until > now) continue;
      const r = yield* drainPane(to_pane, pass);
      delivered += r.delivered;
      if (!r.absent) backoff.delete(to_pane);
      else {
        const cap = bySession(splitKey(to_pane).box) ? BACKOFF_SESSION_MAX_MS : BACKOFF_MAX_MS;
        const delay = Math.min(cap, (wait?.delay ?? BACKOFF_FIRST_MS / 2) * 2);
        backoff.set(to_pane, { until: now + delay, delay });
      }
    }
    if (panes.length > 0) yield* markOwned;
    return delivered;
  });
  const deliver = draining.withPermits(1)(deliverUnlocked);

  // Once at start, so the sessions list reads its kept messages from the table, not the file.
  yield* takeOver().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Tessaya: old message stores not taken in", cause),
    ),
  );

  const send = Effect.fn("BatonWeaveService.send")(function* (input: {
    readonly to: string;
    readonly text: string;
    readonly from?: string;
    readonly job?: string;
  }) {
    const refusal = refuseWeave(input.text);
    if (refusal !== null) return yield* new BatonWeaveError({ reason: refusal });
    const seen = yield* Effect.forEach(boxes, (box) =>
      Effect.map(box.adapter.discover, (found) => ({ box, found })),
    );
    if (seen.every((x) => !x.found.available)) {
      return yield* new BatonWeaveError({
        reason: seen[0]?.found.reason ?? "no sessions are reachable",
        missing: true,
      });
    }
    const all = seen.flatMap(({ box, found }) =>
      found.candidates.map((c) => ({
        label: box.name === "here" ? c.label : `${box.name}:${c.label}`,
        ...(box.name === "here" ? {} : { alias: c.label }),
        // A live session outside Herdr is addressed by its id: the server types it once it has a pane.
        pane: paneKey(box.name === "live" ? "session" : box.name, c.location.pane),
        state: c.runtimeState,
        agentKind: c.agentKind,
      })),
    );
    const target = resolveTarget(input.to, all);
    if (!target.ok)
      return yield* new BatonWeaveError({
        reason: target.why,
        ...(target.missing === true ? { missing: true } : {}),
      });
    const now = yield* nowMs;
    const id = newId();
    yield* sql`
      INSERT INTO fabric_weaves (id, from_label, to_label, to_pane, text, status, job, tries, created_at)
      VALUES (${id}, ${input.from ?? "Tessaya"}, ${target.target.label}, ${target.target.pane}, ${input.text.trim()},
              'queued', ${input.job ?? null}, 0, ${now})
    `.pipe(Effect.orDie);
    // Earlier messages to the same pane go first, so the order he sent them in is kept. A pass already running is not
    // waited for: the row is queued, and the drainer takes it in a few seconds.
    backoff.delete(target.target.pane);
    // Only the folder's owner types; on another server the row waits for it.
    if (Option.isNone(stores) || (yield* ownFolder) !== null)
      yield* draining.withPermitsIfAvailable(1)(drainPane(target.target.pane, newPass()));
    const sent = (yield* get(id))!;
    const line =
      sent.status === "delivered"
        ? `Sent to ${sent.toLabel}: "${sent.text.slice(0, 80)}"${sent.reason === null ? "" : ` (${sent.reason})`}`
        : sent.status === "queued" && bySession(splitKey(sent.toPane).box)
          ? `Queued for ${sent.toLabel}: "${sent.text.slice(0, 80)}" (${sent.reason ?? "it goes when it can"})`
          : null;
    if (input.from !== undefined && line !== null) {
      yield* Effect.forEach(boxes, (b) => b.notify?.(input.from!, line) ?? Effect.void, {
        discard: true,
      });
    }
    return sent;
  });

  const tick = draining.withPermits(1)(
    Effect.gen(function* () {
      const delivered = yield* deliverUnlocked;
      const now = yield* nowMs;
      const waiting = yield* sql<Row>`
        SELECT * FROM fabric_weaves WHERE status = 'delivered' AND source IS NULL
          AND delivered_at > ${now - REPLY_WINDOW_MS}
      `.pipe(Effect.orDie);
      let replied = 0;
      for (const row of waiting) {
        const { box: boxName, pane } = splitKey(row.to_pane);
        const box = boxNamed(boxName);
        if (box === undefined || bySession(boxName)) continue;
        const text = yield* Effect.gen(function* () {
          const found = yield* box.adapter.discover;
          const cand = found.candidates.find((c) => c.location.pane === pane);
          // Read only once it has stopped working, so a half-written answer is not taken as the reply.
          if (cand === undefined || cand.runtimeState === "working") return null;
          const out = yield* box.adapter.readOutput({ session: synth(cand), lines: 200 });
          return out.available ? extractReply(out.output, row.text) : null;
        }).pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (text !== null) {
          yield* setState(row.id, {
            status: "replied",
            reason: null,
            tries: row.tries,
            repliedAt: now,
            reply: text,
          });
          replied += 1;
        }
      }
      return { delivered, replied };
    }),
  );

  const list = (limit = 50) =>
    sql<Row>`SELECT * FROM fabric_weaves ORDER BY created_at DESC, id LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map(fromRow)),
      Effect.orDie,
    );

  const catalogRows = sql<{ id: string; to_pane: string; text: string }>`
    SELECT id, to_pane, text FROM fabric_weaves WHERE source = 'catalog' AND status = 'queued'
    ORDER BY created_at, rowid
  `.pipe(Effect.orDie);

  const catalogKept = Effect.map(catalogRows, (rows) => {
    const all: Record<string, Array<string>> = {};
    for (const r of rows) (all[splitKey(r.to_pane).pane] ??= []).push(r.text);
    return all as Record<string, ReadonlyArray<string>>;
  });

  /**
   * Makes the table hold exactly `all`. The sessions list only appends, sends from the front, or drops one, so each
   * wanted text keeps the earliest matching row after the last one kept; the rest go, and new ones join the end.
   */
  const setCatalogKept = (all: Record<string, ReadonlyArray<string>>) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* catalogRows;
          const now = yield* nowMs;
          const have = new Map<string, Array<{ id: string; text: string }>>();
          for (const r of rows) {
            const sid = splitKey(r.to_pane).pane;
            have.set(sid, [...(have.get(sid) ?? []), r]);
          }
          for (const sid of new Set([...have.keys(), ...Object.keys(all)])) {
            const existing = have.get(sid) ?? [];
            const kept = new Set<string>();
            let from = 0;
            const added: Array<string> = [];
            for (const text of all[sid] ?? []) {
              const at = existing.findIndex((r, i) => i >= from && r.text === text);
              if (at < 0) added.push(text);
              else {
                kept.add(existing[at]!.id);
                from = at + 1;
              }
            }
            for (const r of existing)
              if (!kept.has(r.id)) yield* sql`DELETE FROM fabric_weaves WHERE id = ${r.id}`;
            yield* insertRows(
              added.map((text) => ({
                id: `c-${newId()}${newId()}`,
                from: "Sessions",
                toLabel: `session ${sid.slice(0, 8)}`,
                toPane: paneKey("session", sid),
                text,
                createdAt: now,
                source: "catalog" as const,
              })),
            );
          }
        }),
      )
      .pipe(Effect.orDie);

  const unbound = sql<{ id: string; created_at: number; text: string; to_pane: string }>`
    SELECT id, created_at, text, to_pane FROM fabric_weaves WHERE source = 'unbound' AND status = 'queued'
    ORDER BY created_at, rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((r) => {
        const { box, pane } = splitKey(r.to_pane);
        return {
          id: r.id,
          at: r.created_at,
          text: r.text,
          thread: box === "thread" ? pane : null,
          native: box === "unbound" ? pane : null,
        };
      }),
    ),
    Effect.orDie,
  );

  const stampUnbound = (native: string, threadId: string) =>
    sql`
      UPDATE fabric_weaves SET to_pane = ${paneKey("thread", threadId)}
      WHERE source = 'unbound' AND status = 'queued' AND to_pane = ${paneKey("unbound", native)}
    `.pipe(Effect.asVoid, Effect.orDie);

  const claimUnbound = Effect.fn("BatonWeaveService.claimUnbound")(function* (id: string) {
    const now = yield* nowMs;
    const rows = yield* sql<{ id: string }>`
      UPDATE fabric_weaves SET status = 'delivered', delivered_at = ${now}
      WHERE id = ${id} AND source = 'unbound' AND status = 'queued' RETURNING id
    `.pipe(Effect.orDie);
    return rows.length > 0;
  });

  const releaseUnbound = (id: string) =>
    sql`
      UPDATE fabric_weaves SET status = 'queued', delivered_at = NULL WHERE id = ${id} AND source = 'unbound'
    `.pipe(Effect.asVoid, Effect.orDie);

  return BatonWeaveService.of({
    send,
    list,
    tick,
    deliver,
    catalogKept,
    setCatalogKept,
    unbound,
    stampUnbound,
    claimUnbound,
    releaseUnbound,
  });
});

export const layer = Layer.effect(BatonWeaveService, make);

/** The server's drainer: what waits is typed on the server's own clock, not when a client asks. */
export const drainer = Layer.effectDiscard(
  Effect.gen(function* () {
    const weave = yield* BatonWeaveService;
    yield* weave.deliver.pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced(DRAIN_EVERY)),
      Effect.forkScoped,
    );
  }),
);
