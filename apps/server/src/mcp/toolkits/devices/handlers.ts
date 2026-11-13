/**
 * The device tools' handlers: each goes through the one devices door (`serveDevicesCall`) as "an agent", so the
 * camera and a restart wait for his yes on the phone exactly as they do from his desktop assistant.
 */
import type { BatonDevicesCallResult } from "@t3tools/baton-contracts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import { serveDevicesCall, type DevicesCallKind } from "../../../home/HomeDeviceCalls.ts";
import type { DeviceActor } from "../../../home/HomeDevices.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { vesselOf } from "../home/handlers.ts";
import { asForwarded, fromPeers, onPeer } from "../../../peer/PeerVessels.ts";

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
    const turn = yield* TurnOrigin;
    const via = turn?.label;
    const vessel = vesselOf(scope.client);
    // A vessel's own Tessaya acts as his assistant does: harmless controls at once, an owner item on his verified
    // voice or his yes on the phone. The suite's pretend vessel sends nothing to a device.
    const by: DeviceActor =
      vessel !== null
        ? {
            who: via === undefined ? "Tessaya" : `Tessaya via ${via}`,
            surface: "assistant",
            ...(turn?.hisVoice === true ? { approved: true } : {}),
            ...(vessel.dryRun ? { dryRun: true } : {}),
          }
        : {
            who: scope.client === undefined ? "an agent in T3" : "an outside agent",
            surface: "agent",
          };
    return yield* serveDevicesCall({ kind, op, args }, by).pipe(Effect.provideContext(context));
  });
  const split = ({ op, on: _on, origin: _origin, hisVoice: _voice, ...rest }: Args) =>
    [String(op), { ...rest }] as const;
  /** A device `on` another of his servers is driven there, as that server's own Tessaya would. */
  const routed = <A, E, R>(tool: string, input: Args, here: Effect.Effect<A, E, R>) =>
    asForwarded(
      input,
      Effect.gen(function* () {
        const on = typeof input["on"] === "string" ? input["on"] : undefined;
        const there =
          on === undefined ? null : yield* onPeer(tool, input, { on, takes: () => true });
        if (there === null) return yield* here;
        const answer = there.value as BatonDevicesCallResult;
        return { ...answer, value: { on: there.on, ...(answer.value as object | undefined) } };
      }),
    );
  // His other servers may drive a device here for a turn they heard; the camera and a restart still ask his phone.
  const linked = { linkedCallers: "allowed" } as const;
  return {
    device_list: McpToolAccess.reads((input: Args) =>
      asForwarded(
        input,
        Effect.gen(function* () {
          const here = yield* devices("read", "list", {});
          const elsewhere = yield* fromPeers("device_list", {});
          if (elsewhere.length === 0) return here;
          return {
            ...here,
            value: {
              here: here.value,
              elsewhere: elsewhere.map(({ on, value }) => ({
                on,
                devices: (value as BatonDevicesCallResult).value,
              })),
            },
          };
        }),
      ),
    ),
    device_act: McpToolAccess.writes(
      (input: Args) => routed("device_act", input, devices("act", ...split(input))),
      linked,
    ),
    device_owner: McpToolAccess.writes(
      (input: Args) => routed("device_owner", input, devices("owner", ...split(input))),
      linked,
    ),
    device_read: McpToolAccess.reads((input: Args) =>
      routed("device_read", input, devices("read", "read", split({ ...input, op: "read" })[1])),
    ),
    device_watch: McpToolAccess.writes(
      (input: Args) =>
        routed("device_watch", input, devices("act", "watch", split({ ...input, op: "watch" })[1])),
      linked,
    ),
    device_set: McpToolAccess.writes(
      (input: Args) =>
        routed("device_set", input, devices("act", "set", split({ ...input, op: "set" })[1])),
      linked,
    ),
    device_tag: McpToolAccess.writes((input: Args) => {
      const [op, args] = split(input);
      return routed(
        "device_tag",
        input,
        devices("act", op === "assign" ? "nfcAssign" : "nfcRemove", args),
      );
    }, linked),
  };
});
