/** The comms tools' handlers: thin; TessayaComms decides, as the turn's speaker (or the owner, for an agent). */
import { CommsCallInput } from "@t3tools/baton-contracts";
import { memberOfSpeaker, voiceAssurance } from "@t3tools/baton-shared/household";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { TessayaComms } from "../../../baton/TessayaComms.ts";
import { HouseholdCaller } from "../../../baton/TessayaHousehold.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const unavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "Messages are not available on this server.",
});
const decode = Schema.decodeUnknownOption(CommsCallInput);
type Args = Readonly<Record<string, unknown>>;

export const make = Effect.gen(function* () {
  const context = yield* BatonRuntime;
  const run = Effect.fn("CommsMcp.run")(function* (raw: unknown) {
    if (context === null) return yield* unavailable;
    const input = decode(raw);
    if (Option.isNone(input)) return { status: "refused", line: "That request is not valid." };
    const origin = yield* TurnOrigin;
    // An agent outside a turn acts for the owner as a service, at A0: it never reads a private note.
    const caller =
      origin === null
        ? { member: "owner", service: true, assurance: 0 as const, via: "an agent" }
        : {
            member: origin.member ?? memberOfSpeaker(origin.speaker ?? null),
            assurance: origin.assurance ?? voiceAssurance(origin.speaker ?? null),
            tainted: origin.tainted === true,
            via: `Tessaya via ${origin.label}`,
          };
    return yield* Effect.flatMap(TessayaComms, (c) => c.call(input.value)).pipe(
      Effect.provideService(HouseholdCaller, caller),
      Effect.provideContext(context),
    );
  });
  const pick = (input: Args, keys: ReadonlyArray<string>) =>
    Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  return {
    comms_send: McpToolAccess.writes((input: Args) =>
      run({
        op: "send",
        ...pick(input, ["to", "kind", "text", "forms", "urgency", "private", "replyTo"]),
      }),
    ),
    comms_inbox: McpToolAccess.reads((input: Args) =>
      run({ op: "inbox", ...pick(input, ["unreadOnly"]) }),
    ),
    comms_play: McpToolAccess.writes((input: Args) => run({ op: "play", noteId: input["id"] })),
    comms_react: McpToolAccess.writes((input: Args) =>
      run({ op: "react", noteId: input["id"], emoji: input["emoji"] }),
    ),
    comms_emergency: McpToolAccess.writes((input: Args) =>
      typeof input["kind"] === "string" && input["kind"] !== ""
        ? run({ op: "emergency", kind: input["kind"] })
        : run({ op: "emergencyKinds" }),
    ),
    comms_emergency_ok: McpToolAccess.writes(() => run({ op: "emergencyAck" })),
    comms_false_alarm: McpToolAccess.writes(() => run({ op: "emergencyCancel" })),
    comms_dnd: McpToolAccess.writes((input: Args) => {
      // The model gives a local time with its offset; the service keeps it as UTC ISO.
      const at = typeof input["until"] === "string" ? Date.parse(input["until"]) : Number.NaN;
      return run({
        op: "dnd",
        until: Number.isFinite(at) ? DateTime.formatIso(DateTime.makeUnsafe(at)) : null,
      });
    }),
  };
});
