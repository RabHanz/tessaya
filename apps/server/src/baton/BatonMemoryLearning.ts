// @effect-diagnostics nodeBuiltinImport:off
/**
 * The learning loop (D150, docs/baton/MEMORY.md section 4): after a turn and at the end of a job a
 * cheap model proposes memory items; the pure rules decide which become drafts and the store's door
 * decides which are kept. A failure here never reaches the user: learning is a bonus, never a gate.
 */
import { detectSecret } from "@t3tools/baton-shared/memory";
import {
  draftsFromProposals,
  extractionPrompt,
  planMerges,
  planRewrites,
  worthLearningFrom,
  type LearnInput,
} from "@t3tools/baton-shared/memoryLearning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import { BatonOneShot } from "./BatonOneShot.ts";
import { dayOf } from "./BatonMemoryEpisode.ts";
import { BatonMemoryService, MemoryViewer } from "./BatonMemoryService.ts";
import { readPack, readRouting } from "./OperatingSystemPack.ts";
import { isWalled } from "@t3tools/baton-shared/osPack";

const Proposals = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      text: Schema.String,
      scope: Schema.optionalKey(Schema.String),
      scopeRef: Schema.optionalKey(Schema.NullOr(Schema.String)),
      hisStatement: Schema.optionalKey(Schema.Boolean),
      replaces: Schema.optionalKey(Schema.NullOr(Schema.String)),
      days: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  ),
});

/** The existing memories closest to the exchange, shown to the extractor so it can name what it replaces: this many by
 * words, and as many again by recall. */
const KNOWN_SHOWN = 8;

export interface LearnResult {
  readonly stored: number;
  readonly held: number;
}

export class BatonMemoryLearning extends Context.Service<
  BatonMemoryLearning,
  {
    readonly learn: (input: LearnInput) => Effect.Effect<LearnResult>;
    /** The daily pass: merge near-duplicates, then delete what expired or faded. */
    readonly consolidate: Effect.Effect<{ readonly merged: number; readonly swept: number }>;
    /** The weekly pass: near-duplicates become one item with the fuller wording. */
    readonly rewriteNearDuplicates: Effect.Effect<number>;
  }
>()("t3/baton/BatonMemoryLearning") {}

export const make = Effect.gen(function* () {
  const memory = yield* BatonMemoryService;
  const oneShot = yield* BatonOneShot;
  const config = yield* ServerConfig.ServerConfig;

  const learn = Effect.fn("BatonMemoryLearning.learn")(function* (input: LearnInput) {
    const none: LearnResult = { stored: 0, held: 0 };
    // VAULT.md section 1: a secret is neither kept as talk nor put in the extractor's prompt.
    if (detectSecret(`${input.said}\n${input.reply}`) !== null) return none;
    if (input.origin === "turn" && input.said.trim() !== "") {
      yield* memory.noteTalk(dayOf(yield* Clock.currentTimeMillis), input.said);
    }
    if (!worthLearningFrom(input)) return none;
    const reader = {
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.project === null ? {} : { scopeRef: input.project }),
    };
    // A project's turn never sees, so never replaces, another project's item (search only ranks by project).
    const byWords = (yield* memory.search({ text: input.said, limit: KNOWN_SHOWN, ...reader }))
      .map((hit) => hit.item)
      .filter(
        (item) =>
          input.project === null || item.scope !== "project" || item.scopeRef === input.project,
      );
    // Recall's ranking adds meaning, so a reworded update is shown the fact it replaces (MEM-15). Recall's word floor
    // drops what a long statement matches by few words, so the plain word search stays beside it.
    const byRecall = yield* memory.related({ text: input.said, ...reader });
    const known = [
      ...new Map([...byWords, ...byRecall.slice(0, KNOWN_SHOWN)].map((i) => [i.id, i])).values(),
    ];
    // A turn in a walled project keeps what it learns behind that wall, whatever scope the model chose.
    const walled =
      input.project !== null && isWalled(readPack(NodePath.dirname(config.dbPath)), input.project)
        ? input.project
        : null;
    const proposals = yield* oneShot
      .run({
        prompt: extractionPrompt(input, known),
        outputSchema: Proposals,
        model: readRouting(NodePath.dirname(config.dbPath)).cheap,
      })
      .pipe(Effect.orElseSucceed(() => ({ items: [] })));
    const drafts = draftsFromProposals(proposals.items, input, yield* Clock.currentTimeMillis).map(
      (d) =>
        walled === null
          ? d
          : { ...d, draft: { ...d.draft, scope: "project" as const, scopeRef: walled } },
    );
    let stored = 0;
    let held = 0;
    for (const { draft, replaces } of drafts) {
      // Only an id it was shown, and never his own note from a turn that read outside content.
      const older = known.find(
        (item) => item.id === replaces && !(input.tainted && item.source === "user"),
      );
      const item = yield* memory
        .add({ ...draft, ...(older === undefined ? {} : { supersedes: older.id }) })
        .pipe(Effect.orElseSucceed(() => null));
      if (item === null) continue;
      if (item.proposed) held++;
      else stored++;
    }
    return { stored, held };
  });

  const consolidate = Effect.gen(function* () {
    const all = yield* memory.list({
      includeSuperseded: true,
      includeProposed: true,
      limit: 100_000,
    });
    const plans = planMerges(all);
    for (const { keep, drop } of plans) {
      // Saying it twice is repetition: re-adding the survivor reinforces it (MEMORY.md section 2).
      yield* memory
        .add({
          kind: keep.kind,
          text: keep.text,
          source: keep.source,
          sourceRef: keep.sourceRef,
          scope: keep.scope,
          scopeRef: keep.scopeRef,
        })
        .pipe(Effect.ignore);
      yield* memory.forget(drop.id);
    }
    return { merged: plans.length, swept: yield* memory.sweep };
    // Upkeep sees, merges and forgets every item, walled or not.
  }).pipe(Effect.provideService(MemoryViewer, "server"));

  const rewriteNearDuplicates = Effect.gen(function* () {
    const all = yield* memory.list({ includeSuperseded: true, limit: 100_000 });
    let done = 0;
    for (const { keep, drop, text } of planRewrites(all)) {
      if (text !== keep.text)
        yield* memory.rewrite(keep.id, text, "consolidate").pipe(Effect.ignore);
      yield* memory.forget(drop.id);
      done++;
    }
    return done;
  }).pipe(Effect.provideService(MemoryViewer, "server"));

  return BatonMemoryLearning.of({ learn, consolidate, rewriteNearDuplicates });
});

export const layer = Layer.effect(BatonMemoryLearning, make);
