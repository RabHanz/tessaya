import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { MOTION_LIBRARY } from "@t3tools/tessaya-shared/bodyMotionLibrary";

import { resolveIntents } from "./bodyIntents.ts";
import { TessayaMemoryEmbedder } from "./TessayaMemoryEmbedder.ts";

// a model that reads one library entry's text and one unrelated asking as the same thing, and the rest as nothing alike
const target = MOTION_LIBRARY[0]!;
const fake = TessayaMemoryEmbedder.of({
  model: "fake",
  embed: (text: string) =>
    Effect.succeed(
      text === target.text || text === "zz qq feeling"
        ? Float32Array.from([1, 0])
        : Float32Array.from([0, 1]),
    ),
});

it.effect("names an intent's library entry by meaning, in the move and its later steps", () =>
  Effect.gen(function* () {
    const raw = {
      intent: "zz qq feeling",
      then: [{ afterMs: 500, intent: "zz qq feeling" }, { afterMs: 900 }],
    };
    const out = (yield* resolveIntents(raw).pipe(
      Effect.provideService(TessayaMemoryEmbedder, fake),
    )) as typeof raw;
    assert.strictEqual(out.intent, target.id);
    assert.strictEqual(out.then[0]!.intent, target.id);
    assert.deepStrictEqual(out.then[1], { afterMs: 900 });
  }),
);

it.effect("leaves the move as it is with no model on this server", () =>
  Effect.gen(function* () {
    const raw = { intent: "zz qq feeling" };
    assert.strictEqual(yield* resolveIntents(raw), raw);
  }),
);
