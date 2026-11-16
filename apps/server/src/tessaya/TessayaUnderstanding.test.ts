import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { UnderstandingRewrite } from "@t3tools/tessaya-shared/understanding";

import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaMemoryService, layer as memoryLayer } from "./TessayaMemoryService.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { TessayaUnderstanding, layer as understandingLayer } from "./TessayaUnderstanding.ts";

const write = (text: string, old: string | null = null): UnderstandingRewrite => ({
  unchanged: false,
  text,
  changes: [{ old, new: text.split("\n").at(-1)!, cause: "they said so", evidence: "x" }],
});
const unchanged: UnderstandingRewrite = { unchanged: true, text: null, changes: [] };

const fresh = (answers: Array<UnderstandingRewrite>, prompts: Array<string>) =>
  Layer.build(
    understandingLayer.pipe(
      Layer.provideMerge(
        Layer.mock(TessayaOneShot)({
          run: ({ prompt }) => {
            prompts.push(prompt);
            return Effect.succeed(answers.shift() ?? unchanged) as never;
          },
        }),
      ),
      Layer.provideMerge(memoryLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  ).pipe(
    Effect.map((ctx) => ({
      understanding: Context.get(ctx, TessayaUnderstanding),
      memory: Context.get(ctx, TessayaMemoryService),
    })),
  );

const sam = { about: "person", id: "sam" } as const;

it.effect(
  "starts on the first evidence, rewrites after three more, and each rewrite supersedes the last",
  () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const first = "- Has two kids\n- Coaches football on Saturdays";
      const second = "- Has two kids\n- Coaches football on Saturdays\n- Learning the guitar";
      const { understanding, memory } = yield* fresh([write(first), write(second)], prompts);

      yield* understanding.evidence(sam, "I'm Sam, two kids, I coach their football", "t1");
      assert.strictEqual(yield* understanding.current(sam), first);
      yield* understanding.evidence(sam, "I started the guitar", "t2");
      yield* understanding.evidence(sam, "it's hard on the fingers", "t3");
      assert.strictEqual(prompts.length, 1, "no rewrite before three new lines");
      yield* understanding.evidence(sam, "but I love it", "t4");
      assert.strictEqual(prompts.length, 2);
      assert.include(prompts[1]!, "<current>- Has two kids");
      assert.include(prompts[1]!, "- I started the guitar");
      assert.strictEqual(yield* understanding.current(sam), second);

      // The old wording stays, dated and out of recall, superseded by the new; its cause is the turns it rests on.
      const all = yield* memory.list({
        kinds: ["understanding"],
        scope: "person",
        includeSuperseded: true,
      });
      assert.strictEqual(all.length, 2);
      const old = all.find((i) => i.text === first)!;
      const now = all.find((i) => i.text === second)!;
      assert.strictEqual(old.supersededBy, now.id);
      assert.strictEqual(now.sourceRef, "t2, t3, t4");
      assert.strictEqual(now.text.split("\n").length, 3, "one fact a line");
    }).pipe(Effect.scoped),
);

it.effect(
  "an unchanged answer writes nothing, and her own understanding is apart from theirs",
  () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const { understanding, memory } = yield* fresh(
        [write("- Keeps answers short"), unchanged],
        prompts,
      );
      const self = { about: "self", persona: undefined } as const;
      yield* understanding.evidence(self, "stop reading out every step", "t1");
      yield* understanding.evidence(sam, "set a timer", "t2");
      assert.include(prompts[0]!, "understanding of itself");
      assert.strictEqual(yield* understanding.current(self), "- Keeps answers short");
      assert.strictEqual(yield* understanding.current(sam), null);
      assert.strictEqual(
        (yield* memory.list({ kinds: ["understanding"], includeSuperseded: true })).length,
        1,
      );
    }).pipe(Effect.scoped),
);

it.effect("an understanding never reaches a sentence's recall or the default list", () =>
  Effect.gen(function* () {
    const { understanding, memory } = yield* fresh([write("- Sam coaches football")], []);
    yield* memory.add({
      kind: "fact",
      text: "Sam's football match is on Saturday",
      source: "user",
    });
    yield* understanding.evidence(sam, "I coach football", "t1");
    const recalled = yield* memory.related({ text: "when does Sam play football" });
    assert.deepStrictEqual(
      recalled.map((i) => i.kind),
      ["fact"],
    );
    assert.isFalse((yield* memory.list()).some((i) => i.kind === "understanding"));
  }).pipe(Effect.scoped),
);
