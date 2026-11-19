/** The body tools' handlers: each names its caller and calls one TessayaBody method. */
import * as Effect from "effect/Effect";

import { TessayaRuntime } from "../../../tessaya/TessayaRpcHandlers.ts";
import {
  bodyState,
  moveBody,
  playScene,
  type BodyCaller,
  type BodyMoveAnswer,
} from "../../../tessaya/TessayaBody.ts";
import {
  bodyOnlyHerRefusal,
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

const bodyOnlyNow = Effect.map(
  McpInvocationContext.McpInvocationContext,
  (scope) => scope.client?.access === "body-only",
);
/** Her own body for a body-only agent only with his setting; anyone else as before. */
const herRefusal = Effect.flatMap(bodyOnlyNow, bodyOnlyHerRefusal);
type Asked = McpInvocationContext.McpInvocationContext;

type StateAnswer = {
  readonly open: boolean;
  readonly playground?: string;
  readonly body: unknown;
  readonly capabilities: unknown;
};
type SceneAnswer = {
  readonly ok: boolean;
  readonly said: string;
  readonly route?: string;
  readonly errors?: unknown;
  readonly corrected?: unknown;
  readonly notes?: unknown;
};

export const make = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  const inRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    context === null ? effect : effect.pipe(Effect.provideContext(context));
  const move = (
    input: Aim & object,
    caller: BodyCaller,
  ): Effect.Effect<BodyMoveAnswer, never, Asked> => {
    const { target: _target, playground, ...rest } = input;
    return onPlayground(input, caller)
      ? movePlayground(rest, caller, playground)
      : Effect.flatMap(herRefusal, (said): Effect.Effect<BodyMoveAnswer> =>
          said === null
            ? moveBody(rest, caller)
            : Effect.succeed({ ok: false, route: "none", said }),
        );
  };
  const scene = (
    input: Aim & { readonly scene: unknown; readonly dryRun?: boolean },
    caller: BodyCaller,
  ): Effect.Effect<SceneAnswer, never, Asked> =>
    onPlayground(input, caller)
      ? scenePlayground(input.scene, caller, input.dryRun === true, input.playground)
      : Effect.flatMap(herRefusal, (said): Effect.Effect<SceneAnswer> =>
          said === null || input.dryRun === true
            ? playScene(input.scene, caller, input.dryRun === true)
            : Effect.succeed({ ok: false, said, route: "none" }),
        );
  const state = (input: Aim, caller: BodyCaller): Effect.Effect<StateAnswer, never, Asked> =>
    onPlayground(input, caller)
      ? Effect.succeed(statePlayground(input.playground))
      : Effect.flatMap(herRefusal, (said): Effect.Effect<StateAnswer> =>
          said === null
            ? bodyState(caller)
            : Effect.succeed({ open: false, body: null, capabilities: null }),
        );
  return {
    tessaya_body_move: McpToolAccess.bodyWrites((input: Aim & object) =>
      Effect.flatMap(callerNow, (caller) => inRuntime(move(input, caller))),
    ),
    tessaya_body_scene: McpToolAccess.bodyWrites(
      (input: Aim & { readonly scene: unknown; readonly dryRun?: boolean }) =>
        Effect.flatMap(callerNow, (caller) => inRuntime(scene(input, caller))),
    ),
    tessaya_body_state: McpToolAccess.reads((input: Aim) =>
      Effect.flatMap(callerNow, (caller) => inRuntime(state(input, caller))),
    ),
  };
});
