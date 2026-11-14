/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
/**
 * One-field send to any Herdr pane the fleet shows (D68).
 *
 * Goes through the adopted-session path rather than around it: the pane must
 * be in a fresh discovery (so a stale ref cannot type into whatever now holds
 * that id), it is registered with Herdr's declared capabilities, and the
 * capability gate decides. No account is involved anywhere: Herdr owns the
 * pane, so a credential swap underneath the agent leaves this path unchanged.
 */
import {
  AdoptedSessionId,
  type TessayaHerdrSendInput,
  type TessayaHerdrSendResult,
} from "@t3tools/tessaya-contracts";
import { HERDR_CAPABILITIES } from "@t3tools/tessaya-shared/adoptedSession";
import * as Effect from "effect/Effect";

import type { AdoptedSessionService } from "./AdoptedSessionService.ts";

export const herdrSend = (
  adopted: AdoptedSessionService["Service"],
  input: TessayaHerdrSendInput,
): Effect.Effect<TessayaHerdrSendResult> =>
  Effect.gen(function* () {
    const found = yield* adopted.discover;
    const candidate = found.candidates.find((entry) => entry.location.pane === input.pane);
    if (candidate === undefined) {
      return {
        delivered: false,
        detail: found.available
          ? `No Herdr pane ${input.pane} is running here now.`
          : `Herdr is not available here: ${found.reason}`,
      };
    }
    const session = yield* adopted.register({
      id: AdoptedSessionId.make(`herdr:${input.pane}`),
      runtime: "herdr",
      label: candidate.label,
      location: candidate.location,
      agentKind: candidate.agentKind,
      runtimeState: candidate.runtimeState,
      foreground: candidate.foreground ?? null,
      capabilities: HERDR_CAPABILITIES,
    });
    return yield* adopted.sendInput({
      id: session.id,
      text: input.text,
      submit: input.submit ?? true,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ delivered: false, detail: `Not sent: ${String(cause)}`.slice(0, 500) }),
    ),
  );
