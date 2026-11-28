/** The Margin's handlers: thin; TessayaMargin reads and writes, as the turn's member (the owner, for an agent). */
import { memberOfSpeaker, OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TessayaRuntime } from "../../../tessaya/TessayaRpcHandlers.ts";
import { TessayaMargin, type MarginActor } from "../../../tessaya/TessayaMargin.ts";
import { TurnOrigin } from "../../../tessaya/TessayaTurn.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const unavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "The Margin is not available on this server.",
});

const actorNow = Effect.gen(function* () {
  const origin = yield* TurnOrigin;
  // An agent outside a turn acts for the owner, as the comms tools do.
  return (
    origin === null
      ? { member: OWNER_MEMBER_ID, via: "an agent", rehearsal: false }
      : {
          // As roomRefusal reads it: a turn that names no member and heard no voice is his own (his desktop).
          member:
            origin.member !== undefined
              ? origin.member
              : origin.speaker != null
                ? memberOfSpeaker(origin.speaker)
                : OWNER_MEMBER_ID,
          via: origin.label,
          rehearsal: origin.rehearsal === true,
        }
  ) satisfies MarginActor;
});

type Input = { readonly tool: string; readonly args?: Readonly<Record<string, unknown>> };

export const make = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  const run = Effect.fn("MarginMcp.run")(function* (input: Input & { readonly reason?: string }) {
    if (context === null) return yield* unavailable;
    const actor = yield* actorNow;
    const args = input.args ?? {};
    return yield* Effect.flatMap(TessayaMargin, (m) =>
      input.reason === undefined
        ? m.read(actor, input.tool, args)
        : m.write(actor, input.tool, args, input.reason),
    ).pipe(Effect.provideContext(context));
  });
  return {
    margin_read: McpToolAccess.reads((input: Input) => run(input)),
    margin_write: McpToolAccess.writes((input: Input & { readonly reason: string }) => run(input)),
  };
});
