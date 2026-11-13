/**
 * The home tools' handlers: each decodes nothing more than its schema did, then goes through the one home door
 * (`serveHomeCall`) as "an agent", so the server's risk check and his yes apply exactly as they do everywhere else.
 */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import { serveHomeCall, type HomeCallKind } from "../../../home/HomeCalls.ts";
import type { HomeActor } from "../../../home/HomeAssistantService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const unavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "Home is not available on this server.",
});

type Args = Readonly<Record<string, unknown>>;

/**
 * The room device's own caller (R1Tools): built only in-process, so no token can claim it. Its house acts go as
 * Tessaya on surface "r1", where the gate never takes a yes: anyone in the room can talk to it.
 */
export const ROOM_CLIENT: McpInvocationContext.McpClientCaller = {
  sessionId: "r1-room",
  label: "the desk device in his home",
  access: "approval-required",
};
/** The tool suite's pretend R1 (`replay-…`): the same caller, and its house acts are a dry run. */
export const ROOM_REPLAY_CLIENT: McpInvocationContext.McpClientCaller = {
  ...ROOM_CLIENT,
  sessionId: "r1-replay",
};
const linked = { linkedCallers: "allowed" } as const;

/** Handler declarations for `HomeToolkit`, spread into Tessaya's toolkit layer. */
export const make = Effect.gen(function* () {
  const context = yield* BatonRuntime;
  const home = Effect.fn("HomeMcp.call")(function* (
    kind: HomeCallKind,
    op: string,
    args: Record<string, unknown>,
  ) {
    if (context === null) return yield* unavailable;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    // Approval cards name the vessel he said it to ("Tessaya via R1").
    const via = (yield* TurnOrigin)?.label;
    const tessaya = via === undefined ? "Tessaya" : `Tessaya via ${via}`;
    // An outside client's name, or the T3 thread asking; never a yes, which only his own gate gives.
    const by: HomeActor =
      scope.client === ROOM_CLIENT
        ? { who: tessaya, surface: "r1" }
        : scope.client === ROOM_REPLAY_CLIENT
          ? { who: tessaya, surface: "r1", dryRun: true }
          : {
              who: scope.client === undefined ? "an agent in T3" : "an outside agent",
              surface: "agent",
            };
    return yield* serveHomeCall({ kind, op, args }, by).pipe(Effect.provideContext(context));
  });
  return {
    home_find: McpToolAccess.reads((input: Args) => home("read", "find", { ...input })),
    home_state: McpToolAccess.reads((input: Args) => home("read", "state", { ...input })),
    home_automations: McpToolAccess.reads((input: Args) =>
      home("read", "automations", { ...input }),
    ),
    // His linked servers ask here for the house (HomeAssistantService.viaPeer); the risk check runs here either way.
    home_do: McpToolAccess.writes((input: Args) => home("act", "do", { ...input }), linked),
    home_undo: McpToolAccess.writes((input: Args) => home("act", "undo", { ...input }), linked),
    home_automation_save: McpToolAccess.writes(
      (input: Args) => home("act", "automationSave", { ...input }),
      linked,
    ),
    home_automation_set: McpToolAccess.writes(
      (input: Args) => home("act", "automationSet", { ...input }),
      linked,
    ),
  };
});
