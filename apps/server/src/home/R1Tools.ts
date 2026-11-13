// @effect-diagnostics globalJsonInEffect:off
/**
 * The room's tools: the same /mcp tools his agents get (the house, his team and work, asks for his yes), called
 * in-process through their own handlers as `ROOM_CLIENT`, so McpToolAccess and the house's gate apply as on /mcp. Plus
 * laptop_ask, which asks his laptop's Tessaya. No file, shell or screen tools: the room only reads and asks.
 */
import { BatonHomeCallResult } from "@t3tools/baton-contracts";
import { DEVICE_TOOL_TEXT } from "@t3tools/baton-shared/deviceTools";
import { foldSpelling, spellOut } from "@t3tools/baton-shared/spelling";
import { type Assurance, type MemberRole, OWNER_MEMBER_ID } from "@t3tools/baton-shared/household";
import { principalRefusal, reachAssurance, toolReach } from "@t3tools/baton-shared/trust";
import { BATON_TOOL_PREFIX, judgeToolCall } from "@t3tools/baton-shared/operator";
import { recordText } from "@t3tools/baton-shared/audit";
import { volumeAfter, volumeLine, type VolumeTo } from "@t3tools/baton-shared/speakingVolume";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { advertisedJsonSchema } from "../mcp/advertisedJsonSchema.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import {
  DESK_CLIENT,
  DESK_REPLAY_CLIENT,
  ROOM_CLIENT,
  ROOM_REPLAY_CLIENT,
} from "../mcp/toolkits/home/handlers.ts";
import * as TessayaHandlers from "../mcp/toolkits/tessaya/handlers.ts";
import { JobTools } from "../mcp/toolkits/jobs/tools.ts";
import { TessayaToolkit } from "../mcp/toolkits/tessaya/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { RoomTools, type RoomTool, type RoomToolSet, type ToolOutcome } from "./R1Brain.ts";
import { NOT_HIS_VOICE_TO_FORGET, TurnOrigin } from "../baton/TessayaTurn.ts";
import { TessayaHousehold } from "../baton/TessayaHousehold.ts";
import { askLaptop } from "./R1Laptop.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import { HomeDevices } from "./HomeDevices.ts";
import { StepUps } from "./StepUps.ts";
import { VoiceForgets } from "../baton/VoiceForgets.ts";

/** What the room may call from Tessaya's /mcp toolkit. */
const ROOM_TOOLS = [
  "home_find",
  "home_state",
  "home_do",
  "home_undo",
  "home_automations",
  "home_automation_save",
  "home_automation_set",
  "tessaya_team_board",
  "tessaya_in_flight",
  "tessaya_sessions",
  "tessaya_fleet",
  "tessaya_jobs",
  "tessaya_watch",
  "tessaya_record",
  "tessaya_rules",
  "tessaya_memory_search",
  "tessaya_memory_remember",
  "tessaya_memory_forget",
  "tessaya_memory_about",
  "tessaya_coming_up",
  "tessaya_usage_report",
  "tessaya_whos_home",
  "tessaya_preference_set",
  "tessaya_ask",
  "tessaya_ask_status",
  "tessaya_pronounce",
  "settings_find",
  "settings_get",
  "settings_explain",
  "settings_set",
  // Every vessel's self-described items, from any vessel (R1-P13).
  "device_list",
  "device_read",
  "device_set",
  "device_watch",
  "members_list",
  "member_invite",
  "member_set_role",
  "member_remove",
  "member_restore",
  "member_rename",
  "member_preferences",
  "member_preference_set",
  "household_home_server",
  // His jobs (BatonJobFlow): the desktop assistant's job tools, judged by the same table (judgeToolCall).
  "job_start",
  "job_agree",
  "job_refine",
  "job_split",
  "job_retry",
  "job_stop",
  "job_schedule",
  "schedules_list",
  "schedule_run_now",
  "schedule_delete",
  "project_add",
  "cloud_dispatch",
] as const satisfies ReadonlyArray<keyof typeof TessayaToolkit.tools>;

/** The work tools (jobs, schedules, projects, cloud), judged by the desktop's table (judgeToolCall). */
const JOB_TOOLS: ReadonlySet<string> = new Set(JobTools.map((tool) => tool.name));

/**
 * The shared tools his desktop's Tessaya gets: the room's, plus his devices (the desktop has no device of its own).
 * Not tessaya_ask: the desktop is where those asks are answered.
 */
const DESK_TOOLS = [
  ...ROOM_TOOLS.filter((name) => name !== "tessaya_ask" && name !== "tessaya_ask_status"),
  "device_act",
  "device_owner",
  "device_tag",
] satisfies ReadonlyArray<keyof typeof TessayaToolkit.tools>;
type SharedName = (typeof ROOM_TOOLS)[number] | (typeof DESK_TOOLS)[number];

/**
 * The tools every vessel keeps loaded when tool search is on (BRAIN-DESIGN §3.1): MCP advertises them with
 * `anthropic/alwaysLoad`, the API route leaves them without `defer_loading`. Empty until the brain lane's B0 counts.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set<SharedName>([]);

const LAPTOP: RoomTool = {
  name: "laptop_ask",
  description:
    "Ask his laptop's Tessaya anything about his laptop: what is on its screen, which apps or windows are open. She asks him there before she looks at the screen. Her answer comes back as the result; say it as it is, and never guess what is on his laptop.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string", description: "His question, in his words." } },
    required: ["question"],
  },
};

const VOLUME: RoomTool = {
  name: "set_device_volume",
  description: DEVICE_TOOL_TEXT.set_device_volume,
  input_schema: {
    type: "object",
    properties: {
      to: {
        description: "up, down, max, default, or a level from 10 to 100.",
        anyOf: [
          { type: "string", enum: ["up", "down", "max", "default"] },
          { type: "number", minimum: 10, maximum: 100 },
        ],
      },
    },
    required: ["to"],
  },
};

const volumeTo = (input: unknown): VolumeTo | null => {
  const to = typeof input === "object" && input !== null && "to" in input ? input.to : null;
  if (typeof to === "number" && Number.isFinite(to)) return to;
  return to === "up" || to === "down" || to === "max" || to === "default" ? to : null;
};

/** On this room's R1, through the devices' own command path. */
const setRoomVolume = Effect.fn("R1Tools.volume")(function* (input: unknown, heardOn?: string) {
  const to = volumeTo(input);
  if (to === null)
    return { text: "Say up, down, max, default or a level.", isError: true } as ToolOutcome;
  // The replay harness's pretend R1: the turn runs as on his, and his speaker is left alone.
  if (heardOn?.startsWith("replay-") === true)
    return { text: volumeLine(71, volumeAfter(71, to, 71)), isError: false } as ToolOutcome;
  const device = yield* Effect.serviceOption(HomeAssistantService).pipe(
    Effect.flatMap((h) => (h._tag === "None" ? Effect.succeed(null) : h.value.device)),
  );
  const devices = yield* Effect.serviceOption(HomeDevices);
  if (device?.deviceId == null || Option.isNone(devices))
    return { text: "There is no speaker set up here.", isError: true } as ToolOutcome;
  return yield* devices.value
    .command(
      device.deviceId,
      { op: "volume", to },
      { who: "Tessaya in the room", surface: "assistant" },
    )
    .pipe(
      Effect.map((o): ToolOutcome => ({ text: o.line, isError: false })),
      Effect.catchTags({
        DeviceRefusedError: (e) => Effect.succeed<ToolOutcome>({ text: e.why, isError: true }),
      }),
    );
});

/**
 * Why a room turn may not use this tool, or null. Only a guest's voice or a member other than the owner is narrowed; a
 * voice that names nobody we know is a guest.
 */
export const roomRefusal = (
  origin: {
    readonly member?: string | null | undefined;
    readonly assurance?: Assurance | undefined;
  },
  grants: { readonly role: MemberRole; readonly machine: boolean } | null,
  tool: string,
): string | null =>
  origin.member === undefined || origin.member === OWNER_MEMBER_ID
    ? null
    : principalRefusal(
        {
          role: grants?.role ?? "guest",
          machine: grants?.machine ?? false,
          assurance: origin.assurance ?? 0,
        },
        tool,
      );

const decoders = new Map(
  [...new Set<SharedName>([...ROOM_TOOLS, ...DESK_TOOLS])].map((name) => [
    name as string,
    Schema.decodeUnknownOption(
      TessayaToolkit.tools[name].parametersSchema as Schema.Codec<unknown>,
    ),
  ]),
);

/** Writes that run their own dry run for a replay, through their real checks: the house's and the settings'. */
const SELF_DRY: ReadonlySet<string> = new Set([
  "settings_set",
  "home_do",
  "home_undo",
  "home_automation_save",
  "home_automation_set",
]);

/** What the real memory and preference tools say for this input: "Kept." and a spelled name said back. */
const replayKept = (input: unknown, field: "text" | "value"): string => {
  const said =
    typeof input === "object" && input !== null && field in input
      ? String((input as Record<string, unknown>)[field] ?? "")
      : "";
  return `Kept.${foldSpelling(said)
    .names.map((n) => ` ${n.word}, ${spellOut(n.word)}.`)
    .join("")}`;
};

/** What the job tools answer, from their own words (jobs/handlers.ts), with nothing started. */
const replayJob = (name: string, input: Record<string, unknown>) => {
  // A replay's new job has an id of its own, so a later sentence can steer it as he would a real one.
  const id =
    typeof input["id"] === "string" ? input["id"] : name === "job_start" ? "job-replay-1" : null;
  const line =
    name === "job_start"
      ? `Opened ${String(input["title"])} in ${String(input["project"])} (a replay: nothing was started). It writes its plan first in its own thread and does nothing until he agrees; say you will tell him when the plan is ready.`
      : name === "job_stop"
        ? "Stopped. Its thread and plan stay."
        : name === "job_refine"
          ? "Passed on; the worker is making its plan again."
          : name === "job_agree"
            ? "Agreed; the worker has started."
            : name === "job_schedule"
              ? input["every_minutes"] === 0
                ? "The schedule is off."
                : `It runs again every ${String(input["every_minutes"])} minutes.`
              : name === "job_retry"
                ? "Asked it to try again."
                : name === "job_split"
                  ? `Started ${Array.isArray(input["parts"]) ? input["parts"].length : 0} workers, one per part; one summary goes to the job's thread when they are all in.`
                  : name === "cloud_dispatch"
                    ? "Asked. It waits for his answer on a card in Approvals, where he picks the assistant and account; nothing runs before that."
                    : name === "schedule_run_now"
                      ? "Started its run; it does not wait for it to finish."
                      : "Done (a replay: nothing changed).";
  return { id, line };
};

/**
 * A replay's other writes (an ask to his phone), checked against the tool's schema and then not sent (13 Nov 01:29: a
 * replay of "turn on the office fan" flipped his real fan). Null when the call is not one.
 */
export const replayDryRun = (name: string, input: unknown, device?: string): ToolOutcome | null => {
  if (device?.startsWith("replay-") !== true || SELF_DRY.has(name) || !decoders.has(name))
    return null;
  if (Context.get(TessayaToolkit.tools[name as SharedName].annotations, Tool.Readonly)) return null;
  return Option.isSome(decoders.get(name)!(input))
    ? {
        // What the real call answers, so her reply is the one he would hear.
        text: JOB_TOOLS.has(name)
          ? JSON.stringify(replayJob(name, input as Record<string, unknown>))
          : name === "tessaya_pronounce"
            ? "Saved (a replay: nothing was kept)."
            : name === "tessaya_memory_remember"
              ? JSON.stringify({ kept: "noted", id: null, line: replayKept(input, "text") })
              : name === "tessaya_preference_set"
                ? JSON.stringify({ line: replayKept(input, "value") })
                : name === "tessaya_memory_forget"
                  ? JSON.stringify({ line: NOT_HIS_VOICE_TO_FORGET })
                  : name === "device_watch"
                    ? // A rule is saved at once, not asked: "it waits for his answer" made her say so (13 Nov suite).
                      JSON.stringify({
                        ok: true,
                        value: { status: "done", line: "Saved the rule." },
                      })
                    : JSON.stringify({
                        id: null,
                        status: "queued",
                        line: "Sent; it waits for his answer.",
                      }),
        isError: false,
        status: "done",
      }
    : { text: `The arguments for ${name} are not right.`, isError: true };
};

/**
 * A tool call that changes something (the house, a device, a send, a memory) or looks through the camera: on a turn
 * started from his partial words it waits until the final words match the guess. Only shared reads go ahead.
 */
export const changesSomething = (name: string): boolean =>
  !(
    decoders.has(name) &&
    Context.get(TessayaToolkit.tools[name as SharedName].annotations, Tool.Readonly)
  ) && name !== LAPTOP.name;

/**
 * The assurance a room act waits for (recognition.ts's step-up), or null to run now: a change that needs more than the
 * turn's voice gave (ACCOUNTS-IDENTITY-DESIGN §3.2). Their own memory keeps its own rule in the turn.
 */
export const stepUpNeeds = (name: string, assurance: Assurance): Assurance | null => {
  if (!changesSomething(name) || toolReach(name) === "personal") return null;
  const needs = reachAssurance(name);
  return needs >= 2 && assurance < needs ? needs : null;
};

/**
 * A job act as the desktop's gate judges it (operator.ts), so the R1 and the desktop keep one rule: a deny is refused,
 * an ask waits for his yes on a phone card whatever voice asked, and an allow goes on to the voice's own step-up.
 */
export const jobVerdict = (
  name: string,
  input: unknown,
  tainted: boolean,
): "allow" | "card" | { readonly refused: string } => {
  if (!JOB_TOOLS.has(name)) return "allow";
  const verdict = judgeToolCall(
    {
      tool: `${BATON_TOOL_PREFIX}${name}`,
      input: (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>,
    },
    { actWithoutAsking: false, tainted },
  );
  return verdict.verdict === "deny"
    ? { refused: verdict.why }
    : verdict.verdict === "ask"
      ? "card"
      : "allow";
};
/** The assurance a phone card's yes gives a card act: above any voice, so only the card runs it. */
const CARD_YES = 3;
const CARD_LINE =
  "Sent to his phone for a yes: it runs once he taps yes there. Say it waits for his yes on his phone, and don't ask again.";

/** What the brain hears for a held act: she is already asking, so it says nothing more of it. */
const HELD_LINE =
  "Held until I know who is asking: I'm asking them now, and it runs once they answer or tap yes on their phone. Don't ask again.";

/** A shared tool as every vessel advertises it: its toolkit description and schema. */
const specOf = (name: SharedName): RoomTool => {
  const tool: Tool.Any = TessayaToolkit.tools[name];
  return {
    name,
    description: Tool.getDescription(tool) ?? "",
    input_schema: advertisedJsonSchema(tool),
  };
};
/** Core first, then by name: one order for every list, so a prompt's tool block stays cached. */
const byPlan = (a: RoomTool, b: RoomTool) =>
  Number(CORE_TOOLS.has(b.name)) - Number(CORE_TOOLS.has(a.name)) || a.name.localeCompare(b.name);

/** @public The room eval serves these too. */
export const ROOM_TOOL_SPECS: ReadonlyArray<RoomTool> = [
  ...ROOM_TOOLS.map(specOf),
  LAPTOP,
  VOLUME,
].toSorted(byPlan);

/** The desktop's shared tools, with whether each only reads (its gate lets a read through). */
export const DESK_TOOL_SPECS: ReadonlyArray<
  RoomTool & { readonly readonly: boolean; readonly core: boolean }
> = DESK_TOOLS.map((name) => ({
  ...specOf(name),
  readonly: Context.get(TessayaToolkit.tools[name].annotations, Tool.Readonly),
  core: CORE_TOOLS.has(name),
})).toSorted(byPlan);

/** His desktop's Tessaya's shared tools, run as its own caller (BatonTessayaRoutes' desk door). */
export const DeskTools = Context.Reference<RoomToolSet | null>("t3/home/DeskTools", {
  defaultValue: () => null,
});

/**
 * His words as the tool takes them: a number or a yes/no the model sent as a string ("1", "true") becomes one where the
 * tool's schema wants it (13 Nov: every timer and a Record read were refused for `runInMinutes: "1"`).
 */
export const asAdvertised = (spec: RoomTool, input: unknown): unknown => {
  const properties = (spec.input_schema as { properties?: Record<string, { type?: unknown }> })
    .properties;
  if (typeof input !== "object" || input === null || properties === undefined) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      const type = properties[key]?.type;
      if (typeof value !== "string") return [key, value];
      const trimmed = value.trim();
      if (
        (type === "number" || type === "integer") &&
        trimmed !== "" &&
        Number.isFinite(Number(trimmed))
      )
        return [key, Number(trimmed)];
      if (type === "boolean" && (trimmed === "true" || trimmed === "false"))
        return [key, trimmed === "true"];
      return [key, value];
    }),
  );
};

const decodeHome = Schema.decodeUnknownOption(BatonHomeCallResult);

/** A failure's own words when it has them, as the model should say them. */
const reasonOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "message" in value
    ? String(value.message)
    : "it did not work";

/**
 * The runners, built once over one toolkit: each vessel's caller and tool list with this environment. Null without the
 * server's services; found, not required, so the routes layer's type stays small (BatonServerLayer loses types).
 */
const makeRunners = Effect.gen(function* () {
  const random = yield* Effect.serviceOption(SecureRandom.SecureRandom);
  const threadsFound = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  if (Option.isNone(random) || Option.isNone(threadsFound) || Option.isNone(environment))
    return null;
  const threads = threadsFound.value;
  const toolkit = yield* Effect.provide(
    TessayaToolkit,
    McpToolAccess.HandlersLayer.layer(TessayaHandlers.layer),
  ).pipe(Effect.provideService(SecureRandom.SecureRandom, random.value));
  const environmentId = yield* environment.value.getEnvironmentId;
  const household = yield* Effect.serviceOption(TessayaHousehold);
  const stepUps = yield* Effect.serviceOption(StepUps);
  const voices = yield* Effect.serviceOption(VoiceForgets);
  // A replay's own rehearsed jobs, by its device: listed with the real ones so the next sentence can act on one.
  const rehearsed = new Map<string, Array<Record<string, unknown>>>();
  /**
   * The household's role table at execution (HOUSEHOLD-DESIGN §5): a guest's voice, or a member who is not the owner,
   * reaches only what their role does. The owner's own voice, or one Voice ID could not judge, keeps the gates it has.
   */
  const householdRefusal = Effect.fn("R1Tools.householdRefusal")(function* (name: string) {
    const origin = yield* TurnOrigin;
    if (origin === null || origin.member === OWNER_MEMBER_ID || origin.member === undefined)
      return null;
    const grants =
      origin.member === null || Option.isNone(household)
        ? null
        : yield* household.value.grantsOf(origin.member);
    return roomRefusal(origin, grants, name);
  });
  const rehearse = (device: string, name: string, input: Record<string, unknown>) => {
    const jobs = rehearsed.get(device) ?? [];
    if (name === "job_start")
      jobs.unshift({
        workSessionId: "job-replay-1",
        title: String(input["title"]),
        project: String(input["project"]),
        phase: "awaiting_agreement",
        group: "needs_you",
      });
    else
      for (const job of jobs)
        if (job["workSessionId"] === input["id"])
          Object.assign(job, { phase: "approved", group: "running" });
    rehearsed.set(device, jobs.slice(0, 1));
  };
  const runner = (vessel: {
    readonly specs: ReadonlyArray<RoomTool>;
    readonly client: McpInvocationContext.McpClientCaller;
    readonly replay: McpInvocationContext.McpClientCaller;
    /** A shared vessel whose loop asks who is speaking: its acts wait for a step-up (StepUps). */
    readonly holds: boolean;
  }) => {
    const allowed = new Set(vessel.specs.map((s) => s.name));
    const run = Effect.fn("R1Tools.run")(function* (
      name: string,
      raw: unknown,
      device?: string,
    ): Effect.fn.Return<ToolOutcome> {
      const spec = vessel.specs.find((s) => s.name === name);
      const input = spec === undefined ? raw : asAdvertised(spec, raw);
      const refused = yield* householdRefusal(name);
      if (refused !== null) return { text: refused, isError: true } as ToolOutcome;
      if (name === LAPTOP.name && allowed.has(name)) {
        const question =
          typeof input === "object" && input !== null && "question" in input
            ? String(input.question)
            : "";
        const told = yield* askLaptop(question);
        return { text: told.line, isError: !told.ok, status: told.status } as ToolOutcome;
      }
      if (name === VOLUME.name && allowed.has(name)) return yield* setRoomVolume(input, device);
      if (!allowed.has(name))
        return { text: `${name} is not a tool here.`, isError: true } as ToolOutcome;
      const origin = yield* TurnOrigin;
      const judged = jobVerdict(name, input, origin?.tainted === true);
      if (typeof judged === "object") return { text: judged.refused, isError: true } as ToolOutcome;
      // The desk with no turn is the desktop app's own call through its desk door: its gate already asked him.
      if (
        judged === "card" &&
        (origin !== null || vessel.holds) &&
        (origin?.assurance ?? 0) < CARD_YES
      ) {
        if (!vessel.holds || device === undefined || origin === null || Option.isNone(stepUps))
          return {
            text: "That needs his yes on his phone, and it can't be asked from here.",
            isError: true,
          } as ToolOutcome;
        const act = yield* stepUps.value.hold({
          device,
          what: `${name.replace(/_/g, " ")} ${recordText(JSON.stringify(input ?? {}), 120)}`,
          member: origin.member ?? null,
          needs: CARD_YES,
          card: true,
          phone: !device.startsWith("replay-"),
          run: (raised) =>
            run(name, raw, device).pipe(
              Effect.provideService(TurnOrigin, { ...origin, ...raised }),
              Effect.asVoid,
            ),
        });
        return { text: `${CARD_LINE} (${act})`, isError: false, status: "asked" } as ToolOutcome;
      }
      // Held for a step-up only where a vessel judged the voice (it sent one) and Voice ID can tell anyone apart (a
      // member has a voice). A replay holds too, with no card on his phone, and its act then runs as a dry run.
      const needs = origin === null ? null : stepUpNeeds(name, origin.assurance ?? 0);
      if (
        needs !== null &&
        origin !== null &&
        origin.speaker != null &&
        vessel.holds &&
        device !== undefined &&
        Option.isSome(stepUps) &&
        Option.isSome(voices) &&
        (yield* voices.value.current).length > 0
      ) {
        const act = yield* stepUps.value.hold({
          device,
          what: `${name.replace(/_/g, " ")} ${recordText(JSON.stringify(input ?? {}), 120)}`,
          member: origin.member ?? null,
          needs,
          phone: !device.startsWith("replay-"),
          run: (raised) =>
            run(name, raw, device).pipe(
              Effect.provideService(TurnOrigin, { ...origin, ...raised }),
              Effect.asVoid,
            ),
        });
        return { text: `${HELD_LINE} (${act})`, isError: false, status: "asked" } as ToolOutcome;
      }
      const dry = replayDryRun(name, input, device);
      if (dry !== null) {
        if (device !== undefined && !dry.isError && (name === "job_start" || name === "job_agree"))
          rehearse(device, name, input as Record<string, unknown>);
        return dry;
      }
      const scope: McpInvocationScope = {
        environmentId,
        capabilities: new Set(["orchestration"]),
        issuedAt: yield* Clock.currentTimeMillis,
        requestNamespace: vessel.client.sessionId,
        thread: undefined,
        client: device?.startsWith("replay-") === true ? vessel.replay : vessel.client,
        linkedEnvironments: false,
      };
      const last = yield* toolkit.handle(name as SharedName, input as never).pipe(
        Effect.flatMap(Stream.runLast),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        Effect.catchCause((cause) =>
          Effect.succeedSome({ isFailure: true, result: Cause.squash(cause) }),
        ),
      );
      if (Option.isNone(last)) return { text: "No answer.", isError: true } as ToolOutcome;
      const { isFailure, result } = last.value as { isFailure: boolean; result: unknown };
      if (isFailure) return { text: reasonOf(result), isError: true } as ToolOutcome;
      const home = decodeHome(result);
      if (Option.isSome(home)) {
        if (!home.value.ok)
          return {
            text: home.value.error ?? "it did not work",
            isError: true,
            status: "failed",
          } as ToolOutcome;
        const value = home.value.value as { status?: unknown } | undefined;
        return {
          text: JSON.stringify(home.value.value ?? null),
          isError: false,
          ...(typeof value?.status === "string" ? { status: value.status } : {}),
        } as ToolOutcome;
      }
      const own =
        name === "tessaya_jobs" && device !== undefined ? rehearsed.get(device) : undefined;
      if (own !== undefined && typeof result === "object" && result !== null && "jobs" in result)
        return {
          text: JSON.stringify({ ...result, jobs: [...own, ...(result.jobs as Array<unknown>)] }),
          isError: false,
        } as ToolOutcome;
      return { text: JSON.stringify(result), isError: false } as ToolOutcome;
    });
    return run;
  };
  const room: RoomToolSet = {
    specs: ROOM_TOOL_SPECS,
    run: runner({
      specs: ROOM_TOOL_SPECS,
      client: ROOM_CLIENT,
      replay: ROOM_REPLAY_CLIENT,
      holds: true,
    }),
  };
  const desk: RoomToolSet = {
    specs: DESK_TOOL_SPECS,
    run: runner({
      specs: DESK_TOOL_SPECS,
      client: DESK_CLIENT,
      replay: DESK_REPLAY_CLIENT,
      holds: false,
    }),
  };
  return { room, desk };
});

/** The room's tools for R1Device's routes and the desktop's for its door; built once with the server. */
export const layer = Layer.unwrap(
  Effect.map(makeRunners, (r) =>
    Layer.mergeAll(
      Layer.succeed(RoomTools, r?.room ?? null),
      Layer.succeed(DeskTools, r?.desk ?? null),
    ),
  ),
);
