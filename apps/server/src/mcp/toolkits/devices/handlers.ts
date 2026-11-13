/**
 * The device tools' handlers: each goes through the one devices door (`serveDevicesCall`) as "an agent", so the
 * camera and a restart wait for his yes on the phone exactly as they do from his desktop assistant.
 */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import { serveDevicesCall, type DevicesCallKind } from "../../../home/HomeDeviceCalls.ts";
import type { DeviceActor } from "../../../home/HomeDevices.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { vesselOf } from "../home/handlers.ts";

const unavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "Devices are not available on this server.",
});

type Args = Readonly<Record<string, unknown>>;

/** Handler declarations for `DeviceTools`, spread into Tessaya's toolkit layer. */
export const make = Effect.gen(function* () {
  const context = yield* BatonRuntime;
  const devices = Effect.fn("DevicesMcp.call")(function* (
    kind: DevicesCallKind,
    op: string,
    args: Record<string, unknown>,
  ) {
    if (context === null) return yield* unavailable;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const via = (yield* TurnOrigin)?.label;
    // A vessel's own Tessaya acts as his assistant does: harmless controls at once, the camera and a restart on his yes.
    const by: DeviceActor =
      vesselOf(scope.client) !== null
        ? { who: via === undefined ? "Tessaya" : `Tessaya via ${via}`, surface: "assistant" }
        : {
            who: scope.client === undefined ? "an agent in T3" : "an outside agent",
            surface: "agent",
          };
    return yield* serveDevicesCall({ kind, op, args }, by).pipe(Effect.provideContext(context));
  });
  const split = ({ op, ...rest }: Args) => [String(op), { ...rest }] as const;
  return {
    device_list: McpToolAccess.reads(() => devices("read", "list", {})),
    device_act: McpToolAccess.writes((input: Args) => devices("act", ...split(input))),
    device_owner: McpToolAccess.writes((input: Args) => devices("owner", ...split(input))),
    device_tag: McpToolAccess.writes((input: Args) => {
      const [op, args] = split(input);
      return devices("act", op === "assign" ? "nfcAssign" : "nfcRemove", args);
    }),
  };
});
