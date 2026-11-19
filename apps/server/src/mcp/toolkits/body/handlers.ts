/** The body tools' handlers: each names its caller and calls one TessayaBody method. */
import * as Effect from "effect/Effect";

import { TessayaRuntime } from "../../../tessaya/TessayaRpcHandlers.ts";
import { bodyState, moveBody, playScene, type BodyCaller } from "../../../tessaya/TessayaBody.ts";
import {
  onPlayground,
  type Aim,
  movePlayground,
  scenePlayground,
  statePlayground,
} from "../../../tessaya/BodyPlayground.ts";
import { conversationKey, TurnOrigin } from "../../../tessaya/TessayaTurn.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

/** Her own turn on a vessel, an agent in T3, or an outside agent; private moves are for the first two only. */
const callerNow = Effect.gen(function* () {
  const turn = yield* TurnOrigin;
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (turn !== null)
    return {
      id: `${turn.kind}:${turn.id}`,
      kind: "persona",
      mayBePrivate: true,
      // her live thread (TessayaTurn's id), so body focus knows which of her conversations asks
      thread: `${turn.persona ?? ""}|${conversationKey({ vessel: turn, text: "", speaker: turn.speaker, member: turn.member })}`,
      signal: turn.kind === "device" ? "speak" : "type",
      ...(turn.persona == null ? {} : { persona: turn.persona }),
    } satisfies BodyCaller;
  if (scope.client === undefined)
    return {
      id: `thread:${scope.thread?.threadId ?? "t3"}`,
      kind: "agent",
      mayBePrivate: true,
      // his own agent moving her is his hand in that thread
      signal: "touch",
    } satisfies BodyCaller;
  return {
    id: `client:${scope.client.sessionId ?? "outside"}`,
    kind: "outside",
    mayBePrivate: false,
  } satisfies BodyCaller;
});

export const make = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  const inRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    context === null ? effect : effect.pipe(Effect.provideContext(context));
  return {
    tessaya_body_move: McpToolAccess.writes(({ target, playground, ...move }: Aim & object) =>
      Effect.flatMap(callerNow, (caller) =>
        inRuntime(
          onPlayground({ target, playground }, caller)
            ? movePlayground(move, caller, playground)
            : moveBody(move, caller),
        ),
      ),
    ),
    tessaya_body_scene: McpToolAccess.writes(
      (input: Aim & { readonly scene: unknown; readonly dryRun?: boolean }) =>
        Effect.flatMap(callerNow, (caller) =>
          inRuntime(
            onPlayground(input, caller)
              ? scenePlayground(input.scene, caller, input.dryRun === true, input.playground)
              : playScene(input.scene, caller, input.dryRun === true),
          ),
        ),
    ),
    tessaya_body_state: McpToolAccess.reads((input: Aim) =>
      Effect.flatMap(callerNow, (caller) =>
        onPlayground(input, caller)
          ? Effect.succeed(statePlayground(input.playground))
          : inRuntime(bodyState(caller)),
      ),
    ),
  };
});
