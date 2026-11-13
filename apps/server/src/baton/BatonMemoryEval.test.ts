// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { MemoryDraft } from "@t3tools/baton-shared/memory";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import {
  BatonMemoryEmbedder,
  layer as embedderLayer,
  layerNone as noEmbedder,
} from "./BatonMemoryEmbedder.ts";
import { BatonMemoryLearning, layer as learningLayer } from "./BatonMemoryLearning.ts";
import {
  BatonMemoryService,
  MemoryViewer,
  layer as memoryLayer,
  textHash,
} from "./BatonMemoryService.ts";
import { BatonOneShot } from "./BatonOneShot.ts";
import { TessayaTurn, layer as turnLayer } from "./TessayaTurn.ts";
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
     * "MEM-13" rows wait only for the local model: with it present they must pass. A "fused: " mark fails only with the model.
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
    /** The persona asking (its pack id), as the desktop and the room name it. */
    readonly agent?: string;
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
  /** It brought back a fact a newer one replaced (Memora's obsolete-memory failure). */
  readonly stale: boolean;
}

/** Mean recall@K over the keys a case expects, mean reciprocal rank of the first one, and how many abstentions held. */
const score = (runs: ReadonlyArray<Run>) => {
  const scored = runs.filter((r) => r.expected.length > 0);
  const abstain = runs.filter((r) => r.abstain);
  const mean = (f: (r: Run) => number) => scored.reduce((n, r) => n + f(r), 0) / scored.length;
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
    stale: `${runs.filter((r) => r.stale).length}/${runs.length}`,
  };
};

/** The fused arm never falls back to keywords: a sentence the model could not embed fails the run. */
const strictModel = Layer.effect(
  BatonMemoryEmbedder,
  Effect.gen(function* () {
    const real = yield* BatonMemoryEmbedder;
    if (real.model === null) return yield* Effect.die("the memory model did not load");
    return BatonMemoryEmbedder.of({
      model: real.model,
      embed: (text, query) =>
        real.embed(text, query).pipe(
          Effect.filterOrElse(
            (vector) => vector !== null,
            () => Effect.die(`the memory model did not embed "${text}"`),
          ),
        ),
    });
  }),
).pipe(Layer.provide(embedderLayer));

/** The background pass waits a minute and paces itself; the eval embeds every current item at once, as that pass would. */
const embedAll = Effect.gen(function* () {
  const embedder = yield* BatonMemoryEmbedder;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string; text: string }>`
    SELECT id, text FROM fabric_memory_items WHERE superseded_by IS NULL AND proposed = 0
  `;
  for (const row of rows) {
    const vector = yield* embedder.embed(row.text);
    yield* sql`
      INSERT INTO fabric_memory_vectors (item_id, model, text_hash, vector, updated_at)
      VALUES (${row.id}, ${embedder.model}, ${textHash(row.text)}, ${vectorToBytes(vector!)}, '')
    `;
  }
}).pipe(Effect.orDie);

const corpusOf = new Map(corpora);

/** Which path a case is asked through: the desktop's search or block, or what a device vessel gets for a sentence. */
type Arm = "keyword" | "fused" | "device";

/** The memory service with the turn pipeline over it; begin never learns, so learning is a stand-in. */
const withTurn = <E, R>(model: Layer.Layer<BatonMemoryEmbedder, E, R>) =>
  turnLayer.pipe(
    Layer.provideMerge(Layer.mock(BatonMemoryLearning)({})),
    Layer.provideMerge(memoryLayer),
    Layer.provideMerge(model),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

/** A device vessel's turn, through the one pipeline every vessel uses (`TessayaTurn.begin`). */
const deviceIds = (text: string, persona?: string, project?: string) =>
  Effect.map(
    Effect.flatMap(TessayaTurn, (turn) =>
      turn.begin({
        vessel: { kind: "device", id: "eval" },
        text,
        sessionless: true,
        ...(persona === undefined ? {} : { persona }),
        ...(project === undefined ? {} : { project }),
      }),
    ),
    (c) => c.ids,
  );

// it.effect runs on the test clock, so the 300 ms query-embed budget never cuts a slow embed: the scores are a best case.
const retrieval = (arm: Arm, model: Layer.Layer<BatonMemoryEmbedder>, withModel: boolean) =>
  it.effect.each(files)(`retrieval (${arm}${withModel ? "" : ", no model"}): %s`, (file) =>
    Effect.gen(function* () {
      const corpus = corpusOf.get(file)!;
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
      if (withModel) yield* embedAll;
      const replaced = new Set(
        corpus.items.flatMap((i) => (i.supersedes === undefined ? [] : [i.supersedes])),
      );
      const runs: Array<Run> = [];
      const wrong: Array<string> = [];
      for (const c of corpus.cases) {
        // A vessel's turn is a block, never a search: the device arm asks only the block's cases.
        if (arm === "device" && c.recall !== true) continue;
        const scope = {
          ...(c.scopeRef === undefined ? {} : { scopeRef: c.scopeRef }),
          ...(c.agent === undefined ? {} : { agent: c.agent }),
        };
        const ids =
          arm === "device"
            ? yield* deviceIds(c.query, c.agent, c.scopeRef)
            : c.recall
              ? (yield* memory.recall({ text: c.query, budgetTokens: 300, ...scope })).ids
              : (yield* memory.search({ text: c.query, ...scope })).map((h) => h.item.id);
        const keys = ids.map((id) => keyOf.get(id) ?? id);
        const expected = [...(c.top === undefined ? [] : [c.top]), ...(c.present ?? [])];
        runs.push({
          group: c.group ?? "all",
          expected,
          keys,
          abstain: c.count === 0,
          stale: keys.some((k) => replaced.has(k)),
        });
        const say = `"${c.query}" gave ${JSON.stringify(keys)}`;
        // A case passes on its whole block (any rank within the budget); recall@5 counts only the first five.
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
        // MEM-13 fails on keywords only, "fused: " with the model only; any other mark fails in both arms.
        const pending =
          c.pending === undefined
            ? false
            : c.pending === "MEM-13"
              ? !withModel
              : c.pending.startsWith("fused: ")
                ? withModel
                : true;
        if (passed === pending) wrong.push(pending ? `${say}: passes now, drop "pending"` : say);
      }
      const groups = [...new Set(runs.map((r) => r.group))];
      for (const group of groups.length > 1 ? ["all", ...groups] : groups) {
        const { cases, recallAtK, mrr, abstained, stale } = score(
          group === "all" ? runs : runs.filter((r) => r.group === group),
        );
        const scores =
          cases === 0
            ? `recall@${K} n/a MRR n/a`
            : `recall@${K} ${recallAtK.toFixed(3)} MRR ${mrr.toFixed(3)} over ${cases}`;
        console.log(
          `memory eval ${arm}${withModel ? "" : " (no model)"} ${file} ${group}: ${scores}, nothing back ${abstained}, stale ${stale}`,
        );
      }
      // A replaced fact never comes back on any path.
      assert.isFalse(
        runs.some((r) => r.stale),
        "a superseded item came back",
      );
      assert.deepStrictEqual(wrong, []);
    }).pipe(
      // Read as the desktop's own session (and a device vessel's adapter) does: a persona's walls apply.
      Effect.provideService(MemoryViewer, "desktop"),
      Effect.provide(withTurn(model)),
    ),
  );

/** Old facts a reworded update leaves alive, at most; lower it when the loop improves. */
const LEFT_AT_MOST = { keyword: 8, fused: 2 } as const;

/**
 * MEM-15: each superseded pair's new wording is said as a turn, with the old fact stored unlinked. A perfect extractor
 * names the old fact's id whenever it is shown, so what is left alive is what the loop never showed it.
 */
const learning = (arm: "keyword" | "fused", model: Layer.Layer<BatonMemoryEmbedder>) =>
  it.effect(`learning (${arm}): a reworded update replaces the fact it updates`, () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learn = yield* BatonMemoryLearning;
      const { items } = corpusOf.get("06-corpus.json")!;
      const pairs = items.filter((i) => i.supersedes !== undefined);
      const idOf = new Map<string, string>();
      for (const { key, supersedes, ...draft } of items) {
        if (supersedes === undefined) idOf.set(key, (yield* memory.add(draft)).id);
      }
      if (arm === "fused") yield* embedAll;
      const alive: Array<string> = [];
      for (const { key, supersedes, text } of pairs) {
        target = { text, old: idOf.get(supersedes!)! };
        yield* learn.learn({
          origin: "turn",
          said: text,
          reply: "Noted.",
          sourceRef: key,
          tainted: false,
          project: null,
        });
        const old = (yield* memory.list({ includeSuperseded: true, limit: 100_000 })).find(
          (i) => i.id === target.old,
        );
        if (old?.supersededBy === null) alive.push(supersedes!);
      }
      console.log(
        `memory eval ${arm} learning: ${alive.length}/${pairs.length} old facts left alive ${JSON.stringify(alive)}`,
      );
      assert.isAtMost(alive.length, LEFT_AT_MOST[arm]);
    }).pipe(
      Effect.provide(
        learningLayer.pipe(
          Layer.provideMerge(memoryLayer),
          Layer.provideMerge(model),
          Layer.provideMerge(oracle),
          Layer.provideMerge(nowhere),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
  );

let target = { text: "", old: "" };
/** The perfect extractor: it proposes his new wording and names the old fact when the prompt lists it. */
const oracle = Layer.succeed(BatonOneShot, {
  run: ((input: { readonly prompt: string }) =>
    Effect.succeed({
      items: [
        {
          kind: "fact",
          text: target.text,
          hisStatement: true,
          replaces: input.prompt.includes(target.old) ? target.old : null,
        },
      ],
    } as never)) as BatonOneShot["Service"]["run"],
});
const nowhere = Layer.succeed(ServerConfig.ServerConfig, {
  dbPath: "/nowhere/statev2.sqlite",
} as unknown as ServerConfig.ServerConfig["Service"]);

retrieval("keyword", noEmbedder, false);
retrieval("device", noEmbedder, false);
learning("keyword", noEmbedder);
// The model is not in git (scripts/tessaya/fetch-memory-model.mjs fetches it), so CI runs the keyword arm only.
describe.runIf(hasModel)("with the local model", () => {
  retrieval("fused", strictModel, true);
  retrieval("device", strictModel, true);
  learning("fused", strictModel);
});

/**
 * How long each path takes per sentence on this machine, on the wall clock with the real 300 ms query-embed budget.
 * A benchmark, not a test: it prints and asserts nothing. `MEMORY_EVAL_LATENCY=1 vp test run <this file> --silent=false`
 */
describe.runIf(hasModel && process.env["MEMORY_EVAL_LATENCY"] === "1")("latency", () => {
  it.live("p50 and p95 per path over 06-corpus", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const turn = yield* TessayaTurn;
      const { items, cases } = corpusOf.get("06-corpus.json")!;
      const idOf = new Map<string, string>();
      for (const { key, supersedes, ...draft } of items) {
        const made = yield* memory.add({
          ...draft,
          ...(supersedes === undefined ? {} : { supersedes: idOf.get(supersedes)! }),
        });
        idOf.set(key, made.id);
      }
      yield* embedAll;
      const paths: Record<string, (text: string) => Effect.Effect<unknown>> = {
        keyword: (text) => memory.search({ text }),
        fused: (text) => memory.recall({ text, budgetTokens: 300 }),
        device: (text) => deviceIds(text).pipe(Effect.provideService(TessayaTurn, turn)),
      };
      for (const [arm, ask] of Object.entries(paths)) {
        const ms: Array<number> = [];
        for (const c of cases) ms.push(Duration.toMillis((yield* Effect.timed(ask(c.query)))[0]));
        ms.sort((a, b) => a - b);
        const at = (q: number) =>
          ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]!.toFixed(1);
        console.log(
          `memory eval latency ${arm}: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms over ${ms.length}`,
        );
      }
    }).pipe(Effect.provide(withTurn(strictModel))),
  );
});
