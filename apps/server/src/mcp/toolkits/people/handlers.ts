/** The people tools' handlers: thin; TessayaHousehold's people ops decide, by who is speaking on which vessel. */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { memberOfSpeaker, voiceAssurance } from "@t3tools/tessaya-shared/household";
import type { TessayaHouseholdCallInput } from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";

import { TessayaRuntime } from "../../../tessaya/TessayaRpcHandlers.ts";
import { HouseholdCaller, TessayaHousehold } from "../../../tessaya/TessayaHousehold.ts";
import { TurnOrigin } from "../../../tessaya/TessayaTurn.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const unavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "People are not available on this server.",
});

type Args = Readonly<Record<string, unknown>>;
const text = (input: Args, key: string) =>
  typeof input[key] === "string" && input[key] !== "" ? { [key]: input[key] } : {};

export const make = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  /** As the members tools: a spoken turn is its speaker at their voice's assurance, on the vessel that heard it. */
  const run = Effect.fn("PeopleMcp.run")(function* (
    build: (vessel: string | undefined) => TessayaHouseholdCallInput,
  ) {
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
    return yield* Effect.flatMap(TessayaHousehold, (h) => h.call(build(origin?.id))).pipe(
      Effect.provideService(HouseholdCaller, caller),
      Effect.provideContext(context),
    );
  });
  return {
    people_who: McpToolAccess.reads((input: Args) =>
      run((vessel) => ({
        op: "peopleWho",
        ...text(input, "name"),
        ...text(input, "event"),
        ...text(input, "day"),
        ...(vessel === undefined ? {} : { vessel }),
      })),
    ),
    people_introduce: McpToolAccess.writes((input: Args) =>
      run((vessel) => ({
        op: "peopleIntroduce",
        vessel: vessel ?? "",
        name: String(input["name"] ?? "").trim() || "?",
      })),
    ),
    people_forget_me: McpToolAccess.writes((input: Args) =>
      run((vessel) => ({
        op: "peopleForgetMe",
        vessel: vessel ?? "",
        ...(input["confirmed"] === true ? { confirmed: true } : {}),
      })),
    ),
    people_list: McpToolAccess.reads(() => run(() => ({ op: "peopleList" }))),
    people_manage: McpToolAccess.writes((input: Args) =>
      run((vessel) => ({
        op: "peopleManage",
        action: input["action"] as "name",
        ...text(input, "id"),
        ...text(input, "into"),
        ...text(input, "name"),
        ...text(input, "relation"),
        ...text(input, "member"),
        ...(typeof input["appearance"] === "string" ? { appearance: input["appearance"] } : {}),
        ...(input["status"] === "member" || input["status"] === "guest"
          ? { status: input["status"] }
          : {}),
        ...(typeof input["on"] === "boolean" ? { on: input["on"] } : {}),
        ...(typeof input["days"] === "number" ? { days: input["days"] } : {}),
        ...(input["confirmed"] === true ? { confirmed: true } : {}),
        ...(vessel === undefined ? {} : { vessel }),
      })),
    ),
  };
});
