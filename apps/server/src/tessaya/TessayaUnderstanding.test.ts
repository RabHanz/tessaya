import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import type { UnderstandingRewrite } from "@t3tools/tessaya-shared/understanding";
import { vectorToBase64 } from "@t3tools/tessaya-voice/speakerStore";

import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaMemoryService, layer as memoryLayer } from "./TessayaMemoryService.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { make as makePeople, type PeopleCaller, TessayaPeople } from "./TessayaPeople.ts";
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
      Layer.provideMerge(Layer.effect(TessayaPeople, makePeople)),
      Layer.provideMerge(memoryLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  ).pipe(
    Effect.map((ctx) => ({
      understanding: Context.get(ctx, TessayaUnderstanding),
      memory: Context.get(ctx, TessayaMemoryService),
      // As a client's call runs: with the server's services around it.
      people: (input: Parameters<TessayaPeople["Service"]["call"]>[0], caller: PeopleCaller) =>
        Context.get(ctx, TessayaPeople).call(input, caller).pipe(Effect.provideContext(ctx)),
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

it.effect(
  "forgetting one fact is confirmed, takes only its wordings into the bin, never comes back by a rewrite, and restores",
  () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const v1 = "- Has two kids\n- Hates football";
      const v2 = `${v1}\n- Learning the guitar`;
      const { understanding, memory } = yield* fresh(
        [
          write(v1),
          write(v2),
          // The model slips and writes the forgotten fact back.
          write(`${v2}\n- Plays on Sundays`),
        ],
        prompts,
      );
      const owner = { kind: "owner", certainty: 1 } as const;
      yield* understanding.evidence(sam, "two kids, football", "t1");
      for (const t of ["t2", "t3", "t4"]) yield* understanding.evidence(sam, "guitar", t);
      const all = () =>
        memory.list({ kinds: ["understanding"], scope: "person", includeSuperseded: true });

      // By id, an understanding is never wiped; a fact unconfirmed is only said back.
      const [current] = yield* memory.list({ kinds: ["understanding"], scope: "person" });
      assert.isFalse(yield* memory.forget(current!.id));
      const asked = yield* understanding.forget(sam, "hates football", { actor: owner });
      assert.strictEqual(asked.status, "asked");
      assert.include(asked.line, "Hates football");
      assert.strictEqual(yield* understanding.current(sam), v2);

      const done = yield* understanding.forget(sam, "hates football", {
        actor: owner,
        confirmed: true,
      });
      assert.strictEqual(done.status, "done");
      assert.strictEqual(
        yield* understanding.current(sam),
        "- Has two kids\n- Learning the guitar",
      );
      const kept = (yield* all()).map((i) => i.text).toSorted();
      assert.deepStrictEqual(kept, ["- Has two kids", "- Has two kids\n- Learning the guitar"]);

      for (const t of ["t5", "t6", "t7"]) yield* understanding.evidence(sam, "sundays", t);
      const asked2 = prompts.at(-1)!;
      const named = "<forgotten>\n- Hates football\n</forgotten>";
      assert.include(asked2, named);
      assert.notInclude(asked2.replace(named, ""), "Hates football");
      assert.strictEqual(
        yield* understanding.current(sam),
        "- Has two kids\n- Learning the guitar\n- Plays on Sundays",
      );

      const back = yield* understanding.restore(sam, "hates football", { actor: owner });
      assert.strictEqual(back.status, "done");
      assert.strictEqual(
        yield* understanding.current(sam),
        "- Has two kids\n- Learning the guitar\n- Plays on Sundays\n- Hates football",
      );
      assert.strictEqual(
        (yield* understanding.restore(sam, "hates football", { actor: owner })).status,
        "refused",
      );

      // Past the bin's days it is gone for good.
      yield* understanding.forget(sam, "plays on sundays", { actor: owner, confirmed: true });
      yield* TestClock.adjust("31 days");
      assert.strictEqual(
        (yield* understanding.restore(sam, "plays on sundays", { actor: owner })).status,
        "refused",
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "forgetting a person bins their understanding with them, restore brings it back, and their facts share Recently forgotten",
  () =>
    Effect.gen(function* () {
      const { understanding, people } = yield* fresh(
        [write("- Plays the oud\n- Hates football")],
        [],
      );
      const owner: PeopleCaller = { role: "owner", assurance: 2 };
      const voice = new Float32Array(16);
      voice[3] = 1;
      const ali = (yield* people(
        {
          op: "peopleObserve",
          vessel: "tessel-1",
          said: "I'm Ali",
          print: { model: "m1", vector: vectorToBase64(voice), ms: 3_000 },
        },
        { role: null, assurance: 0 },
      )).person!;
      const them = { about: "person", id: ali.id } as const;
      yield* understanding.evidence(them, "I play the oud", "t1");
      yield* understanding.forget(them, "hates football", {
        actor: { kind: "owner", certainty: 1 },
        confirmed: true,
      });

      yield* people({ op: "peopleManage", action: "forget", id: ali.id, confirmed: true }, owner);
      assert.strictEqual(yield* understanding.current(them), "- Plays the oud");
      const bin = (yield* people({ op: "peopleList" }, owner)).forgotten!;
      assert.sameDeepMembers(
        bin.map((f) => [f.id === ali.id, f.fact ?? null]),
        [
          [true, null],
          [false, "- Hates football"],
        ],
      );

      yield* people({ op: "peopleManage", action: "restore", id: ali.id }, owner);
      const fact = bin.find((f) => f.fact !== undefined)!;
      const back = yield* people({ op: "peopleManage", action: "restore", id: fact.id }, owner);
      assert.strictEqual(back.status, "done");
      assert.strictEqual(yield* understanding.current(them), "- Plays the oud\n- Hates football");
      assert.lengthOf((yield* people({ op: "peopleList" }, owner)).forgotten!, 0);
    }).pipe(Effect.scoped),
);
