// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BATON_ACCOUNT_WS_METHODS,
  BATON_DESKTOP_SETTINGS_WS_METHODS,
  BATON_JOB_WS_METHODS,
  type TessayaJobLeadInput,
  BATON_MEMORY_WS_METHODS,
  BATON_BRAIN_WS_METHODS,
  TESSAYA_ACTIVITY_WS_METHODS,
  BATON_PROMPT_LAB_WS_METHODS,
  BATON_ORCHESTRATION_WS_METHODS,
  BATON_PHONE_WS_METHODS,
  BATON_RECORD_WS_METHODS,
  BATON_SESSIONS_WS_METHODS,
  BATON_WATCH_WS_METHODS,
  BATON_WS_METHODS,
  BATON_WEAVE_WS_METHODS,
  PHONE_PAIRING_TOOL,
  TessayaDesktopState,
  type TessayaPersonaChangeInput,
  type TessayaPersonaChangeResult,
  type TessayaRecordEntry,
  type TessayaScratchNote,
  type TessayaScratchpadAct,
  type TessayaScratchpadResult,
} from "@t3tools/tessaya-contracts";
import { activityText } from "../../../provenance/activityText.ts";
import { houseZone, isoIn } from "../../../tessaya/houseZone.ts";
import * as TessayaHealth from "../../../tessaya/TessayaHealth.ts";
import { ProblemReports } from "../../../tessaya/ProblemReports.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { MEMORY_UNLEARN_CLIENT } from "@t3tools/tessaya-shared/memory";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { accountByWords } from "@t3tools/tessaya-shared/accountRoom";
import { recordText } from "@t3tools/tessaya-shared/audit";
import { countdownText } from "@t3tools/tessaya-shared/upcoming";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { ownerDoc } from "@t3tools/tessaya-shared/ownerProfile";

import { clientMessageFrom, withAgentMessageFrom } from "../../../tessaya/AgentMessageFrom.ts";
import { gateMessage } from "../../../tessaya/AgentMessageGate.ts";
import { AskOwner } from "../../../tessaya/TessayaPhoneInbox.ts";
import { DesktopSettingsCaller } from "../../../tessaya/TessayaDesktopSettings.ts";
import packageJson from "../../../../package.json" with { type: "json" };
import * as TessayaRpcHandlers from "../../../tessaya/TessayaRpcHandlers.ts";
import { TessayaRuntime } from "../../../tessaya/TessayaRpcHandlers.ts";
import { serveArbiter } from "../../../home/VoiceArbiter.ts";
import { workNow } from "../../../tessaya/TessayaSessionsAcross.ts";
import { TessayaTurn, TurnOrigin } from "../../../tessaya/TessayaTurn.ts";
import { TessayaUpcoming } from "../../../tessaya/TessayaUpcoming.ts";
import { MemoryViewer, TessayaMemoryService } from "../../../tessaya/TessayaMemoryService.ts";
import { emitAction } from "../../../tessaya/turnActions.ts";
import { castLine, castOp, TessayaCast } from "../../../tessaya/TessayaCast.ts";
import { bodyHolderLine } from "../../../tessaya/TessayaBody.ts";
import { TessayaVocabulary } from "../../../tessaya/TessayaVocabulary.ts";
import {
  TessayaVoiceLibrary,
  type VoiceRefusedError,
  voiceFor,
} from "../../../tessaya/TessayaVoiceLibrary.ts";
import { Consent, grantWho, hisOwnTurn } from "../../../tessaya/consent.ts";
import { grantLabel, grantNamed } from "@t3tools/tessaya-shared/consent";
import { pronunciations } from "../../../tessaya/Pronunciations.ts";
import { scratchpad } from "../../../tessaya/TessayaScratchpad.ts";
import * as ServerConfig from "../../../config.ts";
import { ownerDocs } from "../../../tessaya/OperatingSystemPack.ts";
import { changePersona } from "../../../tessaya/PersonaChanges.ts";
import {
  changeGroup,
  groupConversation,
  HIS_GROUP,
  type GroupChange,
} from "../../../tessaya/GroupTalk.ts";
import { TessayaWake } from "../../../tessaya/TessayaWake.ts";
import * as Pulse from "../../../tessaya/TessayaPulse.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as PhonePairing from "../../../tessaya/PhonePairing.ts";
import { readCaller } from "../../threadAccess.ts";
import * as BodyHandlers from "../body/handlers.ts";
import * as DeviceHandlers from "../devices/handlers.ts";
import * as HomeHandlers from "../home/handlers.ts";
import { vesselOf } from "../home/handlers.ts";
import * as JobsHandlers from "../jobs/handlers.ts";
import * as MembersHandlers from "../members/handlers.ts";
import * as PeopleHandlers from "../people/handlers.ts";
import * as CommsHandlers from "../comms/handlers.ts";
import * as PersonaOpsHandlers from "../personaOps/handlers.ts";
import * as SettingsHandlers from "../settings/handlers.ts";
import { asForwarded, fromPeers, onPeer } from "../../../peer/PeerVessels.ts";
import { OpenInTerminalReply, TessayaToolkit } from "./tools.ts";
import { receiveAtBrain } from "../../../tessaya/BrainReceive.ts";

const decodeAsked = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.optional(Schema.Boolean),
    status: Schema.optional(Schema.String),
    line: Schema.optional(Schema.String),
  }),
);

/** A name the caller chose, as one capped line, quoted for the Record. */
const quoted = (text: string): string => JSON.stringify(recordText(text, 100));

const decodeStateReply = Schema.decodeUnknownOption(
  Schema.Struct({
    connected: Schema.Boolean,
    at: Schema.NullOr(Schema.String),
    state: Schema.NullOr(TessayaDesktopState),
  }),
);

/** What she says after a wake-word change, or why it was refused. */
const wakeChangeLine = (
  input: {
    readonly word: string;
    readonly change: "rollback" | "cancel" | "retrain";
    readonly version?: number | undefined;
  },
  done: { readonly refused: string } | { readonly ok: true },
): { readonly ok: boolean; readonly line: string } =>
  "refused" in done
    ? { ok: false, line: done.refused }
    : {
        ok: true,
        line:
          input.change === "rollback"
            ? `${input.word} is back on version ${input.version} on every device.`
            : input.change === "cancel"
              ? `Stopped training ${input.word}. Say retrain to start it again.`
              : `${input.word} will be trained again; devices switch once the new model passes.`,
      };

const failed = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message:
      typeof cause === "object" && cause !== null && "reason" in cause
        ? String(cause.reason)
        : "Tessaya could not answer that.",
  });

/** The household's zone, read with the MCP runtime's own services. */
const runtimeZone = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  return yield* context === null ? houseZone() : houseZone().pipe(Effect.provideContext(context));
});

const agoOf = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} days ago`;
};

/** The Record on the house's clock, each row with its age, so no model reads UTC as local (13 Nov). */
/**
 * Who may use the prompt lab from a tool: the owner only. Making a variant live or rolling back is his, by voice (the
 * room asks his yes first) or in Settings; an agent from outside may look, save and run, never change what is live.
 */
export const labRefusal = (
  action: string,
  origin: { readonly member?: string | null } | null,
): string | null =>
  origin !== null && origin.member !== undefined && origin.member !== OWNER_MEMBER_ID
    ? "The prompt lab is the owner's."
    : origin === null && (action === "promote" || action === "rollback")
      ? "Only he makes a prompt live or rolls it back: in Settings, Brain, Prompt lab, or by asking Tessaya."
      : null;

export const onHouseClock = (
  entries: ReadonlyArray<TessayaRecordEntry>,
  now: number,
  timeZone: string,
) => ({
  now: isoIn(now, timeZone),
  timeZone,
  entries: entries.map((e) => {
    const at = Date.parse(e.at);
    return Number.isNaN(at)
      ? { ...e, ago: "unknown" }
      : { ...e, at: isoIn(at, timeZone), ago: agoOf(now - at) };
  }),
});

export const layer = McpToolAccess.toLayer(
  TessayaToolkit,
  Effect.gen(function* () {
    const handlers = yield* TessayaRpcHandlers.makeHandlers;
    const random = yield* SecureRandom.SecureRandom;
    // No RPC session here, so the inbox's AskSource stays "device": the desktop's gate asks him before any act.
    const phone = (op: "ask" | "askGet", args: Record<string, unknown>) =>
      Effect.map(handlers[BATON_PHONE_WS_METHODS.call]({ op, args }), ({ value }) =>
        Option.getOrNull(decodeAsked(value)),
      );
    // The agent's own requests carry its session in their id, so it reads only those and is capped per session.
    // 16 characters: with "mcp-", "-" and a uuid the id stays within the inbox's 64 (a linked server's session is a uuid).
    const ownerOf = Effect.map(McpInvocationContext.McpInvocationContext, (scope) =>
      (scope.client?.sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16),
    );
    // A request for the Director, filed as this agent's (an outside client's session, or a thread agent's thread).
    const askHim = Effect.fn("TessayaMcp.askHim")(function* (text: string) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const owner = (scope.client?.sessionId ?? `t${scope.thread?.threadId ?? "unknown"}`)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 16);
      const id = `mcp-${owner}-${yield* random.uuidV4()}`;
      const asked = yield* phone("ask", { id, text }).pipe(
        Effect.provideService(AskOwner, owner),
        Effect.mapError(failed),
      );
      return {
        id: asked?.ok === false ? null : id,
        status: asked?.status ?? "not asked",
        line: asked?.line ?? "Nothing was asked.",
      };
    });
    const runtime = yield* TessayaRuntime;
    const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
    /** His Scratchpad on her brain, in Tessaya's own database. */
    const onScratchpad = (act: TessayaScratchpadAct) =>
      (runtime === null
        ? Effect.succeed(Option.none<TessayaScratchpadResult>())
        : scratchpad(act).pipe(Effect.provideContext(runtime))
      ).pipe(
        Effect.orElseSucceed(Option.none<TessayaScratchpadResult>),
        Effect.flatMap((r) =>
          Option.isSome(r)
            ? Effect.succeed(r.value.notes)
            : Effect.fail(failed({ reason: "His notes can't be reached just now." })),
        ),
      );
    const shownNote = (n: TessayaScratchNote) => ({
      id: n.id,
      at: DateTime.formatIso(DateTime.makeUnsafe(n.at)),
      text: n.text,
    });
    /** The turn pipeline's memory tools, or "unavailable" on a server built without Tessaya's services. */
    const withTurn = <A, E>(
      f: (turn: TessayaTurn["Service"]) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | { readonly reason: string }> => {
      const turn = runtime === null ? Option.none() : Context.getOption(runtime, TessayaTurn);
      return Option.isNone(turn)
        ? Effect.fail({ reason: "Memory is not available on this server." })
        : f(turn.value);
    };
    /** Coming up, read and changed in Tessaya's context, as the clients' RPC does. */
    const withUpcoming = <A, E>(
      f: (upcoming: TessayaUpcoming["Service"]) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | { readonly reason: string }> => {
      const upcoming =
        runtime === null ? Option.none() : Context.getOption(runtime, TessayaUpcoming);
      return Option.isNone(upcoming) || runtime === null
        ? Effect.fail({ reason: "Coming up is not available on this server." })
        : f(upcoming.value).pipe(Effect.provideContext(runtime));
    };
    const withWake = <A, E>(
      f: (wake: TessayaWake["Service"]) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | { readonly reason: string }> => {
      const wake = runtime === null ? Option.none() : Context.getOption(runtime, TessayaWake);
      return Option.isNone(wake) || runtime === null
        ? Effect.fail({ reason: "Wake-word training is not available on this server." })
        : f(wake.value).pipe(Effect.provideContext(runtime));
    };
    const withReports = <A, E>(
      f: (reports: ProblemReports["Service"]) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | { readonly reason: string }> => {
      const reports = runtime === null ? Option.none() : Context.getOption(runtime, ProblemReports);
      // Her health and the log are read in Tessaya's context, as tessaya_health does.
      return Option.isNone(reports) || runtime === null
        ? Effect.fail({ reason: "Problem reports are not available on this server." })
        : f(reports.value).pipe(Effect.provideContext(runtime));
    };
    // The same handlers as the clients' RPC, behind T3's read check for this credential.
    const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      readCaller().pipe(
        Effect.filterOrFail(
          ({ scope }) => scope.client !== undefined,
          () =>
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Tessaya's tools are for agents signed in from outside T3 Code.",
            }),
        ),
        Effect.andThen(effect.pipe(Effect.mapError(failed))),
      );
    // A move he cannot make (no such job or persona) is a line to say, never a failed tool.
    const moveLead = (input: TessayaJobLeadInput) =>
      handlers[BATON_JOB_WS_METHODS.jobLead](input).pipe(
        Effect.map(() => ({
          line:
            input.declined !== undefined
              ? "Noted: the lead stays, and it is not suggested again for this job."
              : "The job's lead moved too: its worker carries on, and its approvals carry over.",
        })),
        Effect.catchTags({ BatonJobPlacementError: (e) => Effect.succeed({ line: e.detail }) }),
      );
    return {
      tessaya_voice_arbiter: McpToolAccess.writes(
        (input) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            if (scope.client?.linked !== true || runtime === null)
              return { ok: false, error: "Only his other servers claim here." };
            return (
              (yield* serveArbiter(input.op, input.args).pipe(
                // The caller stays a linked one, so this server never forwards the claim again.
                Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                Effect.provideContext(runtime),
              )) ?? {
                ok: false,
                error: "That is not a voice request.",
              }
            );
          }),
        { linkedCallers: "allowed" },
      ),
      [PHONE_PAIRING_TOOL]: McpToolAccess.writes(
        () =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            if (!PhonePairing.mayAskHere(scope.client))
              return yield* new OrchestratorMcpFailure({
                code: "capability_denied",
                message: "Only another of his machines, linked with full access, may ask for this.",
              });
            if (auth._tag === "None")
              return yield* new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Pairing is not available on this server.",
              });
            return yield* PhonePairing.codeHere(auth.value).pipe(
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            );
          }),
        { linkedCallers: "allowed" },
      ),
      tessaya_brain: McpToolAccess.writes(
        (input) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            if (scope.client?.linked !== true || runtime === null)
              return { ok: false, line: "Only another of his servers sends here." };
            return yield* receiveAtBrain(input.op, input.payload, scope.client.access).pipe(
              Effect.provideContext(runtime),
            );
          }),
        { linkedCallers: "allowed" },
      ),
      ...(yield* HomeHandlers.make),
      ...(yield* BodyHandlers.make),
      ...(yield* DeviceHandlers.make),
      ...(yield* SettingsHandlers.make),
      ...(yield* MembersHandlers.make),
      ...(yield* PeopleHandlers.make),
      ...(yield* CommsHandlers.make),
      ...(yield* PersonaOpsHandlers.make),
      ...(yield* JobsHandlers.make),
      // This machine, the ones he names, or all of them; each peer switches only itself (a linked call is never forwarded).
      tessaya_account_use: McpToolAccess.writes(
        (input) =>
          asForwarded(
            input,
            Effect.gen(function* () {
              const thisOne = (name: string) => /^(this|here)\b/i.test(name.trim());
              const named = input.machines ?? [];
              const everywhere = input.everywhere === true;
              const here = Effect.gen(function* () {
                const pool = yield* call(handlers[BATON_ACCOUNT_WS_METHODS.accountPool]({}));
                const target = accountByWords(pool.accounts, input.account);
                if (target === null)
                  return {
                    on: "this machine",
                    switched: false,
                    line: `No one login here is called ${input.account}; here there are ${pool.accounts.map((a) => a.label).join(", ")}.`,
                  };
                // The suite's pretend vessel is checked as for real and switches nothing.
                const scope = yield* McpInvocationContext.McpInvocationContext;
                if (vesselOf(scope.client)?.dryRun === true)
                  return {
                    on: "this machine",
                    switched: false,
                    line: `Would switch to ${target.label} (a rehearsal).`,
                  };
                const used = yield* call(
                  handlers[BATON_ACCOUNT_WS_METHODS.accountUse]({
                    key: target.key,
                    reason: "manual",
                    ...(target.email === null ? {} : { email: target.email }),
                  }),
                );
                const moved = "sessions" in used ? used.sessions.switched : 0;
                return {
                  on: "this machine",
                  switched: true,
                  line: `Now on ${target.label}${moved === 0 ? "" : `, and ${moved} session${moved === 1 ? "" : "s"} with their own login moved too`}.`,
                };
              }).pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    on: "this machine",
                    switched: false,
                    line: `Not switched: ${error.message}`,
                  }),
                ),
              );
              const args = { account: input.account };
              const answers = everywhere
                ? yield* fromPeers("tessaya_account_use", args, "40 seconds")
                : yield* Effect.forEach(
                    named.filter((name) => !thisOne(name)),
                    (on) =>
                      Effect.map(
                        onPeer("tessaya_account_use", args, {
                          on,
                          takes: () => true,
                          wait: "40 seconds",
                        }),
                        (there) => there ?? { on, value: null },
                      ),
                  );
              const elsewhere = answers.flatMap(({ on, value }) => {
                const results = (
                  value as { results?: ReadonlyArray<{ switched: boolean; line: string }> } | null
                )?.results;
                return results === undefined
                  ? [{ on, switched: false, line: "That machine did not answer." }]
                  : results.map((result) => ({ ...result, on }));
              });
              const local = everywhere || named.length === 0 || named.some(thisOne);
              return { results: [...(local ? [yield* here] : []), ...elsewhere] };
            }),
          ),
        // His other servers switch this machine for a turn they heard ("switch everything to …").
        { linkedCallers: "allowed" },
      ),
      tessaya_jobs: McpToolAccess.reads(() => call(handlers[BATON_JOB_WS_METHODS.jobList]())),
      tessaya_watch: McpToolAccess.reads(() => call(handlers[BATON_WATCH_WS_METHODS.watchGet]())),
      tessaya_report_problem: McpToolAccess.writes((input) =>
        call(
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) =>
              withReports((reports) =>
                reports.file({
                  source: "asked",
                  symptom: input.symptom,
                  guess: input.guess,
                  vessel: input.vessel ?? null,
                  by: { kind: "agent", id: scope.client?.sessionId ?? "mcp" },
                }),
              ),
            ),
          ),
        ),
      ),
      tessaya_reports: McpToolAccess.reads((input) =>
        call(
          withReports((reports) =>
            input.id === undefined
              ? Effect.map(
                  reports.list({
                    ...(input.status === undefined ? {} : { status: input.status }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                  }),
                  // The list is a summary; one report's bundle comes by its id.
                  (all) => ({ reports: all.map((r) => ({ ...r, bundle: null })) }),
                )
              : Effect.map(reports.get(input.id), (r) => ({ reports: r === null ? [] : [r] })),
          ),
        ),
      ),
      tessaya_report_withdraw: McpToolAccess.writes((input) =>
        call(
          withReports((reports) =>
            reports.call(input.delete === true ? "delete" : "withdraw", input.id).pipe(
              Effect.as({
                line: input.delete === true ? "Deleted that report." : "Withdrew that report.",
              }),
              Effect.catchTags({ ReportsError: (e) => Effect.succeed({ line: e.reason }) }),
            ),
          ),
        ),
      ),
      tessaya_dev_feed: McpToolAccess.reads((input) =>
        call(
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) =>
              // The maintainer gate: a full-access credential; the owner's setting gates the rest.
              scope.client?.access !== "full-access"
                ? Effect.succeed({ on: false, events: [], next: 0 })
                : withReports((reports) => reports.feed(input)),
            ),
          ),
        ),
      ),
      tessaya_health: McpToolAccess.reads((input) =>
        call(
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) => {
              const explained = TessayaHealth.explain(input.symptom ?? "any", {
                kind: "agent",
                id: scope.client?.sessionId ?? "mcp",
              });
              return runtime === null ? explained : explained.pipe(Effect.provideContext(runtime));
            }),
            Effect.map(({ diagnosis }) => ({ diagnosis })),
          ),
        ),
      ),
      // State and names only: no synopsis, prompt or folder, and a walled project's work by its project's name.
      // A linked server of his gets its projects and accounts resolved; any other outside reader, neither.
      tessaya_fleet: McpToolAccess.reads(() =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) =>
            call(
              handlers[BATON_WS_METHODS.fleetGet]({
                forOutside: true,
                ...(scope.client?.linked === true ? { forLinked: true } : {}),
              }),
            ),
          ),
        ),
      ),
      tessaya_record: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const { entries } = yield* call(
            handlers[BATON_RECORD_WS_METHODS.list]({ ...input, limit: input.limit ?? 30 }),
          );
          return onHouseClock(entries, yield* Clock.currentTimeMillis, yield* runtimeZone);
        }),
      ),
      // Read as a client (MemoryViewer's default here): walls hold, no persona can be named, his own view is closed.
      tessaya_team_board: McpToolAccess.reads(() =>
        call(handlers[BATON_JOB_WS_METHODS.jobTeam]({})),
      ),
      // Read as a client (MemoryViewer's default here): walls hold and no persona can be named.
      tessaya_memory_search: McpToolAccess.reads((input) =>
        call(
          handlers[BATON_MEMORY_WS_METHODS.search]({ text: input.text, limit: input.limit ?? 10 }),
        ),
      ),
      // A client's view, as for search: a walled item has no history to an outside agent.
      tessaya_memory_history: McpToolAccess.reads((input) =>
        call(handlers[BATON_MEMORY_WS_METHODS.history]({ id: input.id })),
      ),
      // The one turn pipeline: who spoke on which vessel (TurnOrigin) decides whose words these are.
      tessaya_memory_remember: McpToolAccess.writes((input) =>
        call(
          withTurn((turn) =>
            Effect.map(turn.remember(input.text), (r) => ({
              kept: r.kept,
              id: r.id,
              line: r.line,
            })),
          ),
        ),
      ),
      tessaya_memory_forget: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const vessel = vesselOf((yield* McpInvocationContext.McpInvocationContext).client);
          // His desktop app's own call has no turn, and its gate asked him: it is the owner's, by his voice.
          const desk =
            (yield* TurnOrigin) === null && vessel?.surface === "assistant"
              ? {
                  kind: "desktop" as const,
                  id: "desktop",
                  label: "his desktop",
                  hisVoice: true,
                  member: OWNER_MEMBER_ID,
                  assurance: 2 as const,
                  rehearsal: vessel.dryRun,
                }
              : null;
          return yield* call(
            withTurn((turn) => {
              const fact =
                input.fact === undefined
                  ? null
                  : turn.understandingFact({ ...input, fact: input.fact });
              return Effect.map(
                fact !== null
                  ? desk === null
                    ? fact
                    : Effect.provideService(fact, TurnOrigin, desk)
                  : input.id !== undefined
                    ? turn.forget(input.id, input.restore === true)
                    : Effect.succeed("Say which memory, by its id, or which fact."),
                (line) => ({ line }),
              );
            }),
          );
        }),
      ),
      tessaya_memory_unlearn: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const client = (yield* McpInvocationContext.McpInvocationContext).client;
          if (client?.label !== MEMORY_UNLEARN_CLIENT || client.access !== "full-access")
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Only the owner's t3 memory command unlearns.",
            });
          const memory =
            runtime === null ? Option.none() : Context.getOption(runtime, TessayaMemoryService);
          if (Option.isNone(memory))
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Memory is not available on this server.",
            });
          const unlearn = Effect.gen(function* () {
            let forgotten = 0;
            const actor = { kind: "owner", id: client.label, certainty: 1 } as const;
            for (const id of input.ids) if (yield* memory.value.forget(id, actor)) forgotten++;
            let talks = 0;
            for (const day of new Set(input.talks.map((t) => t.day)))
              talks += yield* memory.value.dropTalks(
                day,
                input.talks.filter((t) => t.day === day).map((t) => t.line),
              );
            yield* emitAction({
              kind: "memory.unlearn",
              actor,
              outcome: `${forgotten} items, ${talks} talk lines`,
              evidence: input.ids.map((ref) => ({ kind: "memory", ref })),
              data: { why: input.why, days: input.talks.map((t) => t.day) },
            });
            return { forgotten, talks };
          });
          return yield* unlearn.pipe(Effect.provideService(MemoryViewer, "server"));
        }),
      ),
      // Read as a client (MemoryViewer's default here): walls hold.
      tessaya_preference_set: McpToolAccess.writes((input) =>
        call(
          withTurn((turn) =>
            Effect.map(turn.setPreference(input.key, input.value ?? null), (set) => ({
              line: set.line,
            })),
          ),
        ),
      ),
      tessaya_persona_handoff: McpToolAccess.writes((input) =>
        call(
          withTurn((turn) =>
            Effect.gen(function* () {
              const handed = yield* turn.handOff(input);
              if (input.job === undefined || handed.persona === undefined) return handed;
              const job = yield* moveLead({ id: input.job, to: handed.persona, via: "voice" });
              return { ...handed, line: `${handed.line} ${job.line}` };
            }),
          ),
        ),
      ),
      tessaya_job_lead: McpToolAccess.writes((input) =>
        call(
          moveLead({
            id: input.id,
            via: "voice",
            ...(input.to === undefined ? {} : { to: input.to }),
            ...(input.back === undefined ? {} : { back: input.back }),
            ...(input.declined === undefined ? {} : { declined: input.declined }),
          }),
        ),
      ),
      // Her home server's record when this one has a home (TessayaWake forwards), so every vessel says the same.
      tessaya_wake_words: McpToolAccess.reads(() =>
        call(
          withWake((wake) =>
            Effect.flatMap(wake.overview, (words) =>
              "refused" in words
                ? Effect.fail({ reason: words.refused })
                : Effect.succeed({ words }),
            ),
          ),
        ),
      ),
      tessaya_wake_word_change: McpToolAccess.writes((input) =>
        call(
          withWake((wake) =>
            Effect.map(
              input.change === "rollback"
                ? input.version === undefined
                  ? Effect.succeed({ refused: "Say which version to go back to." })
                  : wake.rollback(input.word, input.version)
                : input.change === "cancel"
                  ? wake.cancel(input.word)
                  : wake.retrain(input.word),
              (done) => wakeChangeLine(input, done),
            ),
          ),
        ),
      ),
      // Her pulse's log and dials are the owner's: a guest's turn hears a line, never the log.
      tessaya_pulse: McpToolAccess.writes((input) =>
        call(
          Effect.gen(function* () {
            const origin = yield* TurnOrigin;
            if (origin !== null && (origin.member !== OWNER_MEMBER_ID || origin.tainted))
              return { line: "That's for the owner to ask.", items: [] };
            if (runtime === null) return { line: "My pulse isn't on this server.", items: [] };
            const run = <A>(effect: Effect.Effect<A, never, never>) =>
              effect.pipe(Effect.provideContext(runtime));
            if (input.action === "noticed") {
              const rows = yield* run(Pulse.noticed(10));
              return {
                line: rows.length === 0 ? "I haven't noticed anything worth a note lately." : "",
                items: rows.map((r) => ({
                  at: r.at,
                  did: r.outcome,
                  what: r.subject,
                  why: r.detail,
                })),
              };
            }
            if (input.action === "liked" || input.action === "told_off")
              return { line: yield* run(Pulse.react(input.action)), items: [] };
            return {
              line: yield* run(Pulse.mute(input.about ?? "", input.action === "stop")),
              items: [],
            };
          }),
        ),
      ),
      // A guest's voice learns nothing about who lives here.
      tessaya_whos_home: McpToolAccess.reads(() =>
        call(
          withTurn((turn) =>
            Effect.gen(function* () {
              const origin = yield* TurnOrigin;
              if (origin !== null && (origin.member === null || origin.member === undefined))
                return yield* Effect.fail({
                  reason: "I only say who's home to the people who live here.",
                });
              return {
                people: (yield* turn.whoIsHome).map(({ member, nearest, ...person }) => ({
                  ...person,
                  you: member === (origin?.member ?? OWNER_MEMBER_ID),
                  nearest:
                    nearest === null
                      ? null
                      : { name: nearest.name, confidence: nearest.confidence },
                })),
              };
            }),
          ),
        ),
      ),
      // Lasting moves need his own ask: a voice she knows, or a signed-in agent; never a guest's or tainted turn.
      tessaya_cast: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const origin = yield* TurnOrigin;
          const cast = runtime === null ? Option.none() : Context.getOption(runtime, TessayaCast);
          if (Option.isNone(cast)) return { line: "The cast is not on this server.", bodies: [] };
          const verified =
            origin === null ||
            (origin.tainted !== true &&
              origin.member !== null &&
              origin.member !== undefined &&
              (origin.kind !== "device" ||
                origin.hisVoice === true ||
                origin.speaker?.verified === true));
          const body =
            input.body === undefined || input.body.toLowerCase() === "here"
              ? (origin?.id ?? input.body)
              : input.body;
          const op = castOp(input, body);
          // A visit for this conversation is a persona switch, as a wake word is: any untainted turn may ask.
          const view = yield* cast.value.call(op, verified, origin?.tainted !== true).pipe(
            Effect.map((v) => ({ v, line: castLine(op, v) })),
            Effect.catch((reason: string) =>
              Effect.map(cast.value.view, (v) => ({ v, line: reason })),
            ),
          );
          const name = (id: string | null) => view.v.personas.find((p) => p.id === id)?.name ?? id;
          // Which of his conversations has her desk body: his own ask only, a private one never named.
          const holder =
            input.action === "who" && (origin === null || origin.member === OWNER_MEMBER_ID)
              ? ` ${yield* bodyHolderLine()}`
              : "";
          return {
            line: `${view.line}${holder}`,
            bodies: view.v.bodies.map((b) => ({
              name: b.name,
              wearing: name(b.wearing),
              why: b.why,
              home: name(b.home),
              follows: b.follows,
              on: b.on.map((p) => name(p) ?? p),
            })),
          };
        }),
      ),
      // Read as a client (MemoryViewer's default here): walls hold.
      tessaya_coming_up: McpToolAccess.reads(() =>
        call(
          withUpcoming((upcoming) =>
            Effect.gen(function* () {
              const list = yield* upcoming.list({});
              const zone = yield* houseZone();
              const now = yield* Clock.currentTimeMillis;
              return {
                items: list.items.map((i) => ({
                  id: i.id,
                  source: i.source,
                  title: i.title,
                  line: i.line,
                  when: countdownText(i, now),
                  at:
                    i.at === null ? null : isoIn(i.at, zone).slice(0, i.allDay === true ? 10 : 16),
                  condition: i.condition,
                  repeats: i.repeats,
                  paused: i.paused,
                  can: i.can,
                })),
                unreadable: list.unreadable,
              };
            }),
          ),
        ),
      ),
      // A source that cannot do it answers with its sentence, which she says; it is not a failed tool.
      tessaya_coming_up_change: McpToolAccess.writes((input) =>
        call(
          Effect.gen(function* () {
            const by = yield* HomeHandlers.mcpHomeActor;
            const at = input.at === undefined ? undefined : Date.parse(input.at);
            if (at !== undefined && Number.isNaN(at))
              return { done: false, line: "That time could not be read; give it with its offset." };
            return yield* withUpcoming((upcoming) =>
              upcoming
                .change(
                  {
                    id: input.id,
                    op: input.op,
                    ...(input.inMinutes === undefined ? {} : { inMinutes: input.inMinutes }),
                    ...(at === undefined ? {} : { at }),
                  },
                  by,
                )
                .pipe(
                  Effect.catchTags({
                    UpcomingError: (e) => Effect.succeed({ done: false, line: e.reason }),
                  }),
                ),
            );
          }),
        ),
      ),
      // His own documents: his turns and his own agents only, never a guest's or a tainted one.
      tessaya_owner_doc: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const origin = yield* TurnOrigin;
          if (origin !== null && (origin.member !== OWNER_MEMBER_ID || origin.tainted))
            return { text: "Those documents are his, so I only open them for him." };
          return { text: ownerDoc(yield* ownerDocs, input) };
        }),
      ),
      tessaya_activity: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (input.mode === "why") {
            const why = yield* call(
              handlers[TESSAYA_ACTIVITY_WS_METHODS.why]({
                ...(input.id === undefined ? {} : { id: input.id }),
                ...(input.about === undefined ? {} : { text: input.about }),
              }),
            );
            return { text: why.lines.join("\n") };
          }
          const list = yield* call(
            handlers[TESSAYA_ACTIVITY_WS_METHODS.list]({
              sinceMinutes: Math.round(input.minutes ?? 60),
              ...(input.kind === undefined ? {} : { kind: input.kind }),
              ...(input.about === undefined ? {} : { text: input.about }),
              limit: 60,
            }),
          );
          return { text: activityText(input.mode, list, now) };
        }),
      ),
      tessaya_usage_report: McpToolAccess.reads((input) =>
        // No zone: the house's, read where the brain's services are.
        call(
          handlers[BATON_BRAIN_WS_METHODS.usage]({
            days: Math.round(input.days ?? 7),
            timeZone: "",
            ...(input.detail === undefined ? {} : { detail: input.detail }),
          }),
        ),
      ),
      tessaya_prompt_lab: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const origin = yield* TurnOrigin;
          const refused = labRefusal(input.action, origin);
          if (refused !== null) return { line: refused };
          const persona = input.persona ?? "";
          const variant = input.variant ?? "";
          return yield* call(
            handlers[BATON_PROMPT_LAB_WS_METHODS.call](
              input.action === "list"
                ? { op: "list" }
                : input.action === "save"
                  ? { op: "save", persona, variant, text: input.text ?? "" }
                  : input.action === "run"
                    ? {
                        op: "run",
                        persona,
                        variants: input.variants ?? (variant === "" ? ["live"] : [variant]),
                        models: input.models ?? ["sonnet"],
                        ...(input.message === undefined ? {} : { message: input.message }),
                      }
                    : input.action === "promote"
                      ? { op: "promote", persona, variant }
                      : { op: "rollback", persona },
            ),
          );
        }),
      ),
      tessaya_memory_about: McpToolAccess.reads((input) =>
        call(withTurn((turn) => Effect.map(turn.about(input.subject), (items) => ({ items })))),
      ),
      tessaya_rules: McpToolAccess.reads((input) =>
        call(handlers[BATON_ORCHESTRATION_WS_METHODS.ruleList](input)),
      ),
      tessaya_in_flight: McpToolAccess.reads(() =>
        call(handlers[BATON_SESSIONS_WS_METHODS.inFlight]()),
      ),
      // The same listing as his Tessaya window, every linked machine's: titles and projects only, never accounts.
      tessaya_work_now: McpToolAccess.reads(() =>
        call(
          Effect.gen(function* () {
            const across = yield* handlers[BATON_SESSIONS_WS_METHODS.across]({});
            return workNow(across, yield* Clock.currentTimeMillis);
          }),
        ),
      ),
      // Titles and folders only: the history index would let an agent test any word against every transcript.
      tessaya_sessions: McpToolAccess.reads((input) =>
        call(
          handlers[BATON_SESSIONS_WS_METHODS.list]({
            ...input,
            limit: input.limit ?? 30,
            history: false,
          }),
        ),
      ),
      // A linked server may ask too (the R1 asking his laptop): it is a device's words, which the gate asks him to act on.
      tessaya_ask: McpToolAccess.writes(
        (input) =>
          call(
            Effect.gen(function* () {
              const owner = yield* ownerOf;
              const id = `mcp-${owner}-${yield* random.uuidV4()}`;
              // The vessel the turn came through (TurnOrigin), else what the caller says it came from.
              const turn = yield* TurnOrigin;
              const origin = turn?.label ?? input.origin;
              const scope = yield* McpInvocationContext.McpInvocationContext;
              // His voice is his yes only as this server's own turn heard it, or as one of his linked servers says.
              const hisVoice =
                turn?.hisVoice === true ||
                (scope.client?.linked === true && input.hisVoice === true);
              const asked = yield* phone("ask", {
                id,
                text: input.text,
                ...(origin === undefined ? {} : { origin }),
                ...(hisVoice ? { hisVoice: true } : {}),
              }).pipe(Effect.provideService(AskOwner, owner));
              return {
                id: asked?.ok === false ? null : id,
                status: asked?.status ?? "not asked",
                line: asked?.line ?? "Nothing was asked.",
              };
            }),
          ),
        { linkedCallers: "allowed" },
      ),
      tessaya_state: McpToolAccess.reads((input) =>
        call(
          Effect.map(
            handlers[BATON_PHONE_WS_METHODS.call]({ op: "stateGet", args: {} }),
            ({ value }) => {
              const got = Option.getOrNull(decodeStateReply(value));
              return {
                connected: got?.connected === true,
                at: got?.at ?? null,
                section: input.section,
                value:
                  got?.connected === true && got.state !== null
                    ? got.state[input.section]
                    : "Tessaya's desktop app isn't connected to this server, so only the server's own facts are here.",
                server: { version: packageJson.version },
              };
            },
          ),
        ),
      ),
      // A full-access outside client only: it changes the desktop without asking him, so it is for what he asked for.
      tessaya_desktop_settings: McpToolAccess.writesEnvironment((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) =>
            call(
              input.set === undefined
                ? handlers[BATON_DESKTOP_SETTINGS_WS_METHODS.get]()
                : // Letting devices look at his screen is his (settings_set asks him); an agent's change leaves it.
                  handlers[BATON_DESKTOP_SETTINGS_WS_METHODS.set]({
                    patch: Object.fromEntries(
                      Object.entries(input.set).filter(([key]) => key !== "devicesMayLook"),
                    ),
                  }).pipe(
                    Effect.provideService(DesktopSettingsCaller, {
                      actor: `outside:${quoted(scope.client?.label ?? "unknown")}`,
                      scope: `mcp ${scope.client?.access ?? "unknown"}: ${[...scope.capabilities].join(",")}`,
                    }),
                  ),
            ),
          ),
        ),
      ),
      // The one store (her brain's server settings), which the R1 reads from MQTT; a replay's pretend R1 never reaches here.
      tessaya_note_add: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const turn = yield* TurnOrigin;
          if (turn !== null && (turn.tainted === true || !hisOwnTurn(turn)))
            return yield* failed({ reason: "Only he can add to his notes." });
          const note = {
            id: (yield* random.uuidV4()).slice(0, 8),
            at: yield* Clock.currentTimeMillis,
            text: input.text.trim(),
          };
          const saved = yield* onScratchpad({ op: "add", notes: [note] });
          return { notes: saved.map(shownNote), line: "Noted." };
        }),
      ),
      tessaya_note_search: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const turn = yield* TurnOrigin;
          if (turn !== null && (turn.tainted === true || !hisOwnTurn(turn)))
            return yield* failed({ reason: "Only he can read his notes." });
          const query = input.query?.trim() ?? "";
          const found = (yield* onScratchpad(
            query === "" ? { op: "list" } : { op: "search", query },
          )).slice(0, 10);
          return {
            notes: found.map(shownNote),
            line:
              found.length === 0
                ? "There's nothing like that in your notes."
                : `${found.length} found.`,
          };
        }),
      ),
      tessaya_pronounce: McpToolAccess.writes((input) =>
        pronunciations({
          word: input.word,
          ...(input.sayAs === undefined ? {} : { sayAs: input.sayAs }),
        }).pipe(
          Effect.mapError(() => failed({ reason: "The pronunciation was not saved." })),
          Effect.flatMap((saved) =>
            Option.isNone(saved)
              ? Effect.fail(failed({ reason: "Pronunciations can't be kept on this server." }))
              : Effect.succeed({
                  pronounce: saved.value,
                  line:
                    input.sayAs === undefined
                      ? `"${input.word}" is said the voice's own way again.`
                      : `"${input.word}" is now said as "${input.sayAs}".`,
                }),
          ),
        ),
      ),
      // The one dictionary, on her brain: a worker server passes the change there (TessayaVocabulary.atBrain).
      tessaya_vocabulary: McpToolAccess.writes(
        (input) =>
          Effect.gen(function* () {
            if (runtime === null || Option.isNone(Context.getOption(runtime, TessayaVocabulary)))
              return yield* failed({ reason: "This server keeps no dictionary." });
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const store = Context.get(runtime, TessayaVocabulary);
            const change = input.change;
            const all =
              change === undefined
                ? yield* store.read
                : yield* store.change(change).pipe(
                    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                    Effect.mapError((e) => failed({ reason: e.why })),
                  );
            const word =
              change?.verb === "add" || change?.verb === "edit"
                ? (change.replacement ?? change.phrase)
                : "";
            return {
              words: all.map((e) => e.replacement ?? e.phrase),
              line:
                change === undefined
                  ? `${all.length} words in the dictionary.`
                  : change.verb === "add"
                    ? `Added ${word} to your dictionary.`
                    : change.verb === "edit"
                      ? `${change.from} is now ${word}.`
                      : change.verb === "remove"
                        ? `Took ${change.phrase} out of your dictionary.`
                        : "The dictionary is up to date.",
            };
          }),
        { linkedCallers: "allowed" },
      ),
      // A revoke only narrows what she may do, so his voice at A1 (held included) is enough; never a guest's.
      tessaya_always_allowed: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const consent = runtime === null ? Option.none() : Context.getOption(runtime, Consent);
          if (Option.isNone(consent))
            return yield* failed({ reason: "This server keeps no standing yeses." });
          const keys = yield* consent.value.read;
          const said = (list: ReadonlyArray<string>) => list.map(grantLabel);
          if (input.revoke === undefined)
            return {
              allowed: said(keys),
              line:
                keys.length === 0
                  ? "Nothing is allowed without asking."
                  : `Allowed without asking: ${said(keys).join("; ")}.`,
            };
          const turn = yield* TurnOrigin;
          const who = turn === null ? null : grantWho(turn);
          if (who !== null && (who.member !== OWNER_MEMBER_ID || who.assurance < 1 || who.tainted))
            return yield* failed({ reason: "Only he can take back what he allowed." });
          const key = grantNamed(keys, input.revoke);
          if (key === null)
            return { allowed: said(keys), line: "Nothing he allowed matches that." };
          const after = yield* consent.value.set(key, false);
          return { allowed: said(after), line: `I'll ask again before: ${grantLabel(key)}.` };
        }),
      ),
      // The Playground's say and clone by voice: the same service methods, for his own turn or full-access client only.
      tessaya_voice: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const turn = yield* TurnOrigin;
          if (turn !== null && (turn.tainted === true || !hisOwnTurn(turn)))
            return yield* failed({
              reason: "Only he can do that, in his own voice or at his keyboard.",
            });
          const voices =
            runtime === null ? Option.none() : Context.getOption(runtime, TessayaVoiceLibrary);
          const config =
            runtime === null
              ? Option.none()
              : Context.getOption(runtime, ServerConfig.ServerConfig);
          if (Option.isNone(voices) || Option.isNone(config))
            return yield* failed({ reason: "This server has no voices." });
          const refused = (e: VoiceRefusedError) => failed({ reason: e.why });
          if (input.op === "clone") {
            if (input.file === undefined || input.name === undefined)
              return yield* failed({ reason: "Name the WAV file and what to call the voice." });
            const path = input.file;
            const wav = yield* Effect.tryPromise({
              try: () => NodeFS.promises.readFile(path),
              catch: () => failed({ reason: "That recording could not be read on this machine." }),
            });
            const test = yield* voices.value
              .cloneVoice({ wav, consent: input.consent === true })
              .pipe(Effect.mapError(refused));
            const saved = yield* voices.value
              .saveClone({ id: test.id, name: input.name })
              .pipe(Effect.mapError(refused));
            return {
              line: `Saved your cloned voice as ${saved.name}; say "in ${saved.name}'s voice" to use it.`,
              file: null,
            };
          }
          const view = yield* voices.value.library;
          const target = voiceFor(view, input.voice ?? "");
          if (target === null || input.text === undefined)
            return yield* failed({ reason: "Say which voice, and what it should say." });
          const clip = yield* voices.value
            .say({ engine: target.engine, voice: target.voice, text: input.text })
            .pipe(Effect.mapError(refused));
          const file = NodePath.join(config.value.stateDir, "voice", "said", "last.wav");
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFS.promises.mkdir(NodePath.dirname(file), { recursive: true });
              await NodeFS.promises.writeFile(file, Buffer.from(clip.base64, "base64"));
            },
            catch: () => failed({ reason: "The line was made but could not be saved." }),
          });
          return {
            line: `Made it in ${target.name}'s voice${clip.synthetic === true ? " (a clone, marked synthetic)" : ""}.`,
            file,
          };
        }),
      ),
      // The roster by voice: Settings' change, for his own turn or his full-access client only.
      tessaya_persona: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const turn = yield* TurnOrigin;
          if (turn !== null && (turn.tainted === true || !hisOwnTurn(turn)))
            return yield* failed({
              reason: "Only he can do that, in his own voice or at his keyboard.",
            });
          if (runtime === null) return yield* failed({ reason: "This server has no personas." });
          const persona = input.persona ?? "";
          const request: TessayaPersonaChangeInput | null =
            input.op === "bin"
              ? { op: "bin" }
              : input.op === "create"
                ? { op: "create", draft: input.draft ?? {} }
                : input.op === "hire"
                  ? input.sentence === undefined
                    ? null
                    : { op: "hire", sentence: input.sentence }
                  : input.op === "import"
                    ? input.source === undefined
                      ? null
                      : { op: "import", source: input.source }
                    : persona === ""
                      ? null
                      : input.op === "edit"
                        ? { op: "edit", id: persona, draft: input.draft ?? {} }
                        : input.op === "duplicate"
                          ? {
                              op: "duplicate",
                              id: persona,
                              name: input.name ?? input.draft?.name ?? "",
                            }
                          : input.op === "export"
                            ? { op: "export", id: persona }
                            : { op: input.op, id: persona };
          if (request === null)
            return yield* failed({
              reason:
                input.op === "hire"
                  ? "Say who to hire, in a sentence."
                  : input.op === "import"
                    ? "Say where the card is."
                    : "Say which persona.",
            });
          const result = yield* changePersona(request, { owner: true }).pipe(
            Effect.provideContext(runtime),
            Effect.orElseSucceed((): TessayaPersonaChangeResult => ({
              ok: false,
              error: "The roster could not be changed.",
              bin: [],
            })),
          );
          if (!result.ok) return yield* failed({ reason: result.error ?? "That did not work." });
          const bin = result.bin.map((p) => p.name).join(", ");
          if (result.draft !== undefined)
            return {
              line: `Here is who I would hire: ${result.draft.name}, ${result.draft.role}. Say yes to add them, or tell me what to change.`,
              draft: result.draft,
            };
          return {
            line:
              input.op === "import"
                ? (result.line ?? "They came from the card and are on the team.")
                : input.op === "export"
                  ? `Saved the card as ${result.card?.files.join(" and ") || "a file"}.`
                  : input.op === "bin"
                    ? bin === ""
                      ? "The bin is empty."
                      : `In the bin: ${bin}.`
                    : input.op === "create"
                      ? `${input.draft?.name ?? "The new persona"} is on the team.`
                      : input.op === "duplicate"
                        ? `Made ${request.op === "duplicate" ? request.name : "a copy"}.`
                        : input.op === "retire"
                          ? `${persona} is in the bin; say "restore ${persona}" to bring them back.`
                          : input.op === "restore"
                            ? `${persona} is back.`
                            : `Changed ${persona}.`,
          };
        }),
      ),
      // His group or the speaker's own; a private persona only on his own untainted turn or his full-access client.
      tessaya_group: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const turn = yield* TurnOrigin;
          if (runtime === null) return yield* failed({ reason: "This server has no personas." });
          const owner = turn === null || (turn.tainted !== true && hisOwnTurn(turn));
          const conversation =
            turn === null
              ? HIS_GROUP
              : groupConversation(
                  {
                    vessel: { kind: turn.kind, id: turn.id },
                    speaker: turn.speaker,
                    member: turn.member,
                  },
                  owner,
                );
          const persona = input.persona ?? "";
          const change: GroupChange | null =
            input.op === "start" || input.op === "add"
              ? {
                  op: input.op,
                  personas: input.personas ?? [],
                  ...(input.op === "start" && input.mode !== undefined ? { mode: input.mode } : {}),
                }
              : input.op === "mode"
                ? input.mode === undefined
                  ? null
                  : { op: "mode", mode: input.mode }
                : input.op === "end" || input.op === "status"
                  ? { op: input.op }
                  : persona === ""
                    ? null
                    : { op: input.op, persona };
          if (change === null) return yield* failed({ reason: "Say which persona or mode." });
          const changed = yield* changeGroup(conversation, change, { owner }).pipe(
            Effect.provideContext(runtime),
          );
          return { line: changed.line };
        }),
      ),
      // Only this agent's own requests: another agent's, the phone's and the web bar's are not its to read.
      tessaya_ask_status: McpToolAccess.reads((input) =>
        call(
          Effect.map(
            Effect.flatMap(ownerOf, (owner) =>
              input.id.startsWith(`mcp-${owner}-`)
                ? phone("askGet", { id: input.id })
                : Effect.succeed(null),
            ),
            (asked) => ({
              id: asked === null ? null : input.id,
              status: asked?.status ?? "unknown",
              line: asked?.line ?? "No such request.",
            }),
          ),
        ),
      ),
      // Typing into a pane needs full access, here and before a call leaves for a link, within any narrowed modes the
      // caller passed on. The session reads who sent it, quoted; the limit and the Record key on the client's session,
      // never its name. Delivering what waits is a write too, so it goes here.
      weave_send: McpToolAccess.writesEnvironment(
        (input) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) => {
              const label = scope.client?.label ?? "an outside agent";
              return gateMessage(
                {
                  sender: `outside:${scope.client?.sessionId ?? "unknown"}`,
                  ref: input.to,
                  project: null,
                  subject: `To session ${quoted(input.to)} from ${quoted(label)}`,
                },
                call(
                  handlers[BATON_WEAVE_WS_METHODS.send]({
                    to: input.to,
                    text: withAgentMessageFrom(
                      clientMessageFrom(scope.client ?? { label }),
                      input.text,
                    ),
                    from: label,
                    ...(input.job === undefined ? {} : { job: input.job }),
                  }).pipe(
                    Effect.tap(() => handlers[BATON_WEAVE_WS_METHODS.tick]().pipe(Effect.ignore)),
                  ),
                ),
              );
            }),
          ),
        { linkedCallers: "allowed" },
      ),
      // Never the move itself: a request he answers on his own screen, where the desktop's gate asks him every time.
      tessaya_move_into_tessaya: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          askHim(
            `Move the Terminal thread ${input.threadId} into Tessaya (thread_move_into_tessaya): its terminal session ends and the same conversation continues in Tessaya.`,
          ),
      ),
      // Its own thread opens at once; anyone else's is the Director's to approve, on his screen.
      tessaya_open_in_terminal: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) =>
              scope.thread?.threadId === input.threadId
                ? handlers[BATON_SESSIONS_WS_METHODS.openInTerminal]({
                    threadId: input.threadId,
                  }).pipe(
                    Effect.mapError(failed),
                    Effect.map((opened): typeof OpenInTerminalReply.Type => opened),
                  )
                : askHim(
                    `Open the Tessaya thread ${input.threadId} in a terminal (thread_open_in_terminal): its session moves to a Herdr pane until the pane closes.`,
                  ),
            ),
          ),
      ),
      tessaya_main_session: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          handlers[BATON_SESSIONS_WS_METHODS.mainSession]({
            threadId: input.threadId,
            main: input.main,
          }).pipe(Effect.mapError(failed)),
      ),
      tessaya_session_defaults: McpToolAccess.reads(() =>
        handlers[BATON_SESSIONS_WS_METHODS.sessionDefaults]().pipe(Effect.mapError(failed)),
      ),
      weave_list: McpToolAccess.reads((input) =>
        call(
          handlers[BATON_WEAVE_WS_METHODS.list](
            input.limit === undefined ? {} : { limit: input.limit },
          ),
        ),
      ),
    };
  }),
);
