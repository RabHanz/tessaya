import { assert, it } from "@effect/vitest";
import type { PhonePrompt } from "@t3tools/baton-shared/phoneRelay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BatonPhoneInbox } from "../baton/BatonPhoneInbox.ts";
import { StepUps, layer } from "./StepUps.ts";

/** A phone that has already answered `answer` to every card, and keeps the cards it was shown. */
const phone = (answer: number | null, shown: Array<PhonePrompt>) =>
  Layer.succeed(BatonPhoneInbox, {
    mirror: (prompt: PhonePrompt) => Effect.sync(() => void shown.push(prompt)),
    promptAnswer: () => Effect.succeed(answer),
    closePrompt: () => Effect.void,
  } as unknown as BatonPhoneInbox["Service"]);

const holdCard = (answer: number | null, shown: Array<PhonePrompt>, told: Array<string>) =>
  Effect.gen(function* () {
    const ran = yield* Deferred.make<number>();
    const stepUps = yield* StepUps;
    yield* stepUps.listen((device) => Effect.sync(() => void told.push(device)));
    const act = yield* stepUps.hold({
      device: "r1-1",
      what: "job schedule",
      member: "owner",
      needs: 3,
      card: true,
      phone: true,
      run: (raised) => Deferred.succeed(ran, raised.assurance).pipe(Effect.asVoid),
    });
    return { act, ran, stepUps };
  }).pipe(Effect.provide(layer.pipe(Layer.provide(phone(answer, shown)))));

it.effect("a card act asks his phone for a yes, and no voice releases it", () =>
  Effect.gen(function* () {
    const shown: Array<PhonePrompt> = [];
    const told: Array<string> = [];
    const { act, stepUps } = yield* holdCard(null, shown, told);
    // His verified voice on the R1 that asked is A2: not the yes this act waits for.
    assert.isFalse(yield* stepUps.settle("r1-1", { act, ok: true, how: "voice", member: "owner" }));
    assert.deepStrictEqual(told, []);
    assert.strictEqual(shown[0]?.title, "Tessaya wants your yes");
    assert.strictEqual(shown[0]?.needs, "cloud-approve");
  }),
);

it.effect("his yes on the card runs the act, as sure as it waited for", () =>
  Effect.gen(function* () {
    const { ran } = yield* holdCard(0, [], []);
    assert.strictEqual(yield* Deferred.await(ran), 3);
  }),
);
