// @effect-diagnostics globalJsonInEffect:off nodeBuiltinImport:off
/**
 * One brain (tessaya-ops one-brain-2026-11-18 §2.1): the linked server `household.home` names holds Tessaya's state and
 * makes her decisions; empty, this server is the brain. Any other server runs none of her decision loops and sends what
 * it heard there (`tessaya_brain`), so one store applies each act and nothing merges between servers.
 */
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

/** The setting naming the linked server that is her brain (and holds the members); empty or absent: this one. */
export const HOME_KEY = "household.home";
/** The linked-server tool a worker sends its acts to the brain by. */
export const BRAIN_TOOL = "tessaya_brain";
export const BrainOp = Schema.Literals([
  "mood",
  // her mood as the brain holds it, for a server that shows her (one mood across every body)
  "moodView",
  // who wears which body (Tessels, phones) and the visits: kept on her brain alone
  "cast",
  // a worker's queued change, replayed once the brain is back: applied exactly once by its id
  "outbox",
  // her one conversation list (LiveThreads): kept on her brain alone
  "threads",
  // her one memory: a worker's reads and writes, and its earlier writes as one sync round
  "memory",
  "memorySync",
  "presence",
  "persona",
  "group",
  "inbox",
  "libraryRemoved",
  "privateTier",
  "pronounce",
  "voiceIdGate",
  "scratchpad",
  "vocabulary",
  "roomLoop",
]);
export type BrainOp = typeof BrainOp.Type;

/** The brain's link label, read now; null: this server is the brain (also with no Tessaya database here). */
export const brainOn = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return null;
  const rows = yield* sql.value<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${HOME_KEY}`.pipe(
    Effect.orElseSucceed(() => []),
  );
  return (rows[0]?.value ?? "").trim() || null;
});

export const isBrain = Effect.map(brainOn, (on) => on === null);

/** A queued change's id: the brain applies each one once. */
const outboxId = (): string => NodeCrypto.randomUUID();

/** A server's way to its brain, made once beside the services that send to it. */
export const makeBrainLink = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peerMcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  const on = Option.isNone(sql)
    ? Effect.succeed(null)
    : brainOn.pipe(Effect.provideService(SqlClient.SqlClient, sql.value));
  /**
   * Runs `op` on the brain and gives its answer. None: this server is the brain, or the brain could not be reached
   * (logged), so the caller decides whether to keep it here.
   */
  const send = Effect.fn("BrainHost.send")(function* (op: BrainOp, payload: unknown) {
    const label = yield* on;
    if (label === null || Option.isNone(links) || Option.isNone(peerMcp))
      return Option.none<unknown>();
    const link = (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).find(
      (l) => l.status !== "expired" && l.label === label,
    );
    const answer =
      link === undefined
        ? Option.none<unknown>()
        : yield* peerMcp.value
            .call({
              environmentId: link.environmentId,
              tool: BRAIN_TOOL,
              arguments: { op, payload },
              limits: { runtimeMode: "approval-required", interactionMode: "default" },
              success: Schema.Unknown,
            })
            .pipe(
              Effect.timeout("10 seconds"),
              Effect.option,
              Effect.catchCause(() => Effect.succeedNone),
            );
    const value = Option.flatMap(answer, (a) =>
      typeof a === "object" && a !== null && (a as { ok?: unknown }).ok === true
        ? Option.some((a as { value?: unknown }).value ?? null)
        : Option.none(),
    );
    if (Option.isNone(value))
      yield* Effect.logWarning("one brain: not reached", { brain: label, op });
    return value;
  });
  /**
   * A change for the brain that must not be lost: sent at once when the brain answers, else queued here in order
   * (never read as truth) and replayed when it's back. Earlier queued changes always go first. Some: the brain's answer
   * now; None: queued (or this server is the brain, when the caller applies it itself).
   */
  const replay = Effect.fn("BrainHost.replay")(function* () {
    if (Option.isNone(sql)) return true;
    const rows = yield* sql.value<{ id: string; op: string; payload: string }>`
      SELECT id, op, payload FROM tessaya_brain_outbox ORDER BY seq
    `.pipe(Effect.orElseSucceed(() => []));
    for (const r of rows) {
      const payload = yield* Effect.try({
        try: () => JSON.parse(r.payload) as unknown,
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));
      const sent = yield* send("outbox", { id: r.id, op: r.op, payload });
      if (Option.isNone(sent)) return false;
      yield* sql.value`DELETE FROM tessaya_brain_outbox WHERE id = ${r.id}`.pipe(Effect.ignore);
    }
    return true;
  });
  const sendOrQueue = Effect.fn("BrainHost.sendOrQueue")(function* (op: BrainOp, payload: unknown) {
    if ((yield* on) === null) return Option.none<unknown>();
    const id = outboxId();
    if (yield* replay()) {
      const sent = yield* send("outbox", { id, op, payload });
      if (Option.isSome(sent)) return sent;
    }
    if (Option.isNone(sql)) return Option.none<unknown>();
    const json = yield* Effect.try({ try: () => JSON.stringify(payload), catch: () => null }).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (json === null) return Option.none<unknown>();
    yield* sql.value`
      INSERT INTO tessaya_brain_outbox (id, op, payload, at) VALUES (${id}, ${op}, ${json}, ${yield* Clock.currentTimeMillis})
    `.pipe(Effect.ignore);
    yield* Effect.logInfo("one brain: queued until she is back", { op });
    return Option.none<unknown>();
  });
  /** How many changes wait for the brain here ("not yet synced"). */
  const pending = Option.isNone(sql)
    ? Effect.succeed(0)
    : sql.value<{ n: number }>`SELECT COUNT(*) AS n FROM tessaya_brain_outbox`.pipe(
        Effect.map((r) => r[0]?.n ?? 0),
        Effect.orElseSucceed(() => 0),
      );
  return { isBrain: Effect.map(on, (label) => label === null), send, sendOrQueue, replay, pending };
});

/** The outbox drains on its own: every half minute a worker replays what waited for the brain, in order. */
export const outboxLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const link = yield* makeBrainLink;
    yield* link.replay().pipe(
      Effect.catchCause(() => Effect.void),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    );
  }),
);
