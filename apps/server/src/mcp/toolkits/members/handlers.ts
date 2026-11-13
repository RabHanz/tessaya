/** The members tools' handlers: thin; TessayaHousehold decides, by who is speaking on this turn. */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { memberOfSpeaker, voiceAssurance } from "@t3tools/baton-shared/household";
import type { BatonHouseholdCallInput } from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";

import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { HouseholdCaller, TessayaHousehold } from "../../../baton/TessayaHousehold.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

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
  };
});
