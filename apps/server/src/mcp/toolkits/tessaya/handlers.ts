import {
  BATON_DESKTOP_SETTINGS_WS_METHODS,
  BATON_JOB_WS_METHODS,
  BATON_MEMORY_WS_METHODS,
  BATON_ORCHESTRATION_WS_METHODS,
  BATON_PHONE_WS_METHODS,
  BATON_RECORD_WS_METHODS,
  BATON_SESSIONS_WS_METHODS,
  BATON_WATCH_WS_METHODS,
  BATON_WS_METHODS,
  BATON_WEAVE_WS_METHODS,
  BatonDesktopState,
  type BatonRecordEntry,
} from "@t3tools/baton-contracts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { recordText } from "@t3tools/baton-shared/audit";

import { clientMessageFrom, withAgentMessageFrom } from "../../../baton/AgentMessageFrom.ts";
import { gateMessage } from "../../../baton/AgentMessageGate.ts";
import { AskOwner } from "../../../baton/BatonPhoneInbox.ts";
import { DesktopSettingsCaller } from "../../../baton/BatonDesktopSettings.ts";
import packageJson from "../../../../package.json" with { type: "json" };
import * as BatonRpcHandlers from "../../../baton/BatonRpcHandlers.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { serveArbiter } from "../../../home/VoiceArbiter.ts";
import { TessayaTurn, TurnOrigin } from "../../../baton/TessayaTurn.ts";
import { HomeAssistantService } from "../../../home/HomeAssistantService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import * as DeviceHandlers from "../devices/handlers.ts";
import * as HomeHandlers from "../home/handlers.ts";
import * as SettingsHandlers from "../settings/handlers.ts";
import { OpenInTerminalReply, TessayaToolkit } from "./tools.ts";

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
    state: Schema.NullOr(BatonDesktopState),
  }),
);

/** His pronunciation list after one change: `sayAs` sets the word, none removes it. */
const nextPronounce = (
  map: Readonly<Record<string, string>>,
  word: string,
  sayAs: string | undefined,
): Readonly<Record<string, string>> => {
  const { [word.trim()]: _, ...rest } = map;
  return sayAs === undefined || sayAs.trim() === ""
    ? rest
    : { ...rest, [word.trim()]: sayAs.trim() };
};

const failed = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message:
      typeof cause === "object" && cause !== null && "reason" in cause
        ? String(cause.reason)
        : "Tessaya could not answer that.",
  });

/** The household's time zone: its Home Assistant's, else this machine's. */
const houseZone = Effect.gen(function* () {
  const context = yield* BatonRuntime;
  const home = context === null ? Option.none() : Context.getOption(context, HomeAssistantService);
  const zone = Option.isSome(home) ? yield* home.value.timeZone : "UTC";
  return zone === "UTC" ? Intl.DateTimeFormat().resolvedOptions().timeZone : zone;
});

/** A time as ISO with the zone's own offset ("2026-11-13T08:26:31+05:00"). */
const isoIn = (ms: number, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  const offset = String(parts["timeZoneName"]).replace("GMT", "") || "+00:00";
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}${offset}`;
};

const agoOf = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} days ago`;
};

/** The Record on the house's clock, each row with its age, so no model reads UTC as local (13 Nov). */
export const onHouseClock = (
  entries: ReadonlyArray<BatonRecordEntry>,
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
    const handlers = yield* BatonRpcHandlers.makeHandlers;
    const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
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
    const runtime = yield* BatonRuntime;
    /** The turn pipeline's memory tools, or "unavailable" on a server built without Tessaya's services. */
    const withTurn = <A, E>(
      f: (turn: TessayaTurn["Service"]) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | { readonly reason: string }> => {
      const turn = runtime === null ? Option.none() : Context.getOption(runtime, TessayaTurn);
      return Option.isNone(turn)
        ? Effect.fail({ reason: "Memory is not available on this server." })
        : f(turn.value);
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
      ...(yield* HomeHandlers.make),
      ...(yield* DeviceHandlers.make),
      ...(yield* SettingsHandlers.make),
      tessaya_jobs: McpToolAccess.reads(() => call(handlers[BATON_JOB_WS_METHODS.jobList]())),
      tessaya_watch: McpToolAccess.reads(() => call(handlers[BATON_WATCH_WS_METHODS.watchGet]())),
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
          return onHouseClock(entries, yield* Clock.currentTimeMillis, yield* houseZone);
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
        call(withTurn((turn) => turn.remember(input.text))),
      ),
      tessaya_memory_forget: McpToolAccess.writes((input) =>
        call(withTurn((turn) => Effect.map(turn.forget(input.id), (line) => ({ line })))),
      ),
      // Read as a client (MemoryViewer's default here): walls hold.
      tessaya_memory_about: McpToolAccess.reads((input) =>
        call(withTurn((turn) => Effect.map(turn.about(input.subject), (items) => ({ items })))),
      ),
      tessaya_rules: McpToolAccess.reads((input) =>
        call(handlers[BATON_ORCHESTRATION_WS_METHODS.ruleList](input)),
      ),
      tessaya_in_flight: McpToolAccess.reads(() =>
        call(handlers[BATON_SESSIONS_WS_METHODS.inFlight]()),
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
      // The one store (server settings), which the R1 reads from MQTT; a replay's pretend R1 never reaches here.
      tessaya_pronounce: McpToolAccess.writes((input) =>
        Option.isNone(serverSettings)
          ? Effect.fail(failed({ reason: "Pronunciations can't be kept on this server." }))
          : serverSettings.value.getSettings.pipe(
              Effect.flatMap((current) =>
                serverSettings.value.updateSettings({
                  voicePronounce: nextPronounce(current.voicePronounce, input.word, input.sayAs),
                }),
              ),
              Effect.map((saved) => ({
                pronounce: saved.voicePronounce,
                line:
                  input.sayAs === undefined
                    ? `"${input.word}" is said the voice's own way again.`
                    : `"${input.word}" is now said as "${input.sayAs}".`,
              })),
              Effect.mapError(() => failed({ reason: "The pronunciation was not saved." })),
            ),
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
