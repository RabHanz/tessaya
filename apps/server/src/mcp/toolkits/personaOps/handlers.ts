/** The ops tools' handlers: thin; PersonaOps acts, as the turn's persona and with what the turn proves of him. */
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { TessayaRuntime } from "../../../tessaya/TessayaRpcHandlers.ts";
import { TurnOrigin } from "../../../tessaya/TessayaTurn.ts";
import {
  PersonaOps,
  type PersonaOpsAct,
  type PersonaOpsActor,
} from "../../../tessaya/PersonaOps.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const unavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "The ops system is not available on this server.",
});

const actorNow = Effect.gen(function* () {
  const origin = yield* TurnOrigin;
  return {
    actor: {
      persona: origin?.persona ?? null,
      hisVoice: origin?.hisVoice === true,
      score: origin?.speaker?.confidence ?? null,
      tainted: origin?.tainted === true,
      via: origin?.label ?? "an agent",
    } satisfies PersonaOpsActor,
    rehearsal: origin?.rehearsal === true,
    owner:
      origin !== null &&
      (origin.member ?? null) === OWNER_MEMBER_ID &&
      (origin.assurance ?? 0) >= 2 &&
      origin.tainted !== true,
  };
});

export const make = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  const act = Effect.fn("PersonaOpsMcp.act")(function* (input: PersonaOpsAct) {
    if (context === null) return yield* unavailable;
    const { actor, rehearsal } = yield* actorNow;
    if (rehearsal && input.op !== "status")
      return { status: "ok", line: "Done (a replay: nothing reached the ops system)." };
    return yield* Effect.flatMap(PersonaOps, (v) => v.act(actor, input)).pipe(
      Effect.provideContext(context),
    );
  });
  return {
    ops_warmups: McpToolAccess.reads(
      (input: { readonly deviceSerial?: string; readonly platform?: string }) =>
        act({ op: "status", ...input }),
    ),
    ops_warmup_set: McpToolAccess.writes(
      (input: Omit<Extract<PersonaOpsAct, { op: "schedule" }>, "op">) =>
        act({ op: "schedule", ...input }),
    ),
    ops_warmup_run: McpToolAccess.writes(
      (input: { readonly deviceSerial: string; readonly platform: string }) =>
        act({ op: "run", ...input }),
    ),
    ops_post: McpToolAccess.writes((input: Omit<Extract<PersonaOpsAct, { op: "post" }>, "op">) =>
      act({ op: "post", ...input }),
    ),
    ops_decide: McpToolAccess.writes(
      (input: Omit<Extract<PersonaOpsAct, { op: "answer" }>, "op">) =>
        act({ op: "answer", ...input }),
    ),
    ops_access: McpToolAccess.writes(
      (input: { readonly op: "list" | "revoke"; readonly persona?: string }) =>
        Effect.gen(function* () {
          if (context === null) return yield* unavailable;
          const { owner, rehearsal } = yield* actorNow;
          if (input.op === "revoke" && !owner)
            return { ok: false, line: "Only he can take a persona's ops access away." };
          if (input.op === "revoke" && rehearsal)
            return { ok: true, line: "Done (a replay: nothing changed)." };
          const vos = Context.get(context, PersonaOps);
          if (input.op === "list") return yield* vos.view;
          return yield* vos.revoke(input.persona ?? "");
        }),
    ),
  };
});
