// @effect-diagnostics globalJsonInEffect:off
/**
 * The room's tools: the same /mcp tools his agents get (the house, his team and work, asks for his yes), called
 * in-process through their own handlers as `ROOM_CLIENT`, so McpToolAccess and the house's gate apply as on /mcp. Plus
 * laptop_ask, which asks his laptop's Tessaya. No file, shell or screen tools: the room only reads and asks.
 */
import { BatonHomeCallResult } from "@t3tools/baton-contracts";
import { DEVICE_TOOL_TEXT } from "@t3tools/baton-shared/deviceTools";
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
import { TessayaToolkit } from "../mcp/toolkits/tessaya/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { RoomTools, type RoomTool, type RoomToolSet, type ToolOutcome } from "./R1Brain.ts";
import { NOT_HIS_VOICE_TO_FORGET } from "../baton/TessayaTurn.ts";
import { askLaptop } from "./R1Laptop.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import { HomeDevices } from "./HomeDevices.ts";

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
  "members_home",
  "member_invite",
  "member_set_role",
  "member_remove",
  "member_restore",
] as const satisfies ReadonlyArray<keyof typeof TessayaToolkit.tools>;

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
        text:
          name === "tessaya_pronounce"
            ? "Saved (a replay: nothing was kept)."
            : name === "tessaya_memory_remember"
              ? JSON.stringify({ kept: "noted", id: null, line: "Kept." })
              : name === "tessaya_memory_forget"
                ? JSON.stringify({ line: NOT_HIS_VOICE_TO_FORGET })
                : name === "device_watch"
                  ? // A rule is saved at once, not asked: "it waits for his answer" made her say so (13 Nov suite).
                    JSON.stringify({ ok: true, value: { status: "done", line: "Saved the rule." } })
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
  const runner = (vessel: {
    readonly specs: ReadonlyArray<RoomTool>;
    readonly client: McpInvocationContext.McpClientCaller;
    readonly replay: McpInvocationContext.McpClientCaller;
  }) => {
    const allowed = new Set(vessel.specs.map((s) => s.name));
    return Effect.fn("R1Tools.run")(function* (name: string, raw: unknown, device?: string) {
      const spec = vessel.specs.find((s) => s.name === name);
      const input = spec === undefined ? raw : asAdvertised(spec, raw);
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
      const dry = replayDryRun(name, input, device);
      if (dry !== null) return dry;
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
      return { text: JSON.stringify(result), isError: false } as ToolOutcome;
    });
  };
  const room: RoomToolSet = {
    specs: ROOM_TOOL_SPECS,
    run: runner({ specs: ROOM_TOOL_SPECS, client: ROOM_CLIENT, replay: ROOM_REPLAY_CLIENT }),
  };
  const desk: RoomToolSet = {
    specs: DESK_TOOL_SPECS,
    run: runner({ specs: DESK_TOOL_SPECS, client: DESK_CLIENT, replay: DESK_REPLAY_CLIENT }),
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
