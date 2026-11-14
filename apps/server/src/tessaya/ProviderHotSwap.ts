/**
 * A provider picked while a turn runs takes over at once, as the Director asked: the running turn stops as Stop
 * would, the thread moves to the new provider (which gets the thread's context through the usual hand-off), and the
 * work continues there with the same "Continue where you left off." a manual resume sends. Upstream refuses this
 * switch while a turn runs (OrchestratorProviderSelectionBusyError); ThreadManagementService hands that refusal here.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isActiveRun } from "../orchestration-v2/CommandPolicy.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

const HOT_SWAP_INTERRUPT_REASON = "Switched provider";
const HOT_SWAP_CONTINUE_TEXT = "Continue where you left off.";
// A provider that never acknowledges the stop leaves the switch refused, as upstream would.
const STOP_WAIT = Duration.seconds(30);

type SelectionCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.model-selection.set" | "provider.switch" }
>;

export const isSelectionCommand = <C extends { readonly type: string }>(
  command: C,
): command is Extract<C, SelectionCommand> =>
  command.type === "thread.model-selection.set" || command.type === "provider.switch";

const latestActive = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs.filter(isActiveRun).toSorted((left, right) => right.ordinal - left.ordinal)[0];

export const hotSwapProvider = Effect.fn("ProviderHotSwap.hotSwapProvider")(function* <
  C extends SelectionCommand,
  A,
  E,
  R,
>(
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  command: C,
  busy: Orchestrator.OrchestratorProviderSelectionBusyError,
  dispatch: (command: C) => Effect.Effect<A, E, R>,
) {
  const { runs } = yield* orchestrator.getThreadRecords(command.threadId, ["runs"]);
  const run = latestActive(runs);
  if (run === undefined) return yield* dispatch(command);
  const afterSequence = yield* orchestrator.getThreadEventSequence(command.threadId);
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    commandId: CommandId.make(`${command.commandId}:hot-swap:stop`),
    threadId: command.threadId,
    runId: run.id,
    reason: HOT_SWAP_INTERRUPT_REASON,
  });
  const after = yield* orchestrator.getThreadRecords(command.threadId, ["runs"]);
  if (after.runs.some((candidate) => candidate.id === run.id && isActiveRun(candidate))) {
    const stopped = yield* orchestrator
      .streamStoredEventsFrom({ threadId: command.threadId, afterSequence })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" && event.runId === run.id && !isActiveRun(event.payload),
        ),
        Stream.runHead,
        Effect.timeoutOption(STOP_WAIT),
      );
    if (stopped._tag === "None") return yield* busy;
  }
  // The first try's id is recorded as refused, so the switch goes again under its own id.
  const switched = yield* dispatch({
    ...command,
    commandId: CommandId.make(`${command.commandId}:hot-swap:switch`),
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`${command.commandId}:hot-swap:continue`),
    threadId: command.threadId,
    messageId: MessageId.make(`${command.commandId}:hot-swap:continue`),
    text: HOT_SWAP_CONTINUE_TEXT,
    attachments: [],
    modelSelection: command.modelSelection,
    ...(command.providerChangeApproved === true ? { providerChangeApproved: true } : {}),
    manualContinuationOfRunId: run.id,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return switched;
});
