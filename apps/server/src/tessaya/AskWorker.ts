/**
 * Asks from his phone page, the web bar, an agent's tessaya_ask and the R1's laptop_ask, answered by the one brain on
 * this server (SPINE-UNIFY S6), with the desktop's hands when it is listening. On only while `brain.asks` is set (the
 * desktop's one-brain setting sets it); otherwise the desktop takes them, as before.
 */
import type { PhoneAsk } from "@t3tools/tessaya-shared/phoneRelay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { RoomToolSet } from "../home/R1Brain.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { deskTurnStream } from "./DeskTurn.ts";
import type { VesselKind } from "./TessayaTurn.ts";
import { VesselHands } from "./VesselHands.ts";

/** Who carried an ask: his own phone or the web bar, an agent (an `mcp-` id), or a device that names itself. */
export const askVessel = (
  ask: Pick<PhoneAsk, "id" | "source" | "origin">,
): { readonly kind: VesselKind; readonly origin: string; readonly tainted: boolean } =>
  ask.id.startsWith("mcp-")
    ? // An agent's words are outside content: what the turn learns waits for his yes.
      { kind: "mcp", origin: "an agent", tainted: true }
    : ask.source === "phone"
      ? { kind: "phone", origin: ask.origin ?? "phone", tainted: false }
      : { kind: "device", origin: ask.origin ?? "a device", tainted: false };

/** One ask, answered: her words go back for the phone, the web bar or the agent to read. */
export const answerAsk = Effect.fn("AskWorker.answer")(function* (
  ask: PhoneAsk,
  tools: RoomToolSet,
) {
  const inbox = yield* TessayaPhoneInbox;
  const hands = yield* Effect.serviceOption(VesselHands);
  const said = yield* deskTurnStream(
    {
      text: ask.text,
      // His verified voice on the device that heard him: his own words, as the R1 took them.
      speaker: ask.hisVoice
        ? { kind: "owner", personId: "owner", verified: true, inherited: false }
        : null,
    },
    tools,
    false,
    Option.getOrNull(hands),
    askVessel(ask),
  ).pipe(
    Stream.runCollect,
    Effect.map((words) => [...words].join("").trim()),
  );
  if (said === "") return yield* inbox.fail(ask.id, "The brain did not answer.");
  return yield* inbox.answer(ask.id, said, said);
});

/** Takes asks while the setting is on; one at a time, each kept alive while it runs. */
export const runAskWorker = (tools: RoomToolSet) => askOnce(tools).pipe(Effect.forever);

const askOnce = Effect.fn("AskWorker.once")(function* (tools: RoomToolSet) {
  const inbox = yield* TessayaPhoneInbox;
  if (!(yield* inbox.brainAnswers)) return yield* Effect.sleep("5 seconds");
  yield* inbox.waitForAsk(15_000);
  // The setting may have gone off while it waited: the desktop takes the ask then.
  if (!(yield* inbox.brainAnswers)) return;
  const ask = yield* inbox.take;
  if (ask === null) return;
  // Its lease moves on while she works, so a long answer is never taken twice.
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* inbox
        .renew(ask.id)
        .pipe(Effect.delay("15 seconds"), Effect.forever, Effect.forkScoped);
      yield* answerAsk(ask, tools).pipe(
        Effect.catchCause(() => inbox.fail(ask.id, "Something went wrong on my side.")),
      );
    }),
  );
});
