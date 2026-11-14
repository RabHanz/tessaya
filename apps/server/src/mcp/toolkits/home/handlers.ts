/**
 * The home tools' handlers: each decodes nothing more than its schema did, then goes through the one home door
 * (`serveHomeCall`) as "an agent", so the server's risk check and his yes apply exactly as they do everywhere else.
 */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import { DeviceRegistry } from "../../../home/DeviceRegistry.ts";
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
/**
 * His desktop's own Tessaya (R1Tools' desk runner, over the desktop app's own door): built only in-process, so no
 * token can claim it. Its acts go on surface "assistant", as its own tools always sent them.
 */
export const DESK_CLIENT: McpInvocationContext.McpClientCaller = {
  sessionId: "desktop-assistant",
  label: "his desktop's Tessaya",
  access: "approval-required",
};
/** The tool suite's pretend desktop: the same caller, and its acts are a dry run. */
export const DESK_REPLAY_CLIENT: McpInvocationContext.McpClientCaller = {
  ...DESK_CLIENT,
  sessionId: "desktop-replay",
};

/** A vessel's own Tessaya calling in-process: where its acts are shown, and whether they are a rehearsal. */
export const vesselOf = (
  client: McpInvocationContext.McpClientCaller | undefined,
): { readonly surface: "r1" | "assistant"; readonly dryRun: boolean } | null =>
  client === ROOM_CLIENT || client === ROOM_REPLAY_CLIENT
    ? { surface: "r1", dryRun: client === ROOM_REPLAY_CLIENT }
    : client === DESK_CLIENT || client === DESK_REPLAY_CLIENT
      ? { surface: "assistant", dryRun: client === DESK_REPLAY_CLIENT }
      : null;
const linked = { linkedCallers: "allowed" } as const;

/**
 * The list with its counts made here, so she says them rather than counting rows (.138's suite: "three are running"
 * for two, then "let me correct that" aloud). Running and paused are of the automations still in the house.
 */
export const withCounts = <T extends { readonly ok: boolean; readonly value?: unknown }>(
  result: T,
): T => {
  if (!result.ok || !Array.isArray(result.value)) return result;
  const rows = result.value as ReadonlyArray<{
    readonly status?: unknown;
    readonly paused?: unknown;
  }>;
  const live = rows.filter((r) => r.status === "active");
  const paused = live.filter((r) => r.paused === true).length;
  return {
    ...result,
    value: { running: live.length - paused, paused, total: live.length, automations: rows },
  };
};

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
    const vessel = vesselOf(scope.client);
    const by: HomeActor =
      vessel !== null
        ? { who: tessaya, surface: vessel.surface, ...(vessel.dryRun ? { dryRun: true } : {}) }
        : {
            who: scope.client === undefined ? "an agent in T3" : "an outside agent",
            surface: "agent",
          };
    return yield* serveHomeCall({ kind, op, args }, by).pipe(Effect.provideContext(context));
  });
  /** The room of the body the turn's vessel sits in ("kitchen dock" → kitchen), or null. */
  const vesselRoom = Effect.gen(function* () {
    const origin = yield* TurnOrigin;
    if (origin === null || context === null) return null;
    const registry = yield* Effect.serviceOption(DeviceRegistry).pipe(
      Effect.provideContext(context),
    );
    if (registry._tag === "None") return null;
    const room = yield* registry.value.value(origin.id, "body.room");
    return typeof room === "string" && room.trim() !== "" ? room : null;
  });
  return {
    // With no room named, the vessel's own body room comes first; the whole house if nothing matches there.
    home_find: McpToolAccess.reads((input: Args) =>
      Effect.gen(function* () {
        const room = input["area"] === undefined ? yield* vesselRoom : null;
        if (room !== null) {
          const near = yield* home("read", "find", { ...input, area: room });
          if (near.ok && Array.isArray(near.value) && near.value.length > 0) return near;
        }
        return yield* home("read", "find", { ...input });
      }),
    ),
    home_state: McpToolAccess.reads((input: Args) => home("read", "state", { ...input })),
    home_automations: McpToolAccess.reads((input: Args) =>
      Effect.map(home("read", "automations", { ...input }), withCounts),
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
