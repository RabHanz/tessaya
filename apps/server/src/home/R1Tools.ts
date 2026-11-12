// @effect-diagnostics globalJsonInEffect:off
/**
 * The room's tools: the same /mcp tools his agents get (the house, his team and work, asks for his yes), called
 * in-process through their own handlers as `ROOM_CLIENT`, so McpToolAccess and the house's gate apply as on /mcp. Plus
 * laptop_ask, which asks his laptop's Tessaya. No file, shell or screen tools: the room only reads and asks.
 */
import { BatonHomeCallResult } from "@t3tools/baton-contracts";
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
  const run = Effect.fn("R1Tools.run")(function* (name: string, input: unknown) {
    if (name === LAPTOP.name) {
      const question =
        typeof input === "object" && input !== null && "question" in input
          ? String(input.question)
          : "";
      const told = yield* askLaptop(question);
      return { text: told.line, isError: !told.ok, status: told.status } as ToolOutcome;
    }
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
