/**
 * Jobs (D145). A job is a work session plus its terms: this service keeps the terms (what the job is
 * for, what it may do, its caps, the standing permissions he has given it) and joins them to the
 * fleet's state, so a job's status is read, never stored. The desktop tool, the windows, the phone
 * and an MCP tool all call these methods, as AGENTS.md asks of a server feature.
 */
import {
  TessayaJobGrant,
  TessayaJobLimits,
  TessayaJobPermissions,
  TessayaPlanLease,
  TessayaJobRevision as TessayaJobRevisionSchema,
  type TessayaFleetEntry,
  type TessayaJob,
  type TessayaJobTerms,
  type TessayaGrantKind,
  type TessayaJobPhase,
  type TessayaJobRevision,
  type WorkSessionId,
  type ProjectId,
  type WorkSessionError,
} from "@t3tools/tessaya-contracts";
import {
  jobGroupFor,
  jobLimits,
  reduceJob,
  limitReached,
  permissionsSummary,
  withGrant,
  withRevoked,
} from "@t3tools/tessaya-shared/jobs";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { WorkSessionService } from "./WorkSessionService.ts";

const encodePermissions = Schema.encodeSync(Schema.fromJsonString(TessayaJobPermissions));
const decodePermissions = Schema.decodeUnknownSync(Schema.fromJsonString(TessayaJobPermissions));
const encodeLimits = Schema.encodeSync(Schema.fromJsonString(TessayaJobLimits));
const decodeLimits = Schema.decodeUnknownSync(Schema.fromJsonString(TessayaJobLimits));
const encodeRevisions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(TessayaJobRevisionSchema)),
);
const decodeRevisions = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(TessayaJobRevisionSchema)),
);
const encodeLease = Schema.encodeSync(Schema.fromJsonString(TessayaPlanLease));
const decodeLease = Schema.decodeUnknownSync(Schema.fromJsonString(TessayaPlanLease));
const encodeGrants = Schema.encodeSync(Schema.fromJsonString(Schema.Array(TessayaJobGrant)));
const decodeGrants = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(TessayaJobGrant)));

interface TermsRow {
  readonly work_session_id: string;
  readonly goal: string;
  readonly permissions_json: string;
  readonly limits_json: string;
  readonly grants_json: string;
  readonly lease_json: string | null;
  readonly phase: string;
  readonly revisions_json: string;
  readonly schedule_task_id: string | null;
  readonly worker_instance_id: string | null;
  readonly parent_id: string | null;
  readonly part_spec_json: string | null;
  readonly persona: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const PartSpecSchema = Schema.Struct({
  after: Schema.Array(Schema.String),
  role: Schema.optionalKey(Schema.String),
  routine: Schema.optionalKey(Schema.Boolean),
});
const decodePartSpec = Schema.decodeUnknownSync(Schema.fromJsonString(PartSpecSchema));
const encodePartSpec = Schema.encodeSync(Schema.fromJsonString(PartSpecSchema));

const fromRow = (row: TermsRow): TessayaJobTerms =>
  ({
    workSessionId: row.work_session_id,
    goal: row.goal,
    permissions: decodePermissions(row.permissions_json),
    limits: decodeLimits(row.limits_json),
    grants: decodeGrants(row.grants_json),
    lease: row.lease_json === null ? null : decodeLease(row.lease_json),
    phase: row.phase as TessayaJobPhase,
    revisions: decodeRevisions(row.revisions_json),
    scheduleTaskId: row.schedule_task_id,
    workerInstanceId: row.worker_instance_id,
    parentId: row.parent_id,
    partSpec: row.part_spec_json === null ? null : decodePartSpec(row.part_spec_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as TessayaJobTerms;

export interface JobCreateInput {
  readonly id: WorkSessionId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal: string;
  readonly permissions: TessayaJobPermissions;
  readonly limits?: Partial<TessayaJobLimits>;
  readonly workerInstanceId?: string | null;
  readonly parentId?: WorkSessionId | null;
  /** A part that waits on others; cleared by `clearPartSpec` once it has started. */
  readonly partSpec?: {
    readonly after: ReadonlyArray<string>;
    readonly role?: string;
    readonly routine?: boolean;
  };
  /** The persona it works for: a role's file stem, or the lead when absent. */
  readonly persona?: string;
  /** The R1 it was asked on (its device id), where its notices are said. */
  readonly origin?: string;
}

export class TessayaJobService extends Context.Service<
  TessayaJobService,
  {
    /** Makes the work session and its terms; a retry with the same id changes nothing. */
    readonly create: (input: JobCreateInput) => Effect.Effect<TessayaJobTerms, WorkSessionError>;
    readonly terms: (id: WorkSessionId) => Effect.Effect<TessayaJobTerms | null>;
    readonly allTerms: () => Effect.Effect<ReadonlyArray<TessayaJobTerms>>;
    /** The part has started: nothing is pending for it any more. */
    readonly clearPartSpec: (id: WorkSessionId) => Effect.Effect<void>;
    /** The parts of a job with several parts, oldest first. */
    readonly parts: (parentId: WorkSessionId) => Effect.Effect<ReadonlyArray<TessayaJobTerms>>;
    /** Each job's persona by its id; a job from before personas is the lead's. */
    readonly personas: () => Effect.Effect<ReadonlyMap<string, string>>;
    /** The R1 each job asked there was asked on, by its id. */
    readonly origins: () => Effect.Effect<ReadonlyMap<string, string>>;
    /** A standing permission for this job and this channel: explicit, per job, and logged. */
    readonly grant: (
      id: WorkSessionId,
      channel: TessayaGrantKind,
    ) => Effect.Effect<TessayaJobTerms | null>;
    readonly revoke: (
      id: WorkSessionId,
      channel: TessayaGrantKind,
    ) => Effect.Effect<TessayaJobTerms | null>;
    /** The worker has written its plan in the thread. */
    readonly planReady: (id: WorkSessionId) => Effect.Effect<TessayaJobTerms | null>;
    /** His explicit agreement: spoken, the button, or a reply in the thread. */
    readonly agree: (id: WorkSessionId) => Effect.Effect<TessayaJobTerms | null>;
    /** Issues the plan lease his yes gave, or withdraws it with null. */
    readonly setLease: (
      id: WorkSessionId,
      lease: TessayaPlanLease | null,
    ) => Effect.Effect<TessayaJobTerms | null>;
    /** What he or Baton said about the job since: kept as context, and the plan is made again. */
    readonly refine: (
      id: WorkSessionId,
      revision: TessayaJobRevision,
      widens?: boolean,
    ) => Effect.Effect<TessayaJobTerms | null>;
    readonly setSchedule: (
      id: WorkSessionId,
      taskId: string | null,
    ) => Effect.Effect<TessayaJobTerms | null>;
    /** The jobs as cards: terms joined to the fleet's state. `turns` is what each worker has taken so far. */
    readonly view: (input: {
      readonly entries: ReadonlyArray<TessayaFleetEntry>;
      readonly turns?: ReadonlyMap<string, number>;
      readonly spend?: ReadonlyMap<
        string,
        { readonly tokens: number; readonly dollars: number | null; readonly partial: boolean }
      >;
    }) => Effect.Effect<ReadonlyArray<TessayaJob>>;
  }
>()("t3/tessaya/TessayaJobService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workSessions = yield* WorkSessionService;
  const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
    DateTime.formatIso(DateTime.makeUnsafe(ms)),
  );

  const read = (id: string) =>
    sql<TermsRow>`SELECT * FROM fabric_job_terms WHERE work_session_id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))),
      Effect.orDie,
    );

  const write = (terms: TessayaJobTerms) =>
    sql`
      UPDATE fabric_job_terms SET
        goal = ${terms.goal},
        permissions_json = ${encodePermissions(terms.permissions)},
        limits_json = ${encodeLimits(terms.limits)},
        grants_json = ${encodeGrants(terms.grants)},
        lease_json = ${terms.lease == null ? null : encodeLease(terms.lease)},
        phase = ${terms.phase},
        revisions_json = ${encodeRevisions(terms.revisions)},
        schedule_task_id = ${terms.scheduleTaskId},
        worker_instance_id = ${terms.workerInstanceId},
        updated_at = ${terms.updatedAt}
      WHERE work_session_id = ${terms.workSessionId}
    `.pipe(Effect.orDie);

  const change = Effect.fn("BatonJobService.change")(function* (
    id: WorkSessionId,
    f: (terms: TessayaJobTerms, at: string) => TessayaJobTerms,
  ) {
    const current = yield* read(id);
    if (current === null) return null;
    const at = yield* nowIso;
    const next = { ...f(current, at), updatedAt: at };
    yield* write(next);
    return next;
  });
  const create = Effect.fn("BatonJobService.create")(function* (input: JobCreateInput) {
    yield* workSessions.create({
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      objective: input.goal,
    });
    const existing = yield* read(input.id);
    if (existing !== null) return existing;
    const at = yield* nowIso;
    yield* sql`
      INSERT INTO fabric_job_terms (
        work_session_id, goal, permissions_json, limits_json, grants_json, phase, revisions_json,
        schedule_task_id, worker_instance_id, parent_id, part_spec_json, persona, origin, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.goal}, ${encodePermissions(input.permissions)},
        ${encodeLimits(jobLimits(input.limits))}, ${encodeGrants([])}, 'drafting_plan', '[]',
        NULL, ${input.workerInstanceId ?? null}, ${input.parentId ?? null}, ${input.partSpec === undefined ? null : encodePartSpec(input.partSpec)}, ${input.persona ?? null}, ${input.origin ?? null}, ${at}, ${at}
      )
    `.pipe(Effect.orDie);
    return (yield* read(input.id))!;
  });
  const allTerms = Effect.fn("BatonJobService.allTerms")(function* () {
    const rows = yield* sql<TermsRow>`SELECT * FROM fabric_job_terms ORDER BY updated_at DESC`.pipe(
      Effect.orDie,
    );
    return rows.map(fromRow);
  });
  const clearPartSpec = Effect.fn("BatonJobService.clearPartSpec")(function* (id: WorkSessionId) {
    yield* sql`UPDATE fabric_job_terms SET part_spec_json = NULL WHERE work_session_id = ${id}`.pipe(
      Effect.orDie,
    );
  });
  const parts = Effect.fn("BatonJobService.parts")(function* (parentId: WorkSessionId) {
    const rows = yield* sql<TermsRow>`
      SELECT * FROM fabric_job_terms WHERE parent_id = ${parentId} ORDER BY created_at, work_session_id
    `.pipe(Effect.orDie);
    return rows.map(fromRow);
  });
  const personas = Effect.fn("BatonJobService.personas")(function* () {
    const rows = yield* sql<{ readonly work_session_id: string; readonly persona: string | null }>`
      SELECT work_session_id, persona FROM fabric_job_terms
    `.pipe(Effect.orDie);
    return new Map(rows.map((r) => [r.work_session_id, r.persona ?? "executive"]));
  });
  const origins = Effect.fn("BatonJobService.origins")(function* () {
    const rows = yield* sql<{ readonly work_session_id: string; readonly origin: string }>`
      SELECT work_session_id, origin FROM fabric_job_terms WHERE origin IS NOT NULL
    `.pipe(Effect.orDie);
    return new Map(rows.map((r) => [r.work_session_id, r.origin]));
  });
  const view = Effect.fn("BatonJobService.view")(function* (input: {
    readonly entries: ReadonlyArray<TessayaFleetEntry>;
    readonly turns?: ReadonlyMap<string, number>;
    readonly spend?: ReadonlyMap<
      string,
      { readonly tokens: number; readonly dollars: number | null; readonly partial: boolean }
    >;
  }) {
    const all = yield* sql<TermsRow>`SELECT * FROM fabric_job_terms`.pipe(Effect.orDie);
    const now = yield* Clock.currentTimeMillis;
    return all.flatMap((row): ReadonlyArray<TessayaJob> => {
      const terms = fromRow(row);
      const entry = input.entries.find((e) => e.workSessionId === terms.workSessionId);
      if (entry === undefined) return [];
      const minutes = (now - Date.parse(terms.createdAt)) / 60_000;
      return [
        {
          workSessionId: terms.workSessionId,
          title: entry.title,
          goal: terms.goal,
          group: jobGroupFor(entry.state, entry.lifecycle === "settled", terms.phase),
          phase: terms.phase,
          state: entry.state,
          lastActivityAt: entry.updatedAt,
          permissionsSummary: permissionsSummary(
            terms.permissions,
            terms.limits,
            terms.grants,
            terms.lease,
          ),
          limitReached: limitReached(terms.limits, {
            minutes,
            turns: input.turns?.get(terms.workSessionId) ?? 0,
            ...(input.spend?.get(terms.workSessionId)?.dollars == null
              ? {}
              : { dollars: input.spend.get(terms.workSessionId)!.dollars! }),
          }),
          usage: {
            minutes: Math.floor(minutes),
            turns: input.turns?.get(terms.workSessionId) ?? 0,
            ...(input.spend?.has(terms.workSessionId)
              ? {
                  tokens: input.spend.get(terms.workSessionId)!.tokens,
                  dollars: input.spend.get(terms.workSessionId)!.dollars,
                  partial: input.spend.get(terms.workSessionId)!.partial,
                }
              : {}),
          },
          terms,
        } as TessayaJob,
      ];
    });
  });

  const grant = Effect.fn("BatonJobService.grant")(function* (
    id: WorkSessionId,
    channel: TessayaGrantKind,
  ) {
    return yield* change(id, (t, at) => ({ ...t, grants: withGrant(t.grants, channel, at) }));
  });
  const revoke = Effect.fn("BatonJobService.revoke")(function* (
    id: WorkSessionId,
    channel: TessayaGrantKind,
  ) {
    return yield* change(id, (t, at) => ({ ...t, grants: withRevoked(t.grants, channel, at) }));
  });
  const setSchedule = Effect.fn("BatonJobService.setSchedule")(function* (
    id: WorkSessionId,
    taskId: string | null,
  ) {
    return yield* change(id, (t) => ({ ...t, scheduleTaskId: taskId }));
  });

  const lifecycle = (id: WorkSessionId, event: Parameters<typeof reduceJob>[1]) =>
    change(id, (t) => {
      const next = reduceJob({ phase: t.phase, revisions: t.revisions, grants: t.grants }, event);
      // A plan sent back to wait is no longer the plan he said yes to.
      return { ...t, ...next, lease: next.phase === "approved" ? (t.lease ?? null) : null };
    });
  const setLease = Effect.fn("BatonJobService.setLease")(function* (
    id: WorkSessionId,
    lease: TessayaPlanLease | null,
  ) {
    return yield* change(id, (t) => ({ ...t, lease }));
  });
  const planReady = Effect.fn("BatonJobService.planReady")(function* (id: WorkSessionId) {
    return yield* lifecycle(id, { type: "plan_ready" });
  });
  const agree = Effect.fn("BatonJobService.agree")(function* (id: WorkSessionId) {
    return yield* lifecycle(id, { type: "agreed" });
  });
  const refine = Effect.fn("BatonJobService.refine")(function* (
    id: WorkSessionId,
    revision: TessayaJobRevision,
    widens = false,
  ) {
    return yield* lifecycle(id, { type: "refined", revision, widens });
  });

  return TessayaJobService.of({
    planReady,
    agree,
    setLease,
    refine,
    create,
    terms: read,
    allTerms,
    parts,
    personas,
    origins,
    clearPartSpec,
    grant,
    revoke,
    setSchedule,
    view,
  });
});

export const layer = Layer.effect(TessayaJobService, make);
