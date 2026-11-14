/**
 * Acts her server holds until it knows who is speaking (recognition.ts's step-up, server half). The room runner holds
 * an act and the vessel's loop is told (`voice/stepup`); she asks once and answers `voice/stepup/done`. The same act
 * also waits as a card on the phone inbox, so nothing is lost when the voice can't settle it. Its own service, so the
 * device broker and the tool runner need not import each other.
 */
import type { Assurance } from "@t3tools/tessaya-shared/household";
import { PROMPT_TTL_MS } from "@t3tools/tessaya-shared/phoneRelay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";

import { TessayaPhoneInbox } from "../tessaya/TessayaPhoneInbox.ts";

/** What raising the turn to `assurance`, as `member`, does: the act runs. */
export type HeldRun = (raised: {
  readonly member: string | null;
  readonly assurance: Assurance;
}) => Effect.Effect<void>;

export interface HeldAct {
  readonly device: string;
  /** Her words for it, on the card. */
  readonly what: string;
  readonly member: string | null;
  readonly needs: Assurance;
  /** Also a card on the phone inbox; never for a replay. */
  readonly phone: boolean;
  /**
   * An act that always waits for his yes on a card (judgeToolCall asks), not only for knowing who spoke: its card asks
   * for that yes, and only the card releases it, as `needs` (above what any voice gives).
   */
  readonly card?: boolean;
  readonly run: HeldRun;
}

/** The loop's answer (`voice/stepup/done`). */
export interface StepUpDone {
  readonly act: string;
  readonly ok: boolean;
  /** "voice" (their reply verified them), "session" (already verified), "button" (S2 on that R1), "no answer". */
  readonly how: string;
  readonly member: string | null;
}

/**
 * How sure a settled step-up makes the turn (ACCOUNTS-IDENTITY-DESIGN §3.1): a voice verified on the session is A2;
 * a press of the R1's own button is presence, A1, and only on the R1 that held the act. Nothing else raises it.
 */
const stepUpLevel = (done: StepUpDone, heldOn: string, from: string): Assurance => {
  if (!done.ok || heldOn !== from) return 0;
  if (done.how === "voice" || done.how === "session") return 2;
  return done.how === "button" ? 1 : 0;
};

/** A held act is let go when its card on the phone expires unanswered. */
const HELD_MS = PROMPT_TTL_MS;

export class StepUps extends Context.Service<
  StepUps,
  {
    /** Holds the act: the vessel is told and the phone gets a card; the act id comes back. */
    readonly hold: (act: HeldAct) => Effect.Effect<string>;
    /** The vessel's answer, from the device that sent it: whether the act ran. */
    readonly settle: (device: string, done: StepUpDone) => Effect.Effect<boolean>;
    /** The vessel's owner (the device broker) is told of each held act, to ask on that device. */
    readonly listen: (
      onHold: (device: string, act: string) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("t3/home/StepUps") {}

const make = Effect.gen(function* () {
  const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
  const held = new Map<string, HeldAct>();
  const listeners = new Set<(device: string, act: string) => Effect.Effect<void>>();

  /** Runs it once, whichever answer came first; later answers find nothing. */
  const release = Effect.fn("StepUps.release")(function* (
    id: string,
    raised: { readonly member: string | null; readonly assurance: Assurance },
  ) {
    const act = held.get(id);
    if (act === undefined) return;
    held.delete(id);
    if (Option.isSome(inbox)) yield* inbox.value.closePrompt(id);
    yield* act.run(raised);
  });

  const hold = Effect.fn("StepUps.hold")(function* (act: HeldAct) {
    const id = `stepup-${yield* Clock.currentTimeMillis}-${yield* Random.nextIntBetween(0, 1e6)}`;
    held.set(id, act);
    // A card act is not the voice's to settle, so the vessel is not asked who spoke.
    if (act.card !== true) for (const l of listeners) yield* l(act.device, id);
    if (Option.isSome(inbox) && act.phone) {
      const phone = inbox.value;
      yield* phone.mirror({
        id,
        ...(act.card === true
          ? {
              title: "Tessaya wants your yes",
              detail: `Asked on ${act.device}: ${act.what}.`,
              buttons: ["Yes, do it", "No"],
              // Only a phone that may approve answers it, as the house's owner asks are.
              needs: "cloud-approve" as const,
            }
          : {
              title: "Is this you?",
              detail: `Tessaya is holding this until she knows who asked: ${act.what}.`,
              buttons: ["Yes, it's me", "No"],
            }),
        yes: 0,
        cancel: 1,
      });
      // A yes on their own phone is their device at A2 (§3.1), and the yes a card act waited for; a no lets it go.
      yield* phone.promptAnswer(id).pipe(
        Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (a) => a !== null }),
        Effect.timeoutOption(`${HELD_MS} millis`),
        Effect.flatMap((answer) =>
          Option.isSome(answer) && answer.value === 0
            ? release(id, { member: act.member, assurance: act.card === true ? act.needs : 2 })
            : Effect.sync(() => void held.delete(id)),
        ),
        Effect.ignore,
        Effect.forkDetach,
      );
    } else {
      yield* Effect.sleep(`${HELD_MS} millis`).pipe(
        Effect.andThen(Effect.sync(() => void held.delete(id))),
        Effect.forkDetach,
      );
    }
    return id;
  });

  const settle = Effect.fn("StepUps.settle")(function* (device: string, done: StepUpDone) {
    const act = held.get(done.act);
    if (act === undefined) return false;
    const level = stepUpLevel(done, act.device, device);
    // Not enough (no, a button for an act that needs a voice): the card on the phone still decides it.
    if (level < act.needs) return false;
    yield* release(done.act, { member: done.member ?? act.member, assurance: level });
    return true;
  });

  return StepUps.of({
    hold,
    settle,
    listen: Effect.fn("StepUps.listen")(function* (
      onHold: (device: string, act: string) => Effect.Effect<void>,
    ) {
      yield* Effect.sync(() => listeners.add(onHold));
    }),
  });
});

export const layer = Layer.effect(StepUps, make);
