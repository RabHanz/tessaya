import type { SpeakerLike } from "@t3tools/baton-shared/privateMemory";
import type { LearnInput } from "@t3tools/baton-shared/memoryLearning";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonMemoryLearning } from "./BatonMemoryLearning.ts";
import { BatonMemoryService, layer as memoryLayer } from "./BatonMemoryService.ts";
import { BatonPrivateMemoryService } from "./BatonPrivateMemoryService.ts";
import { TessayaTurn, layer as turnLayer, type TurnEnvelope } from "./TessayaTurn.ts";

const learned: Array<LearnInput> = [];
const recalledFor: Array<SpeakerLike | null> = [];
const setup = () => {
  learned.length = 0;
  recalledFor.length = 0;
};

const learning = Layer.mock(BatonMemoryLearning)({
  learn: (input) =>
    Effect.sync(() => {
      learned.push(input);
      return { stored: 1, held: 0 };
    }),
});
const stores = Layer.mock(BatonPrivateMemoryService)({
  recall: (input) =>
    Effect.sync(() => {
      recalledFor.push(input.turn.speaker);
      return { block: "private memories (yours): he prays at dawn", count: 1, whose: "yours" };
    }),
});

const layer = it.layer(
  turnLayer.pipe(
    Layer.provideMerge(memoryLayer),
    Layer.provideMerge(learning),
    Layer.provideMerge(stores),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const owner = (speaker: Partial<SpeakerLike> = {}): SpeakerLike => ({
  kind: "owner",
  personId: "owner",
  verified: true,
  inherited: false,
  ...speaker,
});
const device: TurnEnvelope["vessel"] = { kind: "device", id: "desk-1" };
const desktop: TurnEnvelope["vessel"] = { kind: "desktop", id: "laptop" };

layer("TessayaTurn", (it) => {
  it.effect("every vessel gets the same memory for the same words and persona", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const turn = yield* TessayaTurn;
      // A preference is standing memory; the facts are found by what is said.
      yield* memory.add({ kind: "preference", text: "He takes his coffee black", source: "user" });
      for (const text of [
        "The plumber is coming on Thursday at nine",
        "Bin day is Tuesday morning",
      ])
        yield* memory.add({ kind: "fact", text, source: "user" });
      const said = "when is the plumber coming, and how do I take my coffee";
      const viaDesktop = yield* turn.begin({ vessel: desktop, text: said });
      // A device has no session holding standing memory, so it also carries the standing block.
      const viaDevice = yield* turn.begin({ vessel: device, text: said, sessionless: true });
      assert.deepStrictEqual(viaDevice.ids, viaDesktop.ids);
      assert.deepStrictEqual(viaDesktop.ids, (yield* memory.recall({ text: said })).ids);
      assert.isAbove(viaDesktop.ids.length, 0);
      // Standing and the sentence both hold the coffee: the device's block says it once.
      assert.lengthOf(viaDevice.block.split("coffee black"), 2);
      assert.include(viaDesktop.block, "coffee black");
    }),
  );

  it.effect("reads private memories only when this turn's own voice was verified as his", () =>
    Effect.gen(function* () {
      setup();
      const turn = yield* TessayaTurn;
      const read = (speaker: SpeakerLike | null, tainted = false) =>
        Effect.map(
          turn.begin({ vessel: device, text: "when do I pray", speaker, tainted }),
          (c) => c.privateBlock,
        );
      for (const speaker of [
        null,
        owner({ verified: false }),
        owner({ inherited: true }),
        owner({ kind: "guest", personId: null }),
        owner({ kind: "saved", personId: "p1" }),
      ])
        assert.strictEqual(yield* read(speaker), "");
      assert.strictEqual(yield* read(owner(), true), "");
      assert.lengthOf(recalledFor, 0);
      assert.include(yield* read(owner()), "he prays at dawn");
      assert.lengthOf(recalledFor, 1);
    }),
  );

  it.effect("learns only from a turn said to her, by him, that was not a rehearsal", () =>
    Effect.gen(function* () {
      setup();
      const turn = yield* TessayaTurn;
      const end = (envelope: Partial<TurnEnvelope>) =>
        Effect.map(
          turn.end(
            { vessel: device, text: "remember the boiler code is in the drawer", ...envelope },
            { reply: "Noted." },
          ),
          (r) => r.learned,
        );
      assert.isFalse(yield* end({ addressed: false }));
      assert.isFalse(yield* end({ rehearsal: true }));
      assert.isFalse(yield* end({ speaker: owner({ kind: "guest", personId: null }) }));
      assert.isFalse(yield* end({ speaker: owner({ kind: "saved", personId: "p1" }) }));
      assert.lengthOf(learned, 0);
      // Absent counts as said to her until every vessel sends it.
      assert.isTrue(yield* end({ persona: "alfred", turnRef: "t9" }));
      assert.isTrue(yield* end({ speaker: owner(), addressed: true, tainted: true }));
      assert.deepStrictEqual(
        learned.map((l) => [l.sourceRef, l.agent, l.tainted]),
        [
          ["vessel:device:desk-1:t9", "alfred", false],
          ["vessel:device:desk-1", undefined, true],
        ],
      );
    }),
  );
});
