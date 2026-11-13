/** The members tools' handlers: thin; TessayaHousehold decides, by who is speaking on this turn. */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { memberOfSpeaker, voiceAssurance } from "@t3tools/baton-shared/household";
import { BatonHouseholdCallInput } from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { HouseholdCaller, TessayaHousehold } from "../../../baton/TessayaHousehold.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const decodeInput = Schema.decodeUnknownOption(BatonHouseholdCallInput);
/** A linked server's caller counts at most this sure: its own desktop session is A3 there, never the root. */
const PEER_MAX_ASSURANCE = 3;

const unavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "Members are not available on this server.",
});

type Args = Readonly<Record<string, unknown>>;

export const make = Effect.gen(function* () {
  const context = yield* BatonRuntime;
  /** A spoken turn is its speaker at their voice's assurance; an agent outside a turn is a service acting for the owner. */
  const run = Effect.fn("MembersMcp.run")(function* (input: BatonHouseholdCallInput) {
    if (context === null) return yield* unavailable;
    const origin = yield* TurnOrigin;
    const caller =
      origin === null
        ? { member: "owner", service: true, assurance: 0 as const, via: "an agent" }
        : {
            member: origin.member ?? memberOfSpeaker(origin.speaker ?? null),
            assurance: origin.assurance ?? voiceAssurance(origin.speaker ?? null),
            tainted: origin.tainted === true,
            via: `Tessaya via ${origin.label}`,
          };
    return yield* Effect.flatMap(TessayaHousehold, (h) => h.call(input)).pipe(
      Effect.provideService(HouseholdCaller, caller),
      Effect.provideContext(context),
    );
  });
  const id = (input: Args) => String(input["id"] ?? "");
  return {
    members_list: McpToolAccess.reads(() => run({ op: "list" })),
    members_home: McpToolAccess.reads(() => run({ op: "home" })),
    member_invite: McpToolAccess.writes((input: Args) =>
      run({
        op: "invite",
        name: String(input["name"] ?? ""),
        role: input["role"] as "adult",
        ...(typeof input["born"] === "string" ? { born: input["born"] } : {}),
      }),
    ),
    member_set_role: McpToolAccess.writes((input: Args) =>
      run({ op: "setRole", id: id(input), role: input["role"] as "adult" }),
    ),
    member_remove: McpToolAccess.writes((input: Args) =>
      run({ op: "remove", id: id(input), ...(input["now"] === true ? { now: true } : {}) }),
    ),
    member_restore: McpToolAccess.writes((input: Args) => run({ op: "restore", id: id(input) })),
    household_home_server: McpToolAccess.writes((input: Args) =>
      run({ op: "setHome", on: typeof input["on"] === "string" ? input["on"] : null }),
    ),
    // Only another of this home's servers, over its link: the caller it carries is believed from a linked server alone.
    household_peer: McpToolAccess.writes(
      (input: Args) =>
        Effect.gen(function* () {
          if (context === null) return yield* unavailable;
          const client = (yield* McpInvocationContext.McpInvocationContext).client;
          if (client?.linked !== true)
            return { status: "refused", line: "Only another of this home's servers may ask this." };
          const request = decodeInput(input["input"]);
          if (Option.isNone(request))
            return { status: "refused", line: "That request is not valid." };
          const level = Number(input["assurance"]);
          return yield* Effect.flatMap(TessayaHousehold, (h) => h.callHere(request.value)).pipe(
            Effect.provideService(HouseholdCaller, {
              member: typeof input["member"] === "string" ? input["member"] : null,
              service: input["service"] === true,
              assurance: (Number.isInteger(level)
                ? Math.max(0, Math.min(level, PEER_MAX_ASSURANCE))
                : 0) as 0 | 1 | 2 | 3,
              tainted: input["tainted"] === true,
              via: `${String(input["via"] ?? "someone").slice(0, 80)} on ${client.label ?? "a linked server"}`,
            }),
            Effect.provideContext(context),
          );
        }),
      { linkedCallers: "allowed" },
    ),
  };
});
