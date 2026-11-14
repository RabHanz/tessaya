// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { TessayaOneShot, TessayaOneShotError } from "./TessayaOneShot.ts";
import { layer as labLayer, PromptLab, PromptLabSources } from "./PromptLab.ts";

const asked: Array<{ prompt: string; model?: string; system?: string }> = [];
const oneShot = Layer.succeed(TessayaOneShot, {
  run: (input: { prompt: string; model?: string; system?: string }) =>
    input.prompt.includes("revenue")
      ? Effect.fail(new TessayaOneShotError({ detail: "limit reached" }))
      : Effect.sync(() => {
          asked.push(input);
          return { reply: `${input.model}: hello` };
        }),
} as never);
const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-lab-" }).pipe(
  Layer.provide(NodeServices.layer),
);

it.layer(labLayer.pipe(Layer.provideMerge(Layer.mergeAll(oneShot, config))))("PromptLab", (it) => {
  it.effect("saves a variant without touching live, promotes it, and rolls back and forth", () =>
    Effect.gen(function* () {
      const lab = yield* PromptLab;
      const dir = NodePath.join(
        NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath),
        "operating-system",
      );
      const before = (yield* lab.call({ op: "list" })).personas!.find((p) => p.name === "Alfred")!;
      assert.isFalse(before.mine);
      assert.strictEqual(
        (yield* lab.call({ op: "save", persona: "Alfred", variant: "live", text: "x" })).line,
        '"live" is kept for the lab itself; choose another name.',
      );
      yield* lab.call({ op: "save", persona: "alfred", variant: "dry", text: "Drier." });
      const live = NodePath.join(dir, "roles", `${before.id}.md`);
      assert.isFalse(NodeFS.existsSync(live));

      yield* lab.call({ op: "promote", persona: "Alfred", variant: "dry" });
      assert.strictEqual(NodeFS.readFileSync(live, "utf8"), "Drier.\n");
      // Back to the shipped default: his file goes.
      yield* lab.call({ op: "rollback", persona: "Alfred" });
      assert.isFalse(NodeFS.existsSync(live));
      // A rollback is a swap, so it can be undone.
      yield* lab.call({ op: "rollback", persona: "Alfred" });
      assert.strictEqual(NodeFS.readFileSync(live, "utf8"), "Drier.\n");
      const after = (yield* lab.call({ op: "list" })).personas!.find((p) => p.name === "Alfred")!;
      assert.deepEqual(
        after.variants.map((v) => v.name),
        ["dry"],
      );
      assert.isTrue(after.mine && after.previous);
    }),
  );

  it.effect(
    "runs variants on chosen models over the scenarios, scored, and refuses what it cannot run",
    () =>
      Effect.gen(function* () {
        const lab = yield* PromptLab;
        yield* lab.call({
          op: "save",
          persona: "Tessaya",
          variant: "b",
          text: "---\nrole: brisk\n---\nBe brisk.",
        });
        const ran = yield* lab.call({
          op: "run",
          persona: "Tessaya",
          variants: ["live", "b"],
          models: ["haiku", "sonnet"],
        });
        assert.lengthOf(ran.cells!, 4);
        const b = ran.cells!.find((c) => c.variant === "b" && c.model === "sonnet")!;
        assert.strictEqual(
          b.replies.find((r) => r.scenario === "greeting")!.reply,
          "sonnet: hello",
        );
        // A model that fails is a reply that says so, scored as a miss, not a failed run.
        assert.isFalse(b.replies.find((r) => r.scenario === "unsure")!.score.passed);
        assert.include(asked.at(-1)!.system!, "Be brisk.");
        assert.include(asked.at(-1)!.system!, "brisk");
        assert.notInclude(asked.at(-1)!.system!, "---");

        const one = yield* lab.call({
          op: "run",
          persona: "Tessaya",
          variants: ["b"],
          models: ["opus"],
          message: "how are you?",
        });
        assert.deepEqual(
          one.cells![0]!.replies.map((r) => r.scenario),
          ["message"],
        );
        assert.include(
          (yield* lab.call({ op: "run", persona: "Tessaya", variants: ["b"], models: ["gpt-9"] }))
            .line,
          "not a model the lab runs",
        );
        assert.include(
          (yield* lab.call({ op: "run", persona: "Tessaya", variants: ["zzz"], models: ["haiku"] }))
            .line,
          "no variant called zzz",
        );
      }),
  );

  it.effect("lists another layer's prompt sources by name only", () =>
    Effect.gen(function* () {
      const lab = yield* PromptLab;
      const listed = yield* lab
        .call({ op: "list" })
        .pipe(Effect.provideService(PromptLabSources, [{ id: "inner", label: "Inner prompts" }]));
      assert.deepEqual(listed.sources, [{ id: "inner", label: "Inner prompts" }]);
    }),
  );
});
