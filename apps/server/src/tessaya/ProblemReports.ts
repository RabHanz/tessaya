// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off preferSchemaOverJson:off tryCatchInEffectGen:off
/**
 * Problem reports and the developer feed (Director, 18 Nov: "send back the problems for you to fix"). One channel in
 * the spine: every vessel's actions already reach the action log, so the feed is its live tail and triage reads it.
 * Off (the default) collects nothing; silent files reports without a word; developer (the owner) also keeps the feed,
 * writes it to files the maintainers tail, and she says one line per report through the pulse.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BATON_REPORTS_WS_METHODS,
  ReportsView as ReportsViewSchema,
  ReportsError,
  type FeedEvent,
  type FeedbackMode,
  type ProblemBundle,
  type ProblemReport,
  type ReportsView,
} from "@t3tools/tessaya-contracts";
import { diagnose } from "@t3tools/tessaya-shared/health";
import {
  admit,
  askedKey,
  bundleOf,
  faultsOf,
  feedEventOf,
  issueOf,
  reportLine,
} from "@t3tools/tessaya-shared/problemReport";
import { findGaps, newEventId, type ActorKind } from "@t3tools/tessaya-shared/provenance";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ActionLog, emitAction, onAction } from "../provenance/ActionLog.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TessayaHealth from "./TessayaHealth.ts";
import { TessayaMemorySync } from "./TessayaMemorySync.ts";

const BEAT = "2 minutes";
const FEED_MAX = 2_000;
const FEED_FILE_DAYS = 7;
const ANNOUNCE_MS = 30 * 60_000;
const DELETED_KEEP_MS = 30 * 86_400_000;
const ISSUE_REPO = "RabHanz/tessaya";
const ISSUE_LABEL = "tessaya-report";

interface Row {
  readonly id: string;
  readonly key: string;
  readonly origin: string;
  readonly at: number;
  readonly updated_at: number;
  readonly status: ProblemReport["status"];
  readonly source: ProblemReport["source"];
  readonly title: string;
  readonly bundle_json: string | null;
  readonly issue_url: string | null;
}

const fromRow = (r: Row): ProblemReport => ({
  id: r.id,
  key: r.key,
  origin: r.origin,
  at: r.at,
  updatedAt: r.updated_at,
  status: r.status,
  source: r.source,
  title: r.title,
  bundle: r.bundle_json === null ? null : (JSON.parse(r.bundle_json) as ProblemBundle),
  issueUrl: r.issue_url,
});

export interface FileInput {
  readonly source: "asked" | "proactive";
  readonly symptom: string;
  readonly guess: string;
  readonly vessel: string | null;
  /** Stable per cause; an ask is keyed by its words. */
  readonly key?: string;
  /** The events that show it; their cause chains come too. */
  readonly eventIds?: ReadonlyArray<string>;
  readonly by: { readonly kind: ActorKind; readonly id: string };
}

export class ProblemReports extends Context.Service<
  ProblemReports,
  {
    readonly view: Effect.Effect<ReportsView>;
    readonly list: (q: {
      readonly status?: "open" | "filed" | "withdrawn";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<ProblemReport>>;
    readonly get: (id: string) => Effect.Effect<ProblemReport | null>;
    /** Files one report; `say` is the one line for him (or why it was not sent). */
    readonly file: (
      input: FileInput,
    ) => Effect.Effect<{ readonly id: string | null; readonly say: string }>;
    readonly call: (
      op: "withdraw" | "delete",
      id: string,
    ) => Effect.Effect<ReportsView, ReportsError>;
    readonly syncSince: (since: number) => Effect.Effect<ReportsView>;
    /** The feed after a cursor; waits up to `waitSeconds` for the next event when there is none. */
    readonly feed: (input: {
      readonly after?: number;
      readonly waitSeconds?: number;
      readonly vessel?: string;
    }) => Effect.Effect<{
      readonly on: boolean;
      readonly events: ReadonlyArray<FeedEvent>;
      readonly next: number;
    }>;
    /** Her own reports from the last half hour, for the pulse to say in one line; only in developer mode. */
    readonly toAnnounce: Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly text: string }>
    >;
    /** One triage pass now (the beat runs it every two minutes); how many reports it filed. */
    readonly triage: Effect.Effect<number>;
  }
>()("t3/tessaya/ProblemReports") {}

const OFF_SAY =
  "Problem reports are off on this server, so nothing was sent. He can turn them on in Settings → Health.";

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const log = yield* ActionLog;
  const sync = yield* Effect.serviceOption(TessayaMemorySync);
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const env = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const origin = Option.isSome(env) ? String(yield* env.value.getEnvironmentId) : "local";
  const dir = NodePath.join(config.stateDir, "tessaya-feedback");

  const prefs = settings.getSettings.pipe(
    Effect.map((s) => ({ mode: s.tessayaFeedback, github: s.tessayaFeedbackGithub })),
    Effect.orElseSucceed(() => ({ mode: "off" as FeedbackMode, github: false })),
  );
  // The listener runs outside Effect on every action, so it reads the mode the beat last saw.
  let mode: FeedbackMode = (yield* prefs).mode;

  // ── the feed: a bounded ring, a live hub, and daily files the maintainers tail ──
  const ring: Array<{ readonly seq: number; readonly event: FeedEvent }> = [];
  let seq = 0;
  let lines: Array<string> = [];
  const hub = yield* PubSub.sliding<FeedEvent>(512);
  const stop = onAction((e) => {
    if (mode !== "developer") return;
    const event = feedEventOf(e);
    if (event === null) return;
    ring.push({ seq: ++seq, event });
    if (ring.length > FEED_MAX) ring.splice(0, ring.length - FEED_MAX);
    lines.push(JSON.stringify(event));
    PubSub.publishUnsafe(hub, event);
  });
  yield* Effect.addFinalizer(() => Effect.sync(stop));

  const dayFile = (prefix: string, at: number) =>
    NodePath.join(dir, `${prefix}-${new Date(at).toISOString().slice(0, 10)}.jsonl`);
  const writeFiles = Effect.gen(function* () {
    if (lines.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const batch = lines;
    lines = [];
    yield* Effect.sync(() => {
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.appendFileSync(dayFile("feed", now), `${batch.join("\n")}\n`);
      for (const name of NodeFS.readdirSync(dir))
        if (
          name.startsWith("feed-") &&
          name < `feed-${new Date(now - FEED_FILE_DAYS * 86_400_000).toISOString().slice(0, 10)}`
        )
          NodeFS.rmSync(NodePath.join(dir, name), { force: true });
    });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("feedback: feed file not written", { cause })),
  );
  yield* writeFiles.pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped);

  const filterVessel = (vessel: string | undefined) => (e: FeedEvent) =>
    vessel === undefined || e.vessel === vessel;
  const after = (cursor: number, vessel: string | undefined) => {
    const events = ring.filter((r) => r.seq > cursor && filterVessel(vessel)(r.event));
    return { events: events.map((r) => r.event), next: ring.at(-1)?.seq ?? cursor };
  };

  // ── the queue ──
  const rows = (where: Statement.Fragment, limit: number) =>
    sql<Row>`SELECT * FROM tessaya_problem_reports WHERE ${where} ORDER BY at DESC LIMIT ${limit}`.pipe(
      Effect.map((rs) => rs.map(fromRow)),
      Effect.orElseSucceed((): ReadonlyArray<ProblemReport> => []),
    );
  const list = (q: { readonly status?: "open" | "filed" | "withdrawn"; readonly limit?: number }) =>
    rows(
      q.status === undefined ? sql`status != 'deleted'` : sql`status = ${q.status}`,
      Math.min(q.limit ?? 50, 200),
    );
  const get = (id: string) =>
    Effect.map(rows(sql`id = ${id} AND status != 'deleted'`, 1), (rs) => rs[0] ?? null);

  const upsert = (r: ProblemReport) =>
    sql`INSERT INTO tessaya_problem_reports ${sql.insert({
      id: r.id,
      key: r.key,
      origin: r.origin,
      at: r.at,
      updated_at: r.updatedAt,
      status: r.status,
      source: r.source,
      title: r.title,
      bundle_json: r.bundle === null ? null : JSON.stringify(r.bundle),
      issue_url: r.issueUrl,
    })}
    ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status,
      bundle_json = excluded.bundle_json, issue_url = excluded.issue_url
    WHERE excluded.updated_at > tessaya_problem_reports.updated_at`.pipe(Effect.orDie);

  /** One line per change to reports.jsonl beside the feed: the durable file the maintainers read. */
  const record = (r: ProblemReport) =>
    Effect.sync(() => {
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.appendFileSync(NodePath.join(dir, "reports.jsonl"), `${JSON.stringify(r)}\n`);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("feedback: report file not written", { cause }),
      ),
    );

  const openIssue = Effect.fn("ProblemReports.openIssue")(function* (r: ProblemReport) {
    if (Option.isNone(spawner)) return;
    const issue = issueOf(r);
    const url = yield* Effect.gen(function* () {
      const child = yield* spawner.value.spawn(
        ChildProcess.make("gh", [
          "issue",
          "create",
          "--repo",
          ISSUE_REPO,
          "--label",
          ISSUE_LABEL,
          "--title",
          issue.title,
          "--body",
          issue.body,
        ]),
      );
      const [out, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      );
      return code === 0 ? (/https:\/\/\S+/.exec(out ?? "")?.[0] ?? null) : null;
    }).pipe(
      Effect.scoped,
      Effect.timeout(Duration.seconds(30)),
      Effect.orElseSucceed(() => null),
    );
    if (url === null) return yield* Effect.logWarning("feedback: the GitHub issue was not opened");
    const filed = {
      ...r,
      status: "filed" as const,
      issueUrl: url,
      updatedAt: yield* Clock.currentTimeMillis,
    };
    yield* upsert(filed);
    yield* record(filed);
  });

  const eventsFor = Effect.fn("ProblemReports.eventsFor")(function* (
    ids: ReadonlyArray<string>,
    since: number,
  ) {
    const chains = yield* Effect.forEach(ids.slice(-5), (id) => log.trace(id, 6));
    const failures = yield* log.list({ since, outcome: "fail", limit: 15 });
    const turns = yield* log.list({ since, kindPrefix: "room.voice_id", limit: 10 });
    const seen = new Set<string>();
    return [...chains.flat(), ...failures, ...turns].flatMap((e) => {
      if (seen.has(e.id)) return [];
      seen.add(e.id);
      const f = feedEventOf(e);
      return f === null ? [] : [f];
    });
  });

  const file = Effect.fn("ProblemReports.file")(function* (input: FileInput) {
    const current = yield* prefs;
    mode = current.mode;
    if (current.mode === "off") return { id: null, say: OFF_SAY };
    const now = yield* Clock.currentTimeMillis;
    const key = input.key ?? askedKey(input.symptom, input.vessel);
    const recent = yield* rows(sql`at >= ${now - 86_400_000}`, 200);
    const verdict = admit(key, input.source, recent, now);
    if (verdict !== "ok")
      return {
        id: null,
        say:
          verdict === "duplicate"
            ? "That one is already reported in the last day, so I did not send it again."
            : "I have sent a few reports already this hour, so this one waits.",
      };
    const snapshot = yield* TessayaHealth.snapshot();
    const report: ProblemReport = {
      id: newEventId(now, (n) => new Uint8Array(NodeCrypto.randomBytes(n))),
      key,
      origin,
      at: now,
      updatedAt: now,
      status: "open",
      source: input.source,
      title: input.symptom.slice(0, 160),
      bundle: bundleOf({
        symptom: input.symptom,
        guess: input.guess,
        vessel: input.vessel,
        diagnosis: diagnose(snapshot, "any"),
        health: snapshot,
        events: yield* eventsFor(input.eventIds ?? [], now - 30 * 60_000),
        versions: { server: packageJson.version, host: NodeOS.hostname() },
      }),
      issueUrl: null,
    };
    yield* upsert(report);
    yield* record(report);
    yield* emitAction({
      kind: "problem.report",
      actor: { kind: input.by.kind, id: input.by.id, certainty: 1 },
      subject: report.title,
      outcome: input.source,
      evidence: (input.eventIds ?? []).slice(-4).map((ref) => ({ kind: "event", ref })),
      data: { report: report.id, vessel: input.vessel ?? undefined },
    });
    if (current.github)
      yield* openIssue(report).pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
    return { id: report.id, say: reportLine(report.title) };
  });

  const view = Effect.gen(function* () {
    const p = yield* prefs;
    return { mode: p.mode, github: p.github, reports: yield* list({}) } satisfies ReportsView;
  });

  // ── triage: the log's bug rules and her health, every two minutes while reports are on ──
  let heldBefore = new Set<string>();
  const triage = Effect.gen(function* () {
    const p = yield* prefs;
    mode = p.mode;
    if (p.mode === "off") return 0;
    const now = yield* Clock.currentTimeMillis;
    const diagnosis = diagnose(yield* TessayaHealth.snapshot(), "any");
    const faults = faultsOf({
      findings: findGaps(yield* log.list({ since: now - 3_600_000, limit: 5_000 })),
      diagnosis,
      heldBefore,
    });
    heldBefore = new Set(diagnosis.findings.map((f) => f.key));
    let filed = 0;
    for (const f of faults) {
      const out = yield* file({
        source: "proactive",
        key: f.key,
        symptom: f.title,
        guess: f.guess,
        vessel: f.vessel,
        eventIds: f.eventIds,
        by: { kind: "system", id: "triage" },
      });
      if (out.id !== null) filed++;
    }
    yield* sql`DELETE FROM tessaya_problem_reports WHERE status = 'deleted' AND updated_at < ${now - DELETED_KEEP_MS}`.pipe(
      Effect.ignore,
    );
    return filed;
  }).pipe(Effect.withSpan("ProblemReports.triage"));

  // ── the mirror: each paired peer's changes since the last one held from it, over the memory-sync credential ──
  const cursors = new Map<string, number>();
  const mirror = Effect.gen(function* () {
    if (Option.isNone(sync)) return;
    const answers = yield* sync.value.askPeers(
      BATON_REPORTS_WS_METHODS.call,
      // One ask for every peer, so from the oldest cursor; what a peer already sent is skipped below.
      { op: "sync", since: cursors.size === 0 ? 0 : Math.min(...cursors.values()) },
      ReportsViewSchema,
    );
    for (const { environmentId, value } of answers) {
      const fresh = value.reports.filter((r) => r.updatedAt > (cursors.get(environmentId) ?? 0));
      yield* Effect.forEach(fresh, upsert, { discard: true });
      const newest = Math.max(0, ...value.reports.map((r) => r.updatedAt));
      cursors.set(environmentId, Math.max(cursors.get(environmentId) ?? 0, newest));
    }
  }).pipe(Effect.withSpan("ProblemReports.mirror"));

  yield* Effect.all([triage, mirror]).pipe(
    Effect.catchCause((cause) => Effect.logWarning("feedback: triage or mirror failed", { cause })),
    Effect.repeat(Schedule.spaced(BEAT)),
    Effect.delay("1 minute"),
    Effect.forkScoped,
  );

  return ProblemReports.of({
    view,
    list,
    get,
    file,
    call: Effect.fn("ProblemReports.call")(function* (op, id) {
      const r = yield* get(id);
      if (r === null)
        return yield* new ReportsError({ reason: "There is no report with that id." });
      const updatedAt = Math.max(yield* Clock.currentTimeMillis, r.updatedAt + 1);
      const next: ProblemReport =
        op === "withdraw"
          ? { ...r, status: "withdrawn", updatedAt }
          : { ...r, status: "deleted", bundle: null, updatedAt };
      yield* upsert(next);
      yield* record(next);
      return yield* view;
    }),
    syncSince: Effect.fn("ProblemReports.syncSince")(function* (since) {
      const rs = yield* sql<Row>`SELECT * FROM tessaya_problem_reports WHERE updated_at > ${since}
        ORDER BY updated_at ASC LIMIT 200`.pipe(Effect.orElseSucceed((): ReadonlyArray<Row> => []));
      const p = yield* prefs;
      return { mode: p.mode, github: p.github, origin, reports: rs.map(fromRow) };
    }),
    feed: Effect.fn("ProblemReports.feed")(function* (input) {
      mode = (yield* prefs).mode;
      if (mode !== "developer") return { on: false, events: [], next: seq };
      const cursor = input.after ?? Math.max(0, seq - 50);
      const ready = after(cursor, input.vessel);
      if (ready.events.length > 0 || (input.waitSeconds ?? 0) === 0) return { on: true, ...ready };
      // An event landing between the read above and this wait is returned by the next call, never lost.
      yield* Stream.fromPubSub(hub).pipe(
        Stream.filter(filterVessel(input.vessel)),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeoutOption(Duration.seconds(input.waitSeconds ?? 0)),
      );
      return { on: true, ...after(cursor, input.vessel) };
    }),
    toAnnounce: Effect.gen(function* () {
      if ((yield* prefs).mode !== "developer") return [];
      const now = yield* Clock.currentTimeMillis;
      const mine = yield* rows(
        sql`source = 'proactive' AND origin = ${origin} AND at >= ${now - ANNOUNCE_MS} AND status != 'deleted'`,
        5,
      );
      return mine.map((r) => ({
        id: `report:${r.id}`,
        text: `She sent the developers a problem report. Tell him in one short line, in your words: "${reportLine(r.title)}"`,
      }));
    }),
    triage,
  });
});

export const layer = Layer.effect(ProblemReports, make);
