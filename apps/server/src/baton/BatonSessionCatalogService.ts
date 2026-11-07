// @effect-diagnostics globalDate:off nodeBuiltinImport:off tryCatchInEffectGen:off preferSchemaOverJson:off globalDateInEffect:off
/** The session catalog as a service, so the RPC door, agents and MCP all reach the same methods. */
import * as HostProcess from "@t3tools/shared/HostProcess";
import type {
  BatonCatalogSession,
  BatonCatalogState,
  BatonReattachResult,
  BatonKeptResult,
  BatonCatalogWaitingInput,
  BatonCatalogWaitingResult,
  WatchFinding,
} from "@t3tools/baton-contracts";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as ServerConfig from "../config.ts";

import { AgentSessionImporter } from "../project/AgentSessionImporter.ts";
import { ProjectService } from "../project/ProjectService.ts";

import { LIVE_INSTANCE_ID, liveThreadId, rebindThread } from "./LiveSessionMirror.ts";
import { decideReattach } from "./BindingHealth.ts";
import { BatonWeaveService } from "./BatonWeaveService.ts";
import { resendKept, stampKept } from "./UnboundMessages.ts";
import { retireHandoff, type RetireResult } from "./RetireHandoff.ts";
import { appendResumeLog } from "./ResumeLog.ts";
import { AdoptedSessionService } from "./AdoptedSessionService.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { BatonRecordService } from "./BatonRecordService.ts";
import { isTessayaOwnFolder } from "./ClaudeLiveSessions.ts";
import {
  autoResumeAllowed,
  autoResumedWithin,
  DEFAULT_GRACE_MS,
  MAX_AT_ONCE,
  noteLive,
  classifyTranscriptTail,
  emptyAutoResumeState,
  HOUR_MS,
  markStoppedOnPurpose,
  recordAutoResume,
  RESTART_NOTICE,
  type AutoResumeState,
} from "./AutoResume.ts";
import { classifyHelperThread } from "./HelperThreads.ts";
import * as ProviderInstanceRegistryModule from "../provider/ProviderInstanceRegistry.ts";
import { isProviderAvailable } from "@t3tools/baton-contracts";
import { herdrSend } from "./HerdrSend.ts";
import {
  OUTCOME_MEMORY_MS,
  outcomeRecord,
  outcomesFromRecord,
  watchLiveSessions,
  type WatchdogOutcome,
} from "@t3tools/baton-shared/watch";
import { createSessionCatalog, sendOutcome, type CatalogPorts } from "./SessionCatalog.ts";
import { realCatalogPorts } from "./SessionCatalogLive.ts";

export class BatonSessionCatalogService extends Context.Service<
  BatonSessionCatalogService,
  {
    readonly list: (input: {
      query?: string;
      limit?: number;
      before?: string;
      background?: boolean;
      history?: boolean;
    }) => Effect.Effect<{
      readonly machine: string;
      readonly sessions: ReadonlyArray<BatonCatalogSession>;
      readonly more: boolean;
    }>;
    readonly folders: (input: { query?: string }) => Effect.Effect<{
      readonly folders: ReadonlyArray<{
        cwd: string;
        project: string;
        lastActivityAt: string | null;
      }>;
    }>;
    readonly resume: (input: { sessionId: string; cwd?: string }) => Effect.Effect<{
      readonly state: BatonCatalogState;
      readonly pane: string | null;
      readonly detail: string | null;
      readonly threadId?: string;
    }>;
    readonly create: (input: {
      cwd: string;
      model?: string;
      effort?: string;
      message?: string;
    }) => Effect.Effect<{
      readonly state: BatonCatalogState;
      readonly sessionId: string | null;
      readonly pane: string | null;
      readonly detail: string | null;
      readonly threadId?: string;
    }>;
    /** His terminal sessions left alone: waiting on him too long, or died mid-turn (resumed, or why not). */
    readonly watchFindings: Effect.Effect<ReadonlyArray<WatchFinding>>;
    readonly watchdog: (input: {
      action: "run" | "status" | "stop" | "mark" | "on" | "off";
      sessionId?: string;
    }) => Effect.Effect<{
      readonly enabled: boolean;
      readonly resumed: ReadonlyArray<string>;
      readonly skipped: ReadonlyArray<{ id: string; why: string }>;
    }>;
    readonly retireHandoff: (input: {
      threadId: string;
      twinThreadId: string;
      confirm: string;
      caughtUp: boolean;
      twinOnly?: boolean;
    }) => Effect.Effect<RetireResult>;
    readonly reattach: (input: {
      sessionId: string;
      cwd?: string;
      confirmPane?: string;
    }) => Effect.Effect<typeof BatonReattachResult.Type>;
    readonly kept: (input: {
      threadId: string;
      retryId?: string;
    }) => Effect.Effect<typeof BatonKeptResult.Type>;
    readonly cleanup: (input: { apply: boolean }) => Effect.Effect<{
      readonly found: ReadonlyArray<{ id: string; title: string; project: string; reason: string }>;
      readonly archived: ReadonlyArray<string>;
      readonly left: ReadonlyArray<{ id: string; title: string; reason: string }>;
    }>;
    readonly send: (input: { sessionId: string; text: string; cwd?: string }) => Effect.Effect<{
      readonly state: BatonCatalogState;
      readonly delivered: boolean;
      readonly detail: string | null;
    }>;
    readonly waiting: (
      input: typeof BatonCatalogWaitingInput.Type,
    ) => Effect.Effect<typeof BatonCatalogWaitingResult.Type>;
  }
>()("t3/baton/BatonSessionCatalogService") {}

export const layer = Layer.effect(
  BatonSessionCatalogService,
  Effect.gen(function* () {
    const adopted = yield* AdoptedSessionService;
    const weave = yield* BatonWeaveService;
    const services = yield* Effect.context<never>();
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const resumeLog = (record: Record<string, unknown>) =>
      appendResumeLog(
        NodePath.join(
          Option.isSome(config) ? config.value.logsDir : NodeOS.tmpdir(),
          "baton-resume.ndjson",
        ),
        record,
      );
    const projects = yield* Effect.serviceOption(ProjectService);
    const importer = yield* Effect.serviceOption(AgentSessionImporter);
    const engine = yield* Effect.serviceOption(BatonEngine);
    const record = yield* Effect.serviceOption(BatonRecordService);
    const registry = yield* Effect.serviceOption(
      ProviderInstanceRegistryModule.ProviderInstanceRegistry,
    );
    // No Herdr here (Windows): a missing piece must say so, not fall through to a Herdr program that is not there.
    const noHerdr =
      NodePath.sep === "\\" || (yield* HostProcess.Environment)["BATON_NO_HERDR"] === "1";
    const OWN_FOLDER =
      "That folder belongs to Tessaya's own data, not to a project, so no session is started there.";
    const MISSING =
      "This server could not reach the part that starts threads, so it cannot start a session here.";
    // No Herdr on Windows: the session comes back as a T3 thread on the Claude provider (the importer's resume cursor).
    // The thread must exist before it is offered: a thread id that does not exist opens a blank thread in T3.
    const thread: CatalogPorts["thread"] = !noHerdr
      ? undefined
      : Option.isNone(projects) || Option.isNone(importer) || Option.isNone(engine)
        ? async () => ({ detail: MISSING })
        : (sessionId, cwd) =>
            Effect.runPromiseWith(services)(
              Effect.gen(function* () {
                if (isTessayaOwnFolder(cwd)) return { detail: OWN_FOLDER };
                // The size and time of an import go to the log: a long transcript is slow, and a failure names its session.
                const startedAt = Date.now();
                const info = (yield* Effect.promise(() => real.transcripts(600))).find(
                  (t) => t.sessionId === sessionId,
                );
                let bytes: number | null = null;
                try {
                  bytes = info?.file === undefined ? null : NodeFS.statSync(info.file).size;
                } catch {
                  bytes = null;
                }
                resumeLog({ event: "import-start", sessionId, folder: cwd, bytes });
                yield* Effect.logInfo("Tessaya resume: importing a conversation as a thread", {
                  sessionId,
                  cwd,
                  bytes,
                });
                const found = yield* projects.value.getByWorkspaceRoot(cwd);
                const project = Option.isSome(found)
                  ? found.value
                  : yield* projects.value.create({
                      commandId: CommandId.make(`baton:resume-project:${NodeCrypto.randomUUID()}`),
                      projectId: ProjectId.make(NodeCrypto.randomUUID()),
                      title: NodePath.basename(cwd) || cwd,
                      workspaceRoot: cwd,
                    });
                const result = yield* importer.value.importRecentAgentThreads({
                  projectId: project.id,
                  preferSessionId: sessionId,
                });
                const threadId = ThreadId.make(
                  `import:${defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"))}:${sessionId}`,
                );
                // The import commits events before it returns, but the thread's own record can trail them a moment.
                for (let attempt = 0; attempt < 10; attempt += 1) {
                  if ((yield* engine.value.threadShell(threadId)) !== null) {
                    resumeLog({
                      event: "import-done",
                      outcome: "ok",
                      sessionId,
                      folder: cwd,
                      bytes,
                      ms: Date.now() - startedAt,
                      threadId: String(threadId),
                    });
                    yield* Effect.logInfo("Tessaya resume: the thread is ready", {
                      sessionId,
                      bytes,
                      ms: Date.now() - startedAt,
                    });
                    return { threadId: String(threadId) };
                  }
                  yield* Effect.sleep("500 millis");
                }
                resumeLog({
                  event: "import-done",
                  outcome: "no-thread",
                  sessionId,
                  folder: cwd,
                  bytes,
                  ms: Date.now() - startedAt,
                  threadId: String(threadId),
                  imported: result.importedCount,
                  skipped: result.skippedCount,
                });
                yield* Effect.logWarning(
                  "Tessaya resume: the import finished but no thread exists",
                  {
                    sessionId,
                    bytes,
                    imported: result.importedCount,
                    skipped: result.skippedCount,
                  },
                );
                return {
                  detail: `Tessaya read ${cwd} but could not bring that conversation in as a thread (imported ${result.importedCount}, skipped ${result.skippedCount}). It may be unreadable or too large; baton-resume.ndjson in the logs folder has its size and the reason.`,
                };
              }),
            ).catch((cause) => {
              resumeLog({
                event: "import-done",
                outcome: "failed",
                sessionId,
                folder: cwd,
                error: String(cause instanceof Error ? cause.message : cause).slice(0, 500),
              });
              void Effect.runPromiseWith(services)(
                Effect.logWarning("Tessaya resume failed", {
                  sessionId,
                  cwd,
                  cause: String(cause),
                }),
              );
              return {
                detail: `Tessaya could not bring that conversation back as a thread here: ${String(
                  cause instanceof Error ? cause.message : cause,
                )
                  .replace(/\s+/g, " ")
                  .slice(0, 160)}`,
              };
            });
    // A new session on a machine with no Herdr: a T3 thread in that folder's project, on the Claude provider, with the
    // model, effort and first message asked for. The project is found by its exact folder, so no other project is touched.
    const claudeInstance = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
    const launch: CatalogPorts["launch"] = !noHerdr
      ? undefined
      : Option.isNone(projects) || Option.isNone(engine)
        ? async () => ({ detail: MISSING })
        : (input) =>
            Effect.runPromiseWith(services)(
              Effect.gen(function* () {
                if (isTessayaOwnFolder(input.cwd)) return { detail: OWN_FOLDER };
                if (Option.isSome(registry)) {
                  const instance = yield* registry.value.getInstance(claudeInstance);
                  const snapshot =
                    instance === undefined ? null : yield* instance.snapshot.getSnapshot;
                  if (
                    instance === undefined ||
                    !instance.enabled ||
                    snapshot === null ||
                    !snapshot.installed ||
                    !isProviderAvailable(snapshot)
                  )
                    return {
                      detail:
                        "Claude Code is not installed or not signed in on this machine, so a session cannot start here.",
                    };
                }
                const found = yield* projects.value.getByWorkspaceRoot(input.cwd);
                const project = Option.isSome(found)
                  ? found.value
                  : yield* projects.value.create({
                      commandId: CommandId.make(
                        `baton:new-session-project:${NodeCrypto.randomUUID()}`,
                      ),
                      projectId: ProjectId.make(NodeCrypto.randomUUID()),
                      title: NodePath.basename(input.cwd) || input.cwd,
                      workspaceRoot: input.cwd,
                    });
                const family = (input.model ?? "").trim().toLowerCase();
                const model =
                  family === "" || family === "opus"
                    ? (DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")] ??
                      "claude-opus-5-5")
                    : input.model!.trim();
                const effort = (input.effort ?? "").trim().toLowerCase();
                const threadId = yield* engine.value.launchThread({
                  tag: "new-session",
                  projectId: project.id,
                  title: NodePath.basename(input.cwd) || "New session",
                  modelSelection: {
                    instanceId: claudeInstance,
                    model,
                    ...(effort === "" ? {} : { options: [{ id: "effort", value: effort }] }),
                  },
                  runtimeMode: DEFAULT_RUNTIME_MODE,
                  worktreePath: null,
                  branch: null,
                  text: input.message ?? "",
                });
                return threadId === null
                  ? { detail: "Tessaya could not start that session." }
                  : { threadId: String(threadId) };
              }),
            ).catch((cause) => ({
              detail: `Tessaya could not start that session here: ${String(
                cause instanceof Error ? cause.message : cause,
              )
                .replace(/\s+/g, " ")
                .slice(0, 160)}`,
            }));
    // The auto-resume watchdog's memory: sessions he stopped on purpose, and when each was last resumed.
    const stateFile = NodePath.join(
      Option.isSome(config) ? NodePath.dirname(config.value.dbPath) : NodeOS.homedir(),
      "baton-autoresume.json",
    );
    // Messages sent to a stopped session while it comes back, kept across a restart in the weave table.
    const keptAtStart = yield* weave.catalogKept;
    let keptSaved = Promise.resolve();
    let autoState: AutoResumeState = emptyAutoResumeState;
    try {
      autoState = {
        ...emptyAutoResumeState,
        // @effect-diagnostics-next-line globalJsonInEffect:off - its own state file; the caller treats a bad one as empty.
        ...(JSON.parse(NodeFS.readFileSync(stateFile, "utf8")) as Partial<AutoResumeState>),
      };
    } catch {
      // first run
    }
    const saveAutoState = () => {
      try {
        NodeFS.writeFileSync(stateFile, JSON.stringify(autoState));
      } catch {
        // a read-only data directory only loses the memory across restarts
      }
    };
    const real = realCatalogPorts((pane, text) =>
      Effect.runPromiseWith(services)(herdrSend(adopted, { pane, text, submit: true })).then(
        sendOutcome,
      ),
    );
    // What the watchdog did about each session that died mid-turn, for the watch; one per session, kept from its first sighting.
    const outcomes = new Map<string, WatchdogOutcome>();
    const ports: CatalogPorts = {
      ...real,
      ...(thread === undefined ? {} : { thread }),
      ...(launch === undefined ? {} : { launch }),
      ...(thread === undefined || Option.isNone(engine)
        ? {}
        : {
            threadSend: (threadId: string, text: string) =>
              Effect.runPromiseWith(services)(
                engine.value.sendMessage({
                  tag: "catalog-send",
                  threadId: ThreadId.make(threadId),
                  text,
                }),
              ),
          }),
      autoResumed: (id) => autoResumedWithin(autoState, id, Date.now(), 2 * HOUR_MS),
      crashed: (id) => {
        const o = outcomes.get(id);
        return o === undefined || o.resumed ? null : (o.why ?? "unknown");
      },
      kept: {
        read: () => keptAtStart,
        // Each write is the whole set, so they are saved in order, one after another.
        write: (all) => {
          keptSaved = keptSaved.then(() =>
            Effect.runPromiseWith(services)(
              weave
                .setCatalogKept(all)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Tessaya kept messages not saved", cause),
                  ),
                ),
            ),
          );
        },
      },
    };
    const catalog = createSessionCatalog(ports);
    // On by default on a server; off on a person's own Windows computer until he turns it on (BATON_AUTO_RESUME=on).
    const autoEnabled = () => {
      const setting = (process.env["BATON_AUTO_RESUME"] ?? "").toLowerCase();
      if (setting === "on") return true;
      if (setting === "off") return false;
      return autoState.enabled ?? !noHerdr;
    };
    // The file is read again each pass, so a stop marked from outside (scripts/tessaya/mark-stopped.mjs) is seen at once.
    const reloadAutoState = () => {
      try {
        const onDisk = JSON.parse(
          NodeFS.readFileSync(stateFile, "utf8"),
        ) as Partial<AutoResumeState>;
        autoState = {
          ...autoState,
          stopped: [...new Set([...autoState.stopped, ...(onDisk.stopped ?? [])])],
          ...(onDisk.enabled === undefined ? {} : { enabled: onDisk.enabled }),
        };
      } catch {
        // nothing on disk yet
      }
    };
    const FRESH_MS = 6 * HOUR_MS;
    // Read back from the Record, so a death the watchdog saw before a restart is still reported after it.
    if (Option.isSome(record)) {
      const since = new Date(Date.now() - OUTCOME_MEMORY_MS).toISOString();
      const rows = yield* record.value.query({ kind: "session", since, limit: 500 });
      for (const o of outcomesFromRecord(rows).toReversed()) outcomes.set(o.sessionId, o);
    }
    const noteOutcome = (
      t: { sessionId: string; title: string; cwd: string | null },
      resumed: boolean,
      why?: string,
    ) => {
      const was = outcomes.get(t.sessionId);
      if (was !== undefined && was.resumed === resumed && was.why === why) return;
      for (const [id, o] of outcomes)
        if (Date.now() - o.at > OUTCOME_MEMORY_MS) outcomes.delete(id);
      resumeLog({ event: resumed ? "auto-resumed" : "not-resumed", sessionId: t.sessionId, why });
      if (Option.isSome(record))
        void Effect.runPromiseWith(services)(
          record.value.append({
            ...outcomeRecord({
              sessionId: t.sessionId,
              title: t.title,
              resumed,
              ...(why === undefined ? {} : { why }),
            }),
            actor: "watchdog",
            project: t.cwd === null ? null : NodePath.basename(t.cwd),
            ref: t.sessionId,
          }),
        );
      outcomes.set(t.sessionId, {
        sessionId: t.sessionId,
        title: t.title,
        resumed,
        ...(why === undefined ? {} : { why }),
        at: Date.now(),
      });
    };
    const watchdogRun = async (): Promise<{
      enabled: boolean;
      resumed: string[];
      skipped: Array<{ id: string; why: string }>;
    }> => {
      const resumed: string[] = [];
      const skipped: Array<{ id: string; why: string }> = [];
      reloadAutoState();
      const enabled = autoEnabled();
      const liveNow = await ports.live();
      // What is running now is what may later be brought back; a session only listed in the catalog never is.
      autoState = noteLive(
        autoState,
        liveNow.map((s) => s.sessionId),
        Date.now(),
      );
      saveAutoState();
      if (ports.readTail === undefined) return { enabled, resumed, skipped };
      const live = new Set(liveNow.map((s) => s.sessionId));
      for (const t of await ports.transcripts(60)) {
        if (t.file === undefined || live.has(t.sessionId)) continue;
        const now = Date.now();
        // Only what stopped recently: an old unfinished session was left that way long ago.
        if (now - Date.parse(t.lastActivityAt) > FRESH_MS) continue;
        // With resuming off, a tail is read only to report a session that was live and is not reported yet.
        if (
          !enabled &&
          (autoState.seenLive[t.sessionId] === undefined || outcomes.has(t.sessionId))
        )
          continue;
        const verdict = classifyTranscriptTail(await ports.readTail(t.file).catch(() => ""));
        if (resumed.length >= MAX_AT_ONCE) break;
        const decision = autoResumeAllowed({
          idleMs: now - Date.parse(t.lastActivityAt),
          graceMs: Number(process.env["BATON_AUTO_RESUME_GRACE_MS"] ?? DEFAULT_GRACE_MS),
          sessionId: t.sessionId,
          verdict,
          background: t.background === true,
          // Judged as if on, so a death is still reported where resuming is off.
          enabled: true,
          running: false,
          state: autoState,
          now,
        });
        if (!decision.resume || !enabled) {
          const why = decision.resume ? "auto-resume is off here" : decision.why;
          if (verdict === "unfinished") skipped.push({ id: t.sessionId, why });
          if (decision.resume || decision.capped === true) noteOutcome(t, false, why);
          continue;
        }
        autoState = recordAutoResume(autoState, t.sessionId, now);
        saveAutoState();
        const result = await catalog.resume({
          sessionId: t.sessionId,
          deliver: false,
          ...(t.cwd === null ? {} : { cwd: t.cwd }),
        });
        if (result.state !== "running") {
          skipped.push({ id: t.sessionId, why: result.detail ?? "it could not be resumed" });
          noteOutcome(t, false, result.detail ?? "it could not be resumed");
          continue;
        }
        if (result.pane !== null) await ports.type(result.pane, RESTART_NOTICE);
        else if (result.threadId !== undefined && Option.isSome(engine))
          await Effect.runPromiseWith(services)(
            engine.value.sendMessage({
              tag: "auto-resume",
              threadId: ThreadId.make(result.threadId),
              text: RESTART_NOTICE,
            }),
          );
        resumed.push(t.sessionId);
        noteOutcome(t, true);
      }
      return { enabled, resumed, skipped };
    };
    return BatonSessionCatalogService.of({
      list: Effect.fn("BatonSessionCatalogService.list")(function* (input: {
        query?: string;
        limit?: number;
        before?: string;
        background?: boolean;
        history?: boolean;
      }) {
        const result = yield* Effect.promise(() => catalog.list(input));
        if (Option.isNone(engine)) return result;
        const e = engine.value;
        // Which provider instance answers each live session's thread: a handoff twin is not the session's own pane.
        const sessions = yield* Effect.forEach(result.sessions, (row) =>
          row.source !== "live"
            ? Effect.succeed(row)
            : e.threadShell(liveThreadId(row.id)).pipe(
                Effect.map((shell) => ({
                  ...row,
                  answeredBy: shell === null ? null : String(shell.providerInstanceId),
                })),
              ),
        );
        return { ...result, sessions };
      }),
      kept: Effect.fn("BatonSessionCatalogService.kept")(
        function* (input: { threadId: string; retryId?: string }) {
          if (Option.isNone(engine)) return { messages: [], retry: null } as const;
          yield* stampKept(engine.value, weave);
          let retry: "sent" | "busy" | "none" | null = null;
          if (input.retryId !== undefined) {
            const result = yield* resendKept(engine.value, weave, {
              threadId: input.threadId,
              entryId: input.retryId,
              bound: false,
            });
            retry = result.sent > 0 ? "sent" : result.failed > 0 ? "busy" : "none";
          }
          const messages = (yield* weave.unbound)
            .filter((row) => row.thread === input.threadId)
            .map(({ id, at, text }) => ({ id, at: new Date(at).toISOString(), text }));
          return { messages, retry };
        },
        Effect.catchCause(() => Effect.succeed({ messages: [], retry: null } as const)),
      ),
      reattach: Effect.fn("BatonSessionCatalogService.reattach")(
        function* (input: { sessionId: string; cwd?: string; confirmPane?: string }) {
          if (Option.isNone(engine))
            return { state: "not-running", pane: null, detail: "No thread engine here." } as const;
          const e = engine.value;
          const threadId = liveThreadId(input.sessionId);
          const shell = yield* e.threadShell(threadId);
          if (shell === null)
            return {
              state: "not-running",
              pane: null,
              detail: "There is no thread for that session.",
            } as const;
          const live = yield* Effect.promise(() => ports.live());
          const byId = live.find((s) => s.sessionId === input.sessionId);
          const folder =
            input.cwd ??
            (yield* Effect.promise(() =>
              catalog.list({ query: input.sessionId, limit: 5 }),
            )).sessions.find((s) => s.id === input.sessionId)?.cwd ??
            null;
          const active = yield* e.activeProviderThread(threadId);
          const action = decideReattach({
            facts: {
              threadId: String(threadId),
              sessionId: input.sessionId,
              session: byId === undefined ? null : { status: byId.status, pane: byId.herdrPane },
              thread: {
                instanceId: String(shell.providerInstanceId),
                nativeId: active?.nativeThreadRef?.nativeId ?? null,
                running: shell.activeRunId !== null && shell.activeRunId !== undefined,
              },
            },
            folderSessions:
              byId !== undefined || folder === null
                ? []
                : live
                    .filter((s) => s.cwd === folder)
                    .map((s) => ({ sessionId: s.sessionId, pane: s.herdrPane })),
            confirmPane: input.confirmPane ?? null,
          });
          if (action.kind === "already-bound")
            return {
              state: "already-bound",
              pane: byId?.herdrPane ?? null,
              detail: "Already bound to its session.",
            } as const;
          if (action.kind === "wait")
            return {
              state: "busy",
              pane: null,
              detail: "A turn is running; try again after it.",
            } as const;
          if (action.kind === "confirm")
            return {
              state: "confirm",
              pane: action.pane,
              detail: `Reattach to ${action.pane}?`,
            } as const;
          if (action.kind === "none")
            return {
              state: "not-running",
              pane: null,
              detail: "No running session to reattach to.",
            } as const;
          yield* rebindThread(e, {
            threadId,
            sessionId: action.sessionId,
            instance: action.instance,
            native: action.native,
            at: Date.now(),
          });
          appendResumeLog(
            NodePath.join(
              Option.isSome(config) ? config.value.logsDir : NodeOS.tmpdir(),
              "baton-mirror.ndjson",
            ),
            {
              event: "reattached",
              thread: String(threadId),
              sessionId: action.sessionId,
              pane: action.pane,
            },
          );
          return {
            state: "reattached",
            pane: action.pane,
            detail: "Bound to its running session.",
          } as const;
        },
        Effect.catchCause(() =>
          Effect.succeed({
            state: "not-running" as const,
            pane: null,
            detail: "Could not reattach this thread.",
          }),
        ),
      ),
      folders: Effect.fn("BatonSessionCatalogService.folders")(function* (input: {
        query?: string;
      }) {
        return yield* Effect.promise(() => catalog.folders(input));
      }),
      resume: Effect.fn("BatonSessionCatalogService.resume")(function* (input: {
        sessionId: string;
        cwd?: string;
      }) {
        return yield* Effect.promise(() => catalog.resume(input));
      }),
      create: Effect.fn("BatonSessionCatalogService.create")(function* (input: {
        cwd: string;
        model?: string;
        effort?: string;
        message?: string;
      }) {
        return yield* Effect.promise(() => catalog.create(input));
      }),
      watchFindings: Effect.promise(async () =>
        watchLiveSessions(await ports.live().catch(() => []), [...outcomes.values()], Date.now()),
      ),
      watchdog: Effect.fn("BatonSessionCatalogService.watchdog")(function* (input: {
        action: "run" | "status" | "stop" | "mark" | "on" | "off";
        sessionId?: string;
      }) {
        if ((input.action === "stop" || input.action === "mark") && input.sessionId !== undefined) {
          autoState = markStoppedOnPurpose(autoState, input.sessionId);
          saveAutoState();
          // "stop" also ends the process here (a live session on this machine); "mark" is for one stopped from outside.
          if (input.action === "stop") {
            const target = (yield* Effect.promise(() => ports.live())).find(
              (s) => s.sessionId === input.sessionId,
            );
            if (target !== undefined) {
              try {
                process.kill(target.pid, "SIGTERM");
              } catch {
                // already gone
              }
            }
          }
        }
        if (input.action === "on" || input.action === "off") {
          autoState = { ...autoState, enabled: input.action === "on" };
          saveAutoState();
        }
        if (input.action === "run") return yield* Effect.promise(() => watchdogRun());
        return { enabled: autoEnabled(), resumed: [], skipped: [] };
      }),
      retireHandoff: Effect.fn("BatonSessionCatalogService.retireHandoff")(function* (input) {
        if (Option.isNone(engine))
          return { state: "refused", detail: "No thread engine here.", undoFile: null } as const;
        const e = engine.value;
        const id = (value: string) => ThreadId.make(value);
        const result = yield* retireHandoff(
          {
            shell: (threadId) =>
              Effect.map(e.threadShell(id(threadId)), (shell) =>
                shell === null
                  ? null
                  : {
                      instanceId: String(shell.providerInstanceId),
                      running: shell.activeRunId !== null && shell.activeRunId !== undefined,
                      archived: shell.archivedAt !== null && shell.archivedAt !== undefined,
                    },
              ),
            selectLive: (threadId) =>
              e.setThreadSelection({
                tag: "retire-handoff",
                threadId: id(threadId),
                modelSelection: { instanceId: LIVE_INSTANCE_ID, model: "live" },
              }),
            activeInstance: (threadId) =>
              Effect.map(e.activeProviderThread(id(threadId)), (p) =>
                p === null ? null : String(p.providerInstanceId),
              ),
            archive: (threadId) =>
              e.archiveThread({ tag: "retire-handoff", threadId: id(threadId) }),
            remove: (threadId) => e.deleteThread({ tag: "retire-handoff", threadId: id(threadId) }),
            writeUndo: (json) => {
              const file = NodePath.join(
                Option.isSome(config) ? NodePath.dirname(config.value.dbPath) : NodeOS.homedir(),
                `baton-retire-undo-${Date.now()}.json`,
              );
              try {
                NodeFS.writeFileSync(file, json);
                return file;
              } catch {
                return null;
              }
            },
          },
          input,
        );
        resumeLog({
          event: "retire-handoff",
          thread: input.threadId,
          twin: input.twinThreadId,
          ...result,
        });
        return result;
      }),
      cleanup: Effect.fn("BatonSessionCatalogService.cleanup")(function* (input: {
        apply: boolean;
      }) {
        if (Option.isNone(engine)) return { found: [], archived: [], left: [] };
        const e = engine.value;
        const shells = yield* e.threadShells;
        const projects = yield* e.projects;
        const root = new Map(projects.map((p) => [String(p.id), p.workspaceRoot] as const));
        const found: Array<{ id: string; title: string; project: string; reason: string }> = [];
        const left: Array<{ id: string; title: string; reason: string }> = [];
        const archived: string[] = [];
        for (const shell of shells) {
          const projectRoot = root.get(String(shell.projectId)) ?? null;
          const title = String(shell.title ?? "");
          const looks =
            isTessayaOwnFolder(projectRoot) ||
            /^(userdata-[0-9a-f]+ · |Add sentence punctuation|shell in .*\(deleted\))/i.test(title);
          if (!looks) continue;
          const messages = (yield* e.recentMessages(shell.id, 2)).length;
          const verdict = classifyHelperThread({
            title,
            projectRoot,
            running: shell.activeRunId !== null && shell.activeRunId !== undefined,
            messages,
          });
          if (verdict === null) continue;
          if (verdict.kind === "leave") {
            left.push({ id: String(shell.id), title, reason: verdict.reason });
            continue;
          }
          found.push({
            id: String(shell.id),
            title,
            project: projectRoot ?? "",
            reason: verdict.reason,
          });
          if (
            input.apply &&
            (yield* e.archiveThread({ tag: "helper-cleanup", threadId: shell.id }))
          )
            archived.push(String(shell.id));
        }
        return { found, archived, left };
      }),
      send: Effect.fn("BatonSessionCatalogService.send")(function* (input: {
        sessionId: string;
        text: string;
        cwd?: string;
      }) {
        return yield* Effect.promise(() => catalog.send(input));
      }),
      waiting: Effect.fn("BatonSessionCatalogService.waiting")(function* (
        input: typeof BatonCatalogWaitingInput.Type,
      ) {
        return yield* Effect.sync(() => catalog.waitingFor(input.sessionId, input.discard));
      }),
    });
  }),
);
