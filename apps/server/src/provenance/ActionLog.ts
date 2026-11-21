// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off preferSchemaOverJson:off tryCatchInEffectGen:off
/**
 * The action log (B-046): one envelope per action. `emitAction` only queues (never waits, never fails); the layer
 * flushes in batches. Private events are sealed whole to his store; the public table keeps their id and links.
 * The queue is module state so any call site records without the layer in its context.
 */
import {
  findGaps,
  newEventId,
  publicPointer,
  toEnvelope,
  type ActionEnvelope,
  type ActionInput,
  type Finding,
} from "@t3tools/tessaya-shared/provenance";
import { eventAad, sealTo } from "@t3tools/tessaya-shared/privateCrypto";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { TessayaPrivateMemoryService } from "../tessaya/TessayaPrivateMemoryService.ts";

/** The event the running fiber acts for: anything it emits names it as cause. */
const CurrentCause = Context.Reference<ReadonlyArray<string>>("t3/provenance/CurrentCause", {
  defaultValue: () => [],
});

interface Pending {
  readonly envelope: ActionEnvelope;
  readonly private: boolean;
}

/** Past this the oldest are dropped (and counted): memory stays bounded if the flusher stalls. */
const PENDING_MAX = 20_000;
const BATCH = 500;
const FLUSH_MS = 2_000;
const KEEP_DAYS = 30;

let pending: Pending[] = [];
let droppedCount = 0;
let origin = "local";

const randomBytes = (n: number) => new Uint8Array(NodeCrypto.randomBytes(n));

const listeners = new Set<(e: ActionEnvelope) => void>();
/** Each public action as it is recorded (the developer feed); a private one never reaches a listener. */
export const onAction = (listener: (e: ActionEnvelope) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Records one action now, for code outside Effect (a Promise hook, a socket callback). Returns its id. */
export const emitActionSync = (
  input: ActionInput,
  ctx: { readonly now?: number; readonly cause?: ReadonlyArray<string> } = {},
): string => {
  const at = input.at ?? ctx.now ?? Date.now();
  const envelope = toEnvelope(input, {
    id: newEventId(at, randomBytes),
    at,
    origin,
    cause: ctx.cause ?? [],
  });
  pending.push({ envelope, private: input.private === true });
  if (input.private !== true)
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch {
        // A listener (the developer feed) never breaks recording.
      }
    }
  if (pending.length > PENDING_MAX) {
    droppedCount += pending.length - PENDING_MAX;
    pending = pending.slice(-PENDING_MAX);
  }
  return envelope.id;
};

/** Records one action; its cause includes the fiber's current one. Never fails, never waits on storage. */
export const emitAction = Effect.fn("ActionLog.emit")(function* (input: ActionInput) {
  const cause = yield* CurrentCause;
  const now = yield* Clock.currentTimeMillis;
  return emitActionSync(input, { now, cause });
});

/** Runs `effect` as caused by `id`, so what it emits links back to it. */
export const withCause =
  (id: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentCause, [id]);

/**
 * Runs `effect` as one action: what it emits names this action as cause, and the action itself is recorded when it
 * ends, with its outcome ("ok", "fail", "interrupted") and how long it took. One event per action, not two.
 */
export const traced =
  (
    input: ActionInput,
    /** An outcome of its own for some ends, such as "elsewhere" for an act another server does. */
    outcomeOf?: (exit: Exit.Exit<unknown, unknown>) => string | undefined,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const cause = yield* CurrentCause;
      const startedAt = yield* Clock.currentTimeMillis;
      const id = newEventId(startedAt, randomBytes);
      return yield* effect.pipe(
        Effect.provideService(CurrentCause, [id]),
        Effect.onExit((exit) =>
          Effect.map(Clock.currentTimeMillis, (endedAt) => {
            const outcome =
              exit._tag === "Success"
                ? "ok"
                : Cause.hasInterruptsOnly(exit.cause)
                  ? "interrupted"
                  : "fail";
            emitActionSync(
              {
                ...input,
                id,
                at: startedAt,
                outcome: input.outcome ?? outcomeOf?.(exit) ?? outcome,
                data: { ...(input.data as object | undefined), ms: endedAt - startedAt },
              },
              { cause },
            );
          }),
        ),
      );
    });

export interface ActionQuery {
  readonly since: number;
  readonly until?: number | undefined;
  readonly kindPrefix?: string | undefined;
  readonly actorKind?: string | undefined;
  readonly outcome?: string | undefined;
  readonly text?: string | undefined;
  readonly limit: number;
}

/** One stored event, as a worker sends its own to her brain (ActionShip). */
export const ActionRow = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  kind: Schema.String,
  origin: Schema.String,
  actor_kind: Schema.String,
  actor_id: Schema.NullOr(Schema.String),
  certainty: Schema.Number,
  cause_json: Schema.String,
  evidence_json: Schema.String,
  persona: Schema.NullOr(Schema.String),
  subject: Schema.String,
  outcome: Schema.String,
  data_json: Schema.NullOr(Schema.String),
});
type Row = typeof ActionRow.Type;

const fromRow = (r: Row): ActionEnvelope => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  origin: r.origin,
  actor: {
    kind: r.actor_kind as ActionEnvelope["actor"]["kind"],
    ...(r.actor_id === null ? {} : { id: r.actor_id }),
    certainty: r.certainty,
  },
  cause: JSON.parse(r.cause_json) as string[],
  evidence: JSON.parse(r.evidence_json) as ActionEnvelope["evidence"],
  persona: r.persona,
  subject: r.subject,
  outcome: r.outcome,
  data: r.data_json === null ? null : JSON.parse(r.data_json),
});

export class ActionLog extends Context.Service<
  ActionLog,
  {
    /** Writes what is queued now; the timer does this every two seconds. */
    readonly flush: Effect.Effect<number>;
    readonly list: (query: ActionQuery) => Effect.Effect<ReadonlyArray<ActionEnvelope>>;
    /** The event, then what caused it, then what caused that, up to `depth` links. Private links stay pointers. */
    readonly trace: (id: string, depth?: number) => Effect.Effect<ReadonlyArray<ActionEnvelope>>;
    /** What `id` caused, directly (outcomes, follow-on actions). */
    readonly effectsOf: (
      id: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<ActionEnvelope>>;
    /** The gap detector over the window. */
    readonly findings: (since: number) => Effect.Effect<ReadonlyArray<Finding>>;
    /** His private events with the public ones, only in his own open store's session; never leaves this server. */
    readonly privateEvents: (
      since: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ActionEnvelope>>;
    readonly dropped: Effect.Effect<number>;
    /** This server's stored events after `at` (by time, then id), oldest first: what a worker sends its brain. */
    readonly rowsAfter: (at: number, id: string, limit: number) => Effect.Effect<ReadonlyArray<Row>>;
    /** On her brain: another server's events, each kept once under its own id and origin. */
    readonly ingest: (rows: ReadonlyArray<Row>) => Effect.Effect<number>;
  }
>()("t3/provenance/ActionLog") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const privateStore = yield* Effect.serviceOption(TessayaPrivateMemoryService);
  const env = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  if (Option.isSome(env)) origin = String(yield* env.value.getEnvironmentId);
  let lastPrune = 0;

  const insert = (e: ActionEnvelope) =>
    sql`INSERT OR IGNORE INTO tessaya_action_events ${sql.insert({
      id: e.id,
      at: e.at,
      kind: e.kind,
      origin: e.origin,
      actor_kind: e.actor.kind,
      actor_id: e.actor.id ?? null,
      certainty: e.actor.certainty,
      cause_json: JSON.stringify(e.cause),
      evidence_json: JSON.stringify(e.evidence),
      persona: e.persona,
      subject: e.subject,
      outcome: e.outcome,
      data_json: e.data === null ? null : JSON.stringify(e.data),
    })}`;

  const sealPrivate = Effect.fn("ActionLog.sealPrivate")(function* (e: ActionEnvelope) {
    const key = Option.isSome(privateStore) ? yield* privateStore.value.ownerEventKey : null;
    // No store yet: the content is not written anywhere (never in clear); the pointer still links the chain.
    if (key === null) return;
    const boxed = sealTo(
      key.publicKey,
      Buffer.from(JSON.stringify(e), "utf8"),
      eventAad(key.storeId, e.id),
    );
    yield* sql`INSERT OR IGNORE INTO tessaya_private_events ${sql.insert({
      id: e.id,
      at: e.at,
      store_id: key.storeId,
      sealed_json: JSON.stringify(boxed),
    })}`;
  });

  const flush = Effect.gen(function* () {
    let written = 0;
    for (;;) {
      const batch = pending.slice(0, BATCH);
      if (batch.length === 0) break;
      pending = pending.slice(batch.length);
      yield* sql.withTransaction(
        Effect.forEach(
          batch,
          (p) =>
            p.private
              ? Effect.andThen(sealPrivate(p.envelope), insert(publicPointer(p.envelope)))
              : insert(p.envelope),
          { discard: true },
        ),
      );
      written += batch.length;
    }
    const now = yield* Clock.currentTimeMillis;
    if (now - lastPrune > 3_600_000) {
      lastPrune = now;
      const horizon = now - KEEP_DAYS * 86_400_000;
      yield* sql`DELETE FROM tessaya_action_events WHERE at < ${horizon}`;
      yield* sql`DELETE FROM tessaya_private_events WHERE at < ${horizon}`;
    }
    return written;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning("provenance: a batch of events was not written", { cause }), 0),
    ),
  );

  yield* flush.pipe(Effect.repeat(Schedule.spaced(FLUSH_MS)), Effect.forkScoped);
  yield* Effect.addFinalizer(() => flush);

  const read = <A, E>(effect: Effect.Effect<A, E>, empty: A) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning("provenance: read failed", { cause }), empty),
      ),
    );

  const list = Effect.fn("ActionLog.list")(function* (q: ActionQuery) {
    yield* flush;
    const rows = yield* read(
      sql<Row>`
        SELECT * FROM tessaya_action_events
        WHERE at >= ${q.since} AND at <= ${q.until ?? Number.MAX_SAFE_INTEGER}
          AND ${q.kindPrefix === undefined ? sql`1 = 1` : sql`kind LIKE ${`${q.kindPrefix}%`}`}
          AND ${q.actorKind === undefined ? sql`1 = 1` : sql`actor_kind = ${q.actorKind}`}
          AND ${q.outcome === undefined ? sql`1 = 1` : sql`outcome = ${q.outcome}`}
          AND ${q.text === undefined ? sql`1 = 1` : sql`(subject LIKE ${`%${q.text}%`} OR kind LIKE ${`%${q.text}%`})`}
        ORDER BY at DESC LIMIT ${Math.min(Math.max(1, q.limit), 20_000)}`,
      [] as ReadonlyArray<Row>,
    );
    return rows.map(fromRow);
  });

  const byId = (id: string) =>
    read(sql<Row>`SELECT * FROM tessaya_action_events WHERE id = ${id}`, [] as ReadonlyArray<Row>);

  const trace = Effect.fn("ActionLog.trace")(function* (id: string, depth = 12) {
    yield* flush;
    const chain: ActionEnvelope[] = [];
    const seen = new Set<string>();
    let next: string | undefined = id;
    while (next !== undefined && chain.length < depth && !seen.has(next)) {
      seen.add(next);
      const row: Row | undefined = (yield* byId(next))[0];
      if (row === undefined) break;
      const e = fromRow(row);
      chain.push(e);
      next = e.cause.at(-1);
    }
    return chain;
  });

  const effectsOf = Effect.fn("ActionLog.effectsOf")(function* (id: string, limit = 50) {
    yield* flush;
    const rows = yield* read(
      sql<Row>`
        SELECT * FROM tessaya_action_events
        WHERE cause_json LIKE ${`%"${id}"%`} ORDER BY at ASC LIMIT ${limit}`,
      [] as ReadonlyArray<Row>,
    );
    return rows.map(fromRow);
  });

  return ActionLog.of({
    flush,
    list,
    trace,
    effectsOf,
    findings: Effect.fn("ActionLog.findings")(function* (since: number) {
      // shortcut: the detector reads at most 20k events per window; page it when one day outgrows that.
      return findGaps(yield* list({ since, limit: 20_000 }));
    }),
    privateEvents: Effect.fn("ActionLog.privateEvents")(function* (since: number, limit: number) {
      if (Option.isNone(privateStore)) return [];
      const opened = yield* privateStore.value
        .openEvents({ since, limit })
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<unknown>));
      return opened as ReadonlyArray<ActionEnvelope>;
    }),
    dropped: Effect.sync(() => droppedCount),
    rowsAfter: Effect.fn("ActionLog.rowsAfter")(function* (at: number, id: string, limit: number) {
      yield* flush;
      return yield* read(
        sql<Row>`
          SELECT * FROM tessaya_action_events WHERE at > ${at} OR (at = ${at} AND id > ${id})
          ORDER BY at, id LIMIT ${limit}`,
        [] as ReadonlyArray<Row>,
      );
    }),
    ingest: Effect.fn("ActionLog.ingest")(function* (rows: ReadonlyArray<Row>) {
      yield* sql.withTransaction(
        Effect.forEach(rows, (r) => sql`INSERT OR IGNORE INTO tessaya_action_events ${sql.insert(r)}`, {
          discard: true,
        }),
      );
      return rows.length;
    }),
  });
});

export const layer = Layer.effect(ActionLog, make);
