// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { MemoryDraft } from "@t3tools/baton-shared/memory";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import {
  BatonMemoryEmbedder,
  layer as embedderLayer,
  layerNone as noEmbedder,
} from "./BatonMemoryEmbedder.ts";
import { BatonMemoryService, layer as memoryLayer, textHash } from "./BatonMemoryService.ts";
import { vectorToBytes } from "./memoryVectors.ts";

/** docs/baton/evals-memory/*.json: what is remembered, then what a question should bring back first. */
interface Corpus {
  readonly items: ReadonlyArray<
    Omit<MemoryDraft, "supersedes"> & { key: string; supersedes?: string }
  >;
  readonly cases: ReadonlyArray<{
    /** Ask for the per-sentence block the model gets (the desktop's budget), not a search. */
    readonly recall?: boolean;
    /**
     * Known to fail until this finding lands; the run fails once it passes, so the mark is dropped.
     * "MEM-13" rows wait only for the local model: with it present they must pass.
     */
    readonly pending?: string;
    /** Which family the case measures (paraphrase, superseded, ...), for the per-family scores. */
    readonly group?: string;
    readonly query: string;
    readonly scopeRef?: string;
    readonly top?: string;
    readonly present?: ReadonlyArray<string>;
    readonly absent?: ReadonlyArray<string>;
    readonly count?: number;
  }>;
}

const dir = NodePath.join(import.meta.dirname, "../../../../docs/baton/evals-memory");
const files = NodeFS.readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .toSorted();
const corpora = files.map(
  (f) => [f, JSON.parse(NodeFS.readFileSync(NodePath.join(dir, f), "utf8")) as Corpus] as const,
);

it.effect("there are at least twenty retrieval cases", () =>
  Effect.sync(() =>
    assert.isAtLeast(
      corpora.reduce((n, [, c]) => n + c.cases.length, 0),
      20,
    ),
  ),
);

// The scores print with `vp test run src/baton/BatonMemoryEval.test.ts --silent=false`.
const K = 5;
const hasModel = NodeFS.existsSync(
  new URL("../../resources/memory-model/model_quantized.onnx", import.meta.url),
);

interface Run {
  readonly group: string;
  readonly expected: ReadonlyArray<string>;
  readonly keys: ReadonlyArray<string>;
  /** Nothing should come back (count 0). */
  readonly abstain: boolean;
}

/** Mean recall@K over the keys a case expects, mean reciprocal rank of the first one, and how many abstentions held. */
const score = (runs: ReadonlyArray<Run>) => {
  const scored = runs.filter((r) => r.expected.length > 0);
  const abstain = runs.filter((r) => r.abstain);
  const mean = (f: (r: Run) => number) =>
    scored.length === 0 ? 0 : scored.reduce((n, r) => n + f(r), 0) / scored.length;
  return {
    cases: scored.length,
    recallAtK: mean(
      (r) => r.expected.filter((k) => r.keys.slice(0, K).includes(k)).length / r.expected.length,
    ),
    mrr: mean((r) => {
      const rank = r.keys.findIndex((k) => r.expected.includes(k));
      return rank < 0 ? 0 : 1 / (rank + 1);
    }),
    abstained: `${abstain.filter((r) => r.keys.length === 0).length}/${abstain.length}`,
  };
};

/** The background pass waits a minute and paces itself; the eval embeds every current item at once, as that pass would. */
const embedAll = Effect.gen(function* () {
  const embedder = yield* BatonMemoryEmbedder;
  if (embedder.model === null) return yield* Effect.die("the memory model did not load");
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string; text: string }>`
    SELECT id, text FROM fabric_memory_items WHERE superseded_by IS NULL AND proposed = 0
  `;
  for (const row of rows) {
    const vector = yield* embedder.embed(row.text);
    if (vector === null) return yield* Effect.die("the memory model failed");
    yield* sql`
      INSERT INTO fabric_memory_vectors (item_id, model, text_hash, vector, updated_at)
      VALUES (${row.id}, ${embedder.model}, ${textHash(row.text)}, ${vectorToBytes(vector)}, '')
    `;
  }
}).pipe(Effect.orDie);

const arms = [
  { arm: "keyword", model: noEmbedder, run: true },
  // The model is not in git (scripts/tessaya/fetch-memory-model.mjs fetches it), so CI runs the keyword arm only.
  { arm: "fused", model: embedderLayer, run: hasModel },
] as const;

for (const { arm, model, run } of arms) {
  for (const [file, corpus] of corpora) {
    it.effect.runIf(run)(`retrieval (${arm}): ${file}`, () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        const keyOf = new Map<string, string>();
        const idOf = new Map<string, string>();
        for (const { key, supersedes, ...draft } of corpus.items) {
          const made = yield* memory.add({
            ...draft,
            ...(supersedes === undefined ? {} : { supersedes: idOf.get(supersedes)! }),
          });
          idOf.set(key, made.id);
          if (!keyOf.has(made.id)) keyOf.set(made.id, key);
        }
        if (arm === "fused") yield* embedAll;
        const runs: Array<Run> = [];
        const wrong: Array<string> = [];
        for (const c of corpus.cases) {
          const scope = c.scopeRef === undefined ? {} : { scopeRef: c.scopeRef };
          const ids = c.recall
            ? (yield* memory.recall({ text: c.query, budgetTokens: 300, ...scope })).ids
            : (yield* memory.search({ text: c.query, ...scope })).map((h) => h.item.id);
          const keys = ids.map((id) => keyOf.get(id) ?? id);
          const expected = [...(c.top === undefined ? [] : [c.top]), ...(c.present ?? [])];
          runs.push({ group: c.group ?? "all", expected, keys, abstain: c.count === 0 });
          const say = `"${c.query}" gave ${JSON.stringify(keys)}`;
          const check = () => {
            if (c.top !== undefined) assert.strictEqual(keys[0], c.top, say);
            for (const k of c.present ?? []) assert.include(keys, k, say);
            for (const k of c.absent ?? []) assert.notInclude(keys, k, say);
            if (c.count !== undefined) assert.lengthOf(keys, c.count, say);
          };
          const passed = (() => {
            try {
              check();
              return true;
            } catch {
              return false;
            }
          })();
          const pending = c.pending !== undefined && !(c.pending === "MEM-13" && arm === "fused");
          if (passed === pending) wrong.push(pending ? `${say}: passes now, drop "pending"` : say);
        }
        const groups = [...new Set(runs.map((r) => r.group))];
        for (const group of groups.length > 1 ? ["all", ...groups] : groups) {
          const { cases, recallAtK, mrr, abstained } = score(
            group === "all" ? runs : runs.filter((r) => r.group === group),
          );
          console.log(
            `memory eval ${arm} ${file} ${group}: recall@${K} ${recallAtK.toFixed(3)} MRR ${mrr.toFixed(3)} over ${cases}, nothing back ${abstained}`,
          );
        }
        assert.deepStrictEqual(wrong, []);
      }).pipe(
        Effect.provide(
          memoryLayer.pipe(Layer.provideMerge(model), Layer.provideMerge(SqlitePersistenceMemory)),
        ),
      ),
    );
  }
}
