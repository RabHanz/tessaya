// @effect-diagnostics globalJsonInEffect:off
/**
 * The room's tools: the same /mcp tools his agents get (the house, his team and work, asks for his yes), called
 * in-process through their own handlers as `ROOM_CLIENT`, so McpToolAccess and the house's gate apply as on /mcp. Plus
 * laptop_ask, which asks his laptop's Tessaya. No file, shell or screen tools: the room only reads and asks.
 */
import { TessayaHomeCallResult } from "@t3tools/tessaya-contracts";
import { DEVICE_TOOL_TEXT, VOLUME_INPUT_SCHEMA } from "@t3tools/tessaya-shared/deviceTools";
import { foldSpelling, spellOut } from "@t3tools/tessaya-shared/spelling";
import {
  type Assurance,
  type MemberRole,
  OWNER_MEMBER_ID,
} from "@t3tools/tessaya-shared/household";
import {
  decideTrust,
  principalRefusal,
  reachAssurance,
  toolReach,
  type TrustAgent,
} from "@t3tools/tessaya-shared/trust";
import { BATON_TOOL_PREFIX } from "@t3tools/tessaya-shared/operator";
import { standingKey } from "@t3tools/tessaya-shared/consent";
import { recordText } from "@t3tools/tessaya-shared/audit";
import { volumeAfter, volumeLine, type VolumeTo } from "@t3tools/tessaya-shared/speakingVolume";
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
import { NOT_HIS_VOICE_TO_FORGET, TurnOrigin } from "../tessaya/TessayaTurn.ts";
import { traced } from "../provenance/ActionLog.ts";
import { Consent, hisOwnTurn } from "../tessaya/consent.ts";
import { trustAgentOf } from "../tessaya/OperatingSystemPack.ts";
import { TessayaHousehold } from "../tessaya/TessayaHousehold.ts";
import { houseZone, onHouseClockText } from "../tessaya/houseZone.ts";
import { askLaptop } from "./R1Laptop.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import { HomeDevices, routedAct } from "./HomeDevices.ts";
import { onPeer } from "../peer/PeerVessels.ts";
import { StepUps } from "./StepUps.ts";
import { VoiceForgets } from "../tessaya/VoiceForgets.ts";
import { askHisYes, VesselHands } from "../tessaya/VesselHands.ts";

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
  "tessaya_work_now",
  "tessaya_sessions",
  // "What's the build session doing?", "tell it to rerun the tests" (M-104).
  "tessaya_session_insight",
  "tessaya_session_steer",
  "tessaya_fleet",
  "tessaya_jobs",
  "tessaya_watch",
  // Her health (17 Nov): "why are you slow?", "why didn't you wake?".
  "tessaya_health",
  // "Report this" on any vessel: one report, the queue, and the way back.
  "tessaya_report_problem",
  "tessaya_reports",
  "tessaya_report_withdraw",
  "tessaya_record",
  "tessaya_rules",
  "tessaya_memory_search",
  "tessaya_memory_remember",
  "tessaya_memory_forget",
  "tessaya_attribution_move",
  "tessaya_my_state",
  "tessaya_memory_about",
  "tessaya_coming_up",
  "tessaya_owner_doc",
  "tessaya_usage_report",
  // Activity / Why (B-046): "what did you do in the last hour?", "why did that happen?".
  "tessaya_activity",
  "tessaya_whos_home",
  // Who's on which body: "who's on Tumble?", "bring Alfred here", "send everyone home" (Settings → Cast).
  "tessaya_cast",
  // Her pulse (B-003): "what have you noticed?", "that was helpful", "stop telling me about X".
  "tessaya_pulse",
  "tessaya_preference_set",
  "tessaya_persona_handoff",
  "tessaya_job_lead",
  "tessaya_wake_words",
  "tessaya_wake_word_change",
  "tessaya_ask",
  "tessaya_ask_status",
  "tessaya_pronounce",
  // His Scratchpad, the same notes as the desktop's: "note that the invoice is due Friday".
  "tessaya_note_add",
  "tessaya_note_search",
  // "How do I make a snippet?": her answer from her own help pages (docs/user).
  "tessaya_help",
  // One meaning on every vessel: the device it is heard on, or the one he names; the room runs it itself (VOLUME).
  "set_device_volume",
  // His standing yeses by voice: "stop letting you look at my screen".
  "tessaya_always_allowed",
  // Alarms and wake-ups at a set time (M-108): "wake me up at 8:45", and "stop" or "snooze" when it rings.
  "tessaya_alarm",
  "tessaya_transcript",
  // His prompt lab (B-030): "try my variant B on Sonnet"; making one live waits for his yes.
  "tessaya_prompt_lab",
  "settings_find",
  "settings_get",
  "settings_explain",
  "settings_set",
  "settings_set_many",
  "settings_answer_all",
  "tessaya_account_use",
  // Her body, the one on every screen she is on (M-065): "wave at me", "come sit with me".
  "tessaya_body_move",
  "tessaya_body_state",
  "tessaya_body_scene",
  // Every vessel's self-described items, from any vessel (R1-P13).
  "device_registry",
  "device_read",
  "device_set",
  "device_watch",
  "device_button",
  "members_list",
  "member_invite",
  "member_whoami",
  "member_consent",
  "member_limit",
  "member_set_role",
  "member_remove",
  "member_restore",
  "member_rename",
  "member_preferences",
  "member_preference_set",
  "member_vessel",
  "household_home_server",
  // People she knows by voice or from his memory (HOUSEHOLD-DESIGN §11).
  "people_who",
  "people_introduce",
  "people_forget_me",
  "people_list",
  "people_manage",
  // A persona acting in the ops system as its own worker: warm-ups, posts that wait for his yes, his decision by voice.
  "ops_warmups",
  "ops_warmup_set",
  "ops_warmup_run",
  "ops_post",
  "ops_decide",
  "ops_access",
  // Messages and announcements between the people here (COMMS-DESIGN C-1).
  "comms_send",
  "comms_inbox",
  "comms_play",
  "comms_react",
  "comms_dnd",
  "comms_emergency",
  "comms_emergency_ok",
  "comms_false_alarm",
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
  "schedule_pause",
  "schedule_delete",
  "project_add",
  "cloud_dispatch",
  // What his keyboard could do and her voice could not (voice parity, 16 Nov).
  "tessaya_memory_history",
  "tessaya_state",
  "tessaya_vocabulary",
  "tessaya_voice",
  "tessaya_persona",
  "tessaya_group",
  "tessaya_main_session",
  "tessaya_move_into_tessaya",
  "tessaya_open_in_terminal",
  "weave_list",
  "device_owner",
  "device_tag",
  // The server's upkeep and who may reach his work (guarded RPCs, 16 Nov parity): owner only, changes on his yes.
  "environment_maintain",
  "access_manage",
  // The home's intercom and his memory across servers (16 Nov parity): owner only, turning on waits for his yes.
  "intercom_switch",
  "memory_sync_switch",
] as const satisfies ReadonlyArray<keyof typeof TessayaToolkit.tools>;

type ToolName = keyof typeof TessayaToolkit.tools;

/**
 * Every Tessaya tool the room leaves out, and why: a new tool is voiced or says why not here, or this does not compile.
 * @public The voice parity gate reads it.
 */
export const NOT_IN_ROOM: {
  readonly [K in Exclude<ToolName, (typeof ROOM_TOOLS)[number]>]: string;
} = {
  tessaya_whats_new_record:
    "the release lane records what shipped; she reads it in tessaya_my_state",
  tessaya_desktop_settings:
    "settings_find, settings_get and settings_set reach the same desktop fields",
  tessaya_coming_up_change:
    "the room changes a timer with home_automation_set and home_automation_save under the same id, the one amend path; the rest waits for a room eval",
  tessaya_session_defaults:
    "settings_get reads newSessionsRun and mainThreadId, and settings_set changes them",
  tessaya_voice_arbiter: "only his other servers call it, never a person",
  tessaya_memory_unlearn:
    "only his own t3 memory command calls it, to unlearn test playback; by voice he forgets with tessaya_memory_forget",
  phone_pairing_code: "only his other servers call it, for the desktop's Add a phone QR",
  household_device_revoke: "only his other servers call it, to sign a phone out everywhere",
  tessaya_brain: "only his other servers call it, to send what they heard to her brain",
  household_peer: "only another of this home's linked servers calls it",
  household_voice_forget: "only another of this home's linked servers calls it",
  tessaya_dev_feed: "a maintainer agent's live tail of the developer feed, never a person's",
  weave_send:
    "tessaya_session_steer is his words to a session (read back, marked as his, recorded, a job through job_refine); weave_send stays for agents messaging sessions",
  device_sync: "only another of his linked servers calls it, to keep his devices' records alike",
  device_act:
    "the Tessel shows its own eyes, lights and voice as she speaks; the desktop drives them with device_act",
};

/** The desktop's own tools already do these (memory_history, weave_send, thread_*), and it answers the asks. */
const DESK_HAS_ITS_OWN: ReadonlySet<string> = new Set<ToolName>([
  "tessaya_ask",
  "tessaya_ask_status",
  "tessaya_memory_history",
  "tessaya_state",
  "tessaya_move_into_tessaya",
  "tessaya_open_in_terminal",
  "weave_send",
  "weave_list",
]);

/** The work tools (jobs, schedules, projects, cloud), judged by the desktop's table (judgeToolCall). */
const JOB_TOOLS: ReadonlySet<string> = new Set(JobTools.map((tool) => tool.name));

/** The shared tools his desktop's Tessaya gets: the room's, less its own, plus driving a device's eyes and lights. */
const DESK_TOOLS = [
  ...ROOM_TOOLS.filter((name) => !DESK_HAS_ITS_OWN.has(name)),
  "device_act",
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
  input_schema: VOLUME_INPUT_SCHEMA,
};

const volumeTo = (input: unknown): VolumeTo | null => {
  const to = typeof input === "object" && input !== null && "to" in input ? input.to : null;
  if (typeof to === "number" && Number.isFinite(to)) return to;
  return to === "up" || to === "down" || to === "max" || to === "default" ? to : null;
};

/** On this room's R1, through the devices' own command path. */
export const setRoomVolume = Effect.fn("R1Tools.volume")(function* (
  input: unknown,
  heardOn?: string,
) {
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
  // The one meaning: the device he names (`id`, from device_registry), else the one this turn is heard on.
  const named =
    typeof input === "object" && input !== null && "id" in input && typeof input.id === "string"
      ? input.id.trim() || null
      : null;
  const target = named ?? device?.deviceId ?? null;
  if (target === null || Option.isNone(devices))
    return { text: "There is no speaker set up here.", isError: true } as ToolOutcome;
  return yield* devices.value
    .command(target, { op: "volume", to }, { who: "Tessaya in the room", surface: "assistant" })
    .pipe(
      Effect.map((o): ToolOutcome => ({ text: o.line, isError: false })),
      Effect.catchTags({
        DeviceRefusedError: (e) =>
          e.notLinked !== true
            ? Effect.succeed<ToolOutcome>({ text: e.why, isError: true })
            : // On another server's hub (the brain's turn, her hub local): that server sets it, as device_set does.
              onPeer(
                "set_device_volume",
                { id: target, to: (input as { readonly to?: unknown }).to },
                {
                  takes: (v) => (v as { readonly notLinked?: unknown }).notLinked !== true,
                  wait: "4 seconds",
                },
              ).pipe(
                Effect.map((held): ToolOutcome => {
                  const answer = held?.value as
                    | {
                        readonly ok?: unknown;
                        readonly error?: unknown;
                        readonly value?: { readonly line?: unknown };
                      }
                    | undefined;
                  if (answer === undefined) return { text: e.why, isError: true };
                  // Refused there too, for its own reason: said as that, never as done.
                  if (answer.ok !== true)
                    return {
                      text: typeof answer.error === "string" ? answer.error : e.why,
                      isError: true,
                    };
                  const line = answer.value?.line;
                  return { text: typeof line === "string" ? line : "Done.", isError: false };
                }),
                routedAct(target, "volume", "Tessaya in the room", (o: ToolOutcome) => o.isError),
              ),
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
  grants: {
    readonly role: MemberRole;
    readonly machine: boolean;
    readonly quietNow?: boolean | undefined;
  } | null,
  tool: string,
  input?: unknown,
): string | null =>
  origin.member === undefined || origin.member === OWNER_MEMBER_ID
    ? null
    : principalRefusal(
        {
          role: grants?.role ?? "guest",
          machine: grants?.machine ?? false,
          assurance: origin.assurance ?? 0,
          ...(grants?.quietNow === true ? { quiet: true } : {}),
        },
        tool,
        input,
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
  "settings_set_many",
  "tessaya_account_use",
  "comms_send",
  "comms_play",
  "comms_react",
  "comms_dnd",
  "comms_emergency",
  "comms_emergency_ok",
  "comms_false_alarm",
  "home_do",
  "home_undo",
  "home_automation_save",
  "home_automation_set",
]);

const SWITCHES: ReadonlySet<string> = new Set(["intercom_switch", "memory_sync_switch"]);

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
/**
 * The job the live suite's sentences name (job-go, job-retry, job-unschedule): a replay's job list carries it, so a
 * model that checks the list before acting finds the job he named rather than refusing a made-up id.
 */
const SUITE_JOB = {
  workSessionId: "job-suite-1",
  title: "Fix the flaky tests",
  project: "acme app",
  phase: "failed",
  group: "needs_you",
};

export const replayDryRun = (name: string, input: unknown, device?: string): ToolOutcome | null => {
  if (device?.startsWith("replay-") !== true || SELF_DRY.has(name) || !decoders.has(name))
    return null;
  if (Context.get(TessayaToolkit.tools[name as SharedName].annotations, Tool.Readonly)) return null;
  // A switch without `on` only reads, so a replay hears the real state.
  if (SWITCHES.has(name) && (input as { on?: unknown } | null)?.on === undefined) return null;
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
                : name === "tessaya_persona_handoff"
                  ? // TessayaTurn.handOff's own line: "nothing changed" made her say so aloud (15 Nov suite).
                    JSON.stringify({
                      ok: true,
                      line:
                        typeof (input as { to?: unknown }).to === "string"
                          ? `${(input as { to: string }).to} has this conversation now: say so in a few words.`
                          : "Handed back: say so in a few words.",
                    })
                  : name === "people_forget_me" &&
                      (input as { confirmed?: unknown }).confirmed !== true
                    ? // TessayaPeople's ask: "Done (nothing changed)" to the ask made her invent why (.168 suite).
                      JSON.stringify({
                        status: "asked",
                        line: "Before I do: forgetting you removes your voice and what I know of you. Ask them for a clear yes, then call again with confirmed.",
                      })
                    : name === "tessaya_alarm"
                      ? // The alarm as the real tool words it (its time back to him), never "it waits for his answer".
                        JSON.stringify({
                          line: alarmRehearsal(input as Readonly<Record<string, unknown>>),
                          alarms: [],
                        })
                      : name === "tessaya_always_allowed"
                        ? // His standing yes as the real tool words it, so she confirms it rather than guessing.
                          JSON.stringify({
                            allowed: [],
                            line: "Got it. I won't ask about that again.",
                          })
                        : name === "tessaya_wake_word_change" ||
                            name === "tessaya_job_lead" ||
                            name.startsWith("people_")
                          ? JSON.stringify({ ok: true, line: "Done (a replay: nothing changed)." })
                          : name === "tessaya_memory_forget"
                            ? JSON.stringify({
                                line:
                                  typeof (input as { fact?: unknown }).fact === "string" &&
                                  (input as { confirmed?: unknown }).confirmed !== true &&
                                  (input as { restore?: unknown }).restore !== true
                                    ? "Forget that? Ask for a clear yes, then call again with confirmed."
                                    : NOT_HIS_VOICE_TO_FORGET,
                              })
                            : name === "device_watch" || name === "device_button"
                              ? // A rule is saved at once, not asked: "it waits for his answer" made her say so (13 Nov suite).
                                JSON.stringify({
                                  ok: true,
                                  value: {
                                    status: "done",
                                    line: name === "device_watch" ? "Saved the rule." : "Saved.",
                                  },
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

/** What `tessaya_alarm` says in a rehearsal: its own words, with the time he gave. */
const alarmRehearsal = (input: Readonly<Record<string, unknown>>): string =>
  input["op"] === "stop"
    ? "Stopped your alarm."
    : input["op"] === "snooze"
      ? `Snoozed for ${typeof input["minutes"] === "number" ? input["minutes"] : 9} minutes.`
      : input["op"] === "list"
        ? "No alarms are set."
        : typeof input["clock"] === "string"
          ? `Waking you at ${input["clock"]}.`
          : typeof input["inMinutes"] === "number"
            ? `Done, in ${input["inMinutes"]} minutes.`
            : "Give me a time like 08:45, or how many minutes from now.";

/**
 * A tool call that changes something (the house, a device, a send, a memory) or looks through the camera: on a turn
 * started from his partial words it waits until the final words match the guess. Only shared reads go ahead.
 */
export const changesSomething = (name: string, input?: unknown): boolean =>
  !(
    decoders.has(name) &&
    Context.get(TessayaToolkit.tools[name as SharedName].annotations, Tool.Readonly)
  ) &&
  name !== LAPTOP.name &&
  !readsOnly(name, input);

/** A write tool's actions that only look: "who's on which device?" was held for a step-up (18 Nov, 00:38 GMT+5). */
const READ_ACTIONS: Readonly<Record<string, readonly [string, ReadonlySet<unknown>]>> = {
  tessaya_cast: ["action", new Set(["who"])],
  tessaya_prompt_lab: ["action", new Set(["list"])],
  tessaya_group: ["op", new Set(["status"])],
  access_manage: ["op", new Set(["links"])],
  ops_access: ["op", new Set(["list"])],
};
const readsOnly = (name: string, input: unknown): boolean => {
  const read = READ_ACTIONS[name];
  return (
    read !== undefined &&
    typeof input === "object" &&
    input !== null &&
    read[1].has((input as Record<string, unknown>)[read[0]])
  );
};

/**
 * Her words for a held act, finishing "so she can …": never a tool's name or its arguments, which go behind the card's
 * Details (18 Nov: "tessaya cast {"action":"who"}" was shown to him).
 */
const plainAct = (name: string, input: unknown): string => {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const text = (key: string, otherwise: string) =>
    typeof i[key] === "string" && i[key] !== "" ? recordText(i[key], 40) : otherwise;
  const body = text("body", "here").toLowerCase() === "here" ? "this device" : text("body", "");
  switch (name) {
    case "tessaya_cast":
      return i["action"] === "call"
        ? `bring ${text("persona", "a persona")} to ${body}`
        : i["action"] === "sendHome"
          ? "send everyone back to their own device"
          : "change who is on which device";
    case "settings_set":
    case "settings_set_many":
    case "settings_answer_all":
      return "change your settings";
    case "home_automation_save":
      return "save a home automation";
    case "tessaya_prompt_lab":
      return "change which prompt is live";
    case "job_start":
      return `open a job${typeof i["title"] === "string" ? `: ${recordText(i["title"], 60)}` : ""}`;
    case "job_agree":
      return "start the job plan you agreed";
    case "job_schedule":
      return "run a job again on a schedule";
    case "project_add":
      return "add a project to this computer";
    case "schedule_delete":
      return "delete a scheduled task";
    case "access_manage":
      return "change who can reach your work";
    default:
      return name.startsWith("member_")
        ? "change who is in your household"
        : "go ahead with what you just asked";
  }
};

/** One act, however it was worded: a newer ask for it on the same device takes the older one's place. */
const actKey = (name: string, input: unknown): string => {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return `${name}:${String(i["action"] ?? i["op"] ?? i["id"] ?? "")}`;
};

/**
 * The assurance a room act waits for (recognition.ts's step-up), or null to run now: a change that needs more than the
 * turn's voice gave (ACCOUNTS-IDENTITY-DESIGN §3.2). Their own memory keeps its own rule in the turn.
 */
export const stepUpNeeds = (
  name: string,
  assurance: Assurance,
  input?: unknown,
): Assurance | null => {
  if (!changesSomething(name, input) || toolReach(name) === "personal") return null;
  const needs = reachAssurance(name, input);
  return needs >= 2 && assurance < needs ? needs : null;
};

/**
 * A job act as the desktop's gate judges it (`decideTrust`), so the R1 and the desktop keep one rule: the turn's
 * persona narrows it (its tools; only a lead hands out work), a deny is refused, an ask waits for his yes (`card`
 * names why, the key of a standing yes), and an allow goes on to the voice's own step-up.
 */
export const jobVerdict = (
  name: string,
  input: unknown,
  tainted: boolean,
  agent?: TrustAgent,
): "allow" | { readonly card: string } | { readonly refused: string } => {
  // Changing which prompt is live is his call each time, as a job's go-ahead is.
  if (name === "tessaya_prompt_lab") {
    const action = (input as { readonly action?: unknown } | null)?.action;
    return action === "promote" || action === "rollback"
      ? { card: "It changes which prompt is live." }
      : "allow";
  }
  if (!JOB_TOOLS.has(name)) return "allow";
  const verdict = decideTrust({
    call: {
      tool: `${BATON_TOOL_PREFIX}${name}`,
      input: (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>,
    },
    context: { actWithoutAsking: false, tainted },
    plan: null,
    ...(agent === undefined ? {} : { agent }),
  });
  return verdict.verdict === "deny"
    ? { refused: verdict.why }
    : verdict.verdict === "ask"
      ? { card: verdict.why }
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
  const spec = {
    name,
    description: Tool.getDescription(tool) ?? "",
    input_schema: advertisedJsonSchema(tool),
  };
  return name === "tessaya_body_move"
    ? slimBodyMove(spec)
    : name.startsWith("tessaya_body_")
      ? withoutTarget(spec)
      : spec;
};

/** Her own turns always move her: the playground's `target` and stage are an agent's, never the room's or the desk's. */
const withoutTarget = (spec: RoomTool): RoomTool => {
  const schema = spec.input_schema as {
    readonly properties?: Record<string, unknown>;
    readonly required?: ReadonlyArray<string>;
  };
  const { target: _target, playground: _playground, ...properties } = schema.properties ?? {};
  return {
    ...spec,
    input_schema: {
      ...schema,
      properties,
      ...(schema.required === undefined
        ? {}
        : { required: schema.required.filter((r) => r !== "target" && r !== "playground") }),
    },
  };
};

/**
 * Her body move as a spoken turn needs it: one step, no timeline (`then`) or live frames (`stream`). Whole, its schema
 * was 16.5 KB of the room's 50 KB, and the .193 room gate missed home_automation_set and tessaya_memory_remember 3/3;
 * agents through MCP keep the whole tool, and a scene is tessaya_body_scene.
 */
const slimBodyMove = (spec: RoomTool): RoomTool => {
  const schema = spec.input_schema as { readonly properties?: Record<string, unknown> };
  const { then: _then, stream: _stream, ...properties } = schema.properties ?? {};
  return withoutTarget({
    ...spec,
    description: spec.description.replace(/,? and put what follows in `then`[^.]*\./, "."),
    input_schema: { ...schema, properties },
  });
};
/** Core first, then by name: one order for every list, so a prompt's tool block stays cached. */
const byPlan = (a: RoomTool, b: RoomTool) =>
  Number(CORE_TOOLS.has(b.name)) - Number(CORE_TOOLS.has(a.name)) || a.name.localeCompare(b.name);

/** @public The room eval serves these too. */
export const ROOM_TOOL_SPECS: ReadonlyArray<RoomTool> = [
  ...ROOM_TOOLS.filter((name) => name !== VOLUME.name).map(specOf),
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

/** His desktop's Tessaya's shared tools, run as its own caller (TessayaRoutes' desk door). */
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

const decodeHome = Schema.decodeUnknownOption(TessayaHomeCallResult);

/** A failure's own words when it has them, as the model should say them. */
const reasonOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "message" in value
    ? String(value.message)
    : "it did not work";

/**
 * The runners, built once over one toolkit: each vessel's caller and tool list with this environment. Null without the
 * server's services; found, not required, so the routes layer's type stays small (TessayaServerLayer loses types).
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
  const consent = yield* Effect.serviceOption(Consent);
  const granted = (key: string, origin: Parameters<Consent["Service"]["holds"]>[1]) =>
    Option.isSome(consent) ? consent.value.holds(key, origin) : Effect.succeed(false);
  const grant = (key: string, member: string | null | undefined) =>
    Option.isSome(consent)
      ? Effect.asVoid(consent.value.set(key, true, { member: member ?? OWNER_MEMBER_ID }))
      : Effect.void;
  // A replay's own rehearsed jobs, by its device: listed with the real ones so the next sentence can act on one.
  const rehearsed = new Map<string, Array<Record<string, unknown>>>();
  /**
   * The household's role table at execution (HOUSEHOLD-DESIGN §5): a guest's voice, or a member who is not the owner,
   * reaches only what their role does. The owner's own voice, or one Voice ID could not judge, keeps the gates it has.
   */
  const householdRefusal = Effect.fn("R1Tools.householdRefusal")(function* (
    name: string,
    input: unknown,
  ) {
    const origin = yield* TurnOrigin;
    if (origin === null || origin.member === OWNER_MEMBER_ID || origin.member === undefined)
      return null;
    const grants =
      origin.member === null || Option.isNone(household)
        ? null
        : yield* household.value.grantsOf(origin.member);
    return roomRefusal(origin, grants, name, input);
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
    const run = Effect.fn("R1Tools.run")(
      function* (name: string, raw: unknown, device?: string): Effect.fn.Return<ToolOutcome> {
        const spec = vessel.specs.find((s) => s.name === name);
        const input = spec === undefined ? raw : asAdvertised(spec, raw);
        const refused = yield* householdRefusal(name, input);
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
        const judged = jobVerdict(
          name,
          input,
          origin?.tainted === true,
          yield* trustAgentOf(origin?.persona),
        );
        if (typeof judged === "object" && "refused" in judged)
          return { text: judged.refused, isError: true } as ToolOutcome;
        // The desk with no turn is the desktop app's own call through its desk door: its gate already asked him.
        if (
          judged !== "allow" &&
          (origin !== null || vessel.holds) &&
          (origin?.assurance ?? 0) < CARD_YES
        ) {
          const key = standingKey(name, judged.card);
          const asCard = (o: NonNullable<typeof origin>) =>
            run(name, raw, device).pipe(
              Effect.provideService(TurnOrigin, { ...o, assurance: CARD_YES }),
            );
          // His "Always allow", given on any vessel, is his yes here; never a guest's or an unverified voice's.
          if (yield* granted(key, origin)) return yield* asCard(origin!);
          const what = `${name.replace(/_/g, " ")} ${recordText(JSON.stringify(input ?? {}), 120)}`;
          // A desk turn on the brain asks in his desktop's own approval box; his phone is asked only when it can't be.
          if (!vessel.holds && origin !== null) {
            const hands = yield* Effect.serviceOption(VesselHands);
            const yes = Option.isNone(hands)
              ? "unreachable"
              : yield* askHisYes(hands.value, origin, what, origin.tainted === true ? null : key);
            if (yes === "always") yield* grant(key, origin.member);
            if (yes === "yes" || yes === "always") return yield* asCard(origin);
            if (yes === "no")
              return {
                text: "He said no on his desktop. Nothing was done.",
                isError: false,
                status: "refused",
              } as ToolOutcome;
          }
          const at = device ?? (vessel.holds ? undefined : "desktop");
          if (at === undefined || origin === null || Option.isNone(stepUps))
            return {
              text: "That needs his yes on his phone, and it can't be asked from here.",
              isError: true,
            } as ToolOutcome;
          const act = yield* stepUps.value.hold({
            device: at,
            what: plainAct(name, input),
            key: actKey(name, input),
            details: what,
            member: origin.member ?? null,
            needs: CARD_YES,
            card: true,
            ...(!origin.tainted && hisOwnTurn(origin) ? { always: grant(key, origin.member) } : {}),
            phone: !at.startsWith("replay-"),
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
        const needs = origin === null ? null : stepUpNeeds(name, origin.assurance ?? 0, input);
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
            what: plainAct(name, input),
            key: actKey(name, input),
            details: `${name.replace(/_/g, " ")} ${recordText(JSON.stringify(input ?? {}), 120)}`,
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
          if (
            device !== undefined &&
            !dry.isError &&
            (name === "job_start" || name === "job_agree")
          )
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
        // A change by voice is an action, as the same call over /mcp is; reads stay out of the log.
        const logged = changesSomething(name, input)
          ? traced({
              kind: "tool.call",
              actor:
                origin === null
                  ? { kind: "system", id: vessel.client.sessionId, certainty: 1 }
                  : {
                      kind:
                        origin.member == null || origin.member === OWNER_MEMBER_ID
                          ? "owner"
                          : "member",
                      id: origin.member ?? OWNER_MEMBER_ID,
                      certainty: origin.assurance ?? 0,
                    },
              subject: name,
              persona: origin?.persona ?? null,
              evidence: device === undefined ? [] : [{ kind: "device", ref: device }],
            })
          : <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;
        const last = yield* toolkit.handle(name as SharedName, input as never).pipe(
          Effect.flatMap(Stream.runLast),
          logged,
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
          name === "tessaya_jobs" && device?.startsWith("replay-") === true
            ? [...(rehearsed.get(device) ?? []), SUITE_JOB]
            : undefined;
        if (own !== undefined && typeof result === "object" && result !== null && "jobs" in result)
          return {
            text: JSON.stringify({ ...result, jobs: [...own, ...(result.jobs as Array<unknown>)] }),
            isError: false,
          } as ToolOutcome;
        return { text: JSON.stringify(result), isError: false } as ToolOutcome;
      },
      (outcome) =>
        Effect.flatMap(outcome, (o) =>
          Effect.map(houseZone(), (zone) => ({ ...o, text: onHouseClockText(o.text, zone) })),
        ),
    );
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
