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
import { ROOM_CLIENT } from "../mcp/toolkits/home/handlers.ts";
import * as TessayaHandlers from "../mcp/toolkits/tessaya/handlers.ts";
import { TessayaToolkit } from "../mcp/toolkits/tessaya/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { RoomTools, type RoomTool, type ToolOutcome } from "./R1Brain.ts";
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
  "tessaya_ask",
  "tessaya_ask_status",
  "tessaya_pronounce",
] as const satisfies ReadonlyArray<keyof typeof TessayaToolkit.tools>;

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

/** What changes his house or what she keeps: never run for the replay harness's pretend R1. */
const REPLAY_WRITES: ReadonlySet<string> = new Set([
  "home_do",
  "home_undo",
  "home_automation_save",
  "home_automation_set",
  "tessaya_pronounce",
]);

/**
 * A replay turn's house change, answered as done without touching the house (13 Nov 01:29: a replay of "turn on the
 * office fan" flipped his real fan). Null when the call is not one.
 */
export const replayDryRun = (name: string, input: unknown, device?: string): ToolOutcome | null =>
  device?.startsWith("replay-") === true && REPLAY_WRITES.has(name)
    ? {
        text: `Done (a replay: nothing in the house was changed and nothing was kept). Asked: ${JSON.stringify(input).slice(0, 300)}`,
        isError: false,
        status: "done",
      }
    : null;

/** @public The room eval serves these too. */
export const ROOM_TOOL_SPECS: ReadonlyArray<RoomTool> = [
  ...ROOM_TOOLS.map((name) => {
    const tool: Tool.Any = TessayaToolkit.tools[name];
    return {
      name,
      description: Tool.getDescription(tool) ?? "",
      input_schema: advertisedJsonSchema(tool),
    };
  }),
  LAPTOP,
  VOLUME,
];

const decodeHome = Schema.decodeUnknownOption(BatonHomeCallResult);
const allowed = new Set<string>(ROOM_TOOLS);

/** A failure's own words when it has them, as the model should say them. */
const reasonOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "message" in value
    ? String(value.message)
    : "it did not work";

/**
 * The runner, built once: the toolkit's handlers with the room's caller and this environment. Null without the
 * server's services; found, not required, so the routes layer's type stays small (BatonServerLayer loses types).
 */
const makeRoomTools = Effect.gen(function* () {
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
  const run = Effect.fn("R1Tools.run")(function* (name: string, input: unknown, device?: string) {
    if (name === LAPTOP.name) {
      const question =
        typeof input === "object" && input !== null && "question" in input
          ? String(input.question)
          : "";
      const told = yield* askLaptop(question);
      return { text: told.line, isError: !told.ok, status: told.status } as ToolOutcome;
    }
    if (name === VOLUME.name) return yield* setRoomVolume(input, device);
    const dry = replayDryRun(name, input, device);
    if (dry !== null) return dry;
    if (!allowed.has(name))
      return { text: `${name} is not a tool here.`, isError: true } as ToolOutcome;
    const scope: McpInvocationScope = {
      environmentId,
      capabilities: new Set(["orchestration"]),
      issuedAt: yield* Clock.currentTimeMillis,
      requestNamespace: ROOM_CLIENT.sessionId,
      thread: undefined,
      client: ROOM_CLIENT,
      linkedEnvironments: false,
    };
    const last = yield* toolkit.handle(name as (typeof ROOM_TOOLS)[number], input as never).pipe(
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
  return { specs: ROOM_TOOL_SPECS, run };
});

/** The room's tools for R1Device's routes; built once with the server. */
export const layer = Layer.effect(RoomTools, makeRoomTools);
