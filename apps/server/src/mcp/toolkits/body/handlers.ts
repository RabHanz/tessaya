/** The body tools' handlers: each names its caller and calls one TessayaBody method. */
import * as Effect from "effect/Effect";

import { TessayaRuntime } from "../../../tessaya/TessayaRpcHandlers.ts";
import { bodyState, moveBody, type BodyCaller } from "../../../tessaya/TessayaBody.ts";
import { TurnOrigin } from "../../../tessaya/TessayaTurn.ts";
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
    } satisfies BodyCaller;
  if (scope.client === undefined)
    return {
      id: `thread:${scope.thread?.threadId ?? "t3"}`,
      kind: "agent",
      mayBePrivate: true,
    } satisfies BodyCaller;
  return {
    id: `client:${scope.client.sessionId ?? "outside"}`,
    kind: "outside",
    mayBePrivate: false,
  } satisfies BodyCaller;
});

export const make = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  return {
    tessaya_body_move: McpToolAccess.writes((input: unknown) =>
      Effect.flatMap(callerNow, (caller) =>
        context === null
          ? moveBody(input, caller)
          : moveBody(input, caller).pipe(Effect.provideContext(context)),
      ),
    ),
    tessaya_body_state: McpToolAccess.reads(() =>
      Effect.flatMap(callerNow, (caller) =>
        context === null
          ? bodyState(caller)
          : bodyState(caller).pipe(Effect.provideContext(context)),
      ),
    ),
  };
});
