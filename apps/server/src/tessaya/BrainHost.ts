/**
 * One brain (tessaya-ops one-brain-2026-11-18 §2.1): the linked server `household.home` names holds Tessaya's state and
 * makes her decisions; empty, this server is the brain. Any other server runs none of her decision loops and sends what
 * it heard there (`tessaya_brain`), so one store applies each act and nothing merges between servers.
 */
import * as Effect from "effect/Effect";
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
  return { isBrain: Effect.map(on, (label) => label === null), send };
});
