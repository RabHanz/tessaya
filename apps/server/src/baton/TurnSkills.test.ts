import { assert, it } from "@effect/vitest";
import { skillFileText } from "@t3tools/baton-shared/skillLearning";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonMemoryService, layer as memoryLayer } from "./BatonMemoryService.ts";
import { turnSkills } from "./TurnSkills.ts";

const layer = it.layer(memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("his skills on any vessel", (it) => {
  it.effect(
    "a turn gets his accepted skill when its words fit and it has the skill's tools; a vessel without them never does",
    () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        yield* memory.add({
          kind: "skill",
          source: "user",
          sourceRef: "skill:export-invoices",
          text: skillFileText({
            slug: "export-invoices",
            when: "export the invoices",
            apps: [],
            tools: ["ui_tree", "click_element"],
            persona: null,
            project: null,
            verified: true,
            evidence: "11 calls -> 2",
            body: "Open File, then Export, then pick CSV.",
          }),
        });
        const desk = yield* turnSkills({ text: "export the invoices please" }, [
          "ui_tree",
          "click_element",
          "home_find",
        ]);
        assert.include(desk, "export-invoices");
        assert.include(desk, "pick CSV");
        // The room has no screen tools: the skill is not offered there.
        assert.strictEqual(
          yield* turnSkills({ text: "export the invoices please" }, ["home_find"]),
          "",
        );
        assert.strictEqual(
          yield* turnSkills({ text: "turn on the lamp" }, ["ui_tree", "click_element"]),
          "",
        );
      }),
  );
});
