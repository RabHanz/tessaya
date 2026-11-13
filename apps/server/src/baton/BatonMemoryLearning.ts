// @effect-diagnostics nodeBuiltinImport:off
/**
 * The learning loop (D150, docs/baton/MEMORY.md section 4): after a turn and at the end of a job a
 * cheap model proposes memory items; the pure rules decide which become drafts and the store's door
 * decides which are kept. A failure here never reaches the user: learning is a bonus, never a gate.
 */
import { detectSecret, type MemoryItem } from "@t3tools/baton-shared/memory";
import {
  draftsFromProposals,
  episodePrompt,
  episodeText,
  extractionPrompt,
  LEARN_MIN_CHARS,
  planMerges,
  planRewrites,
  worthLearningFrom,
  type EpisodeOrigin,
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
import { readPack } from "./OperatingSystemPack.ts";
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
      personaOnly: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const Episode = Schema.Struct({ summary: Schema.String });

export interface EpisodeInput {
  readonly origin: EpisodeOrigin;
  /** Who or what it was about, as the episode names it: "with Freya", 'the job "shop README"'. */
  readonly title: string;
  readonly transcript: string;
  /**
   * Unique per episode, so it is written once. A conversation's carries the persona id
   * (`conversation:<persona id>:<first turn>-<last turn>`): P5's persona column is filled from it.
   */
  readonly sourceRef: string;
  readonly project: string | null;
  readonly tainted: boolean;
  /** When it happened (a conversation's last turn); the write time when absent. */
  readonly atMs?: number;
}

/** Kept; skipped for good (nothing worth one, a secret, already written); or to try again (the model or store failed). */
export interface EpisodeResult {
  readonly outcome: "kept" | "skip" | "retry";
  readonly item: MemoryItem | null;
}

/** A zone name Intl knows; anything else is ignored. */
const validZone = (zone: string): boolean => {
  try {
    return (
      zone.length <= 64 &&
      new Intl.DateTimeFormat("en-GB", { timeZone: zone }).resolvedOptions().timeZone !== ""
    );
  } catch {
    return false;
  }
};

/** The existing memories closest to the exchange, shown to the extractor so it can name what it replaces: this many by
 * words, and as many again by recall. */
const KNOWN_SHOWN = 8;

export interface LearnResult {
  readonly stored: number;
  readonly held: number;
  /** For a conversation's episode: whether the desktop moves on past these turns ("kept", "skip") or sends them again. */
  readonly episode?: "kept" | "skip" | "retry";
}

export class BatonMemoryLearning extends Context.Service<
  BatonMemoryLearning,
  {
    readonly learn: (input: LearnInput) => Effect.Effect<LearnResult>;
    /** MEM-18: the cheap model's two or three sentences on what happened, kept as an episode; null when nothing was kept. */
    readonly episode: (input: EpisodeInput) => Effect.Effect<EpisodeResult>;
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

  /** Every cheap-model call is counted per day and logged, so "a handful a day" (INTEGRATION.md 3.4) can be checked. */
  const countCheap = Effect.gen(function* () {
    const key = `cheap-calls:${dayOf(yield* Clock.currentTimeMillis)}`;
    const calls = Number((yield* memory.meta(key)) ?? "0") + 1;
    yield* memory.setMeta(key, String(calls));
    yield* Effect.logInfo("memory cheap calls today", { calls });
  });

  /** His zone, as the desktop last sent it; episodes and "yesterday" use his day, not the server's. */
  const zone = Effect.map(memory.meta("timeZone"), (z) => z ?? undefined);

  const result = (
    outcome: EpisodeResult["outcome"],
    item: MemoryItem | null = null,
  ): EpisodeResult => ({
    outcome,
    item,
  });
  const episode = Effect.fn("BatonMemoryLearning.episode")(function* (input: EpisodeInput) {
    const skip = result("skip");
    // VAULT.md section 1: a secret never reaches the model's prompt or the store.
    if (detectSecret(input.transcript) !== null || input.transcript.trim().length < LEARN_MIN_CHARS)
      return skip;
    const done = `episode:${input.sourceRef}`;
    if (yield* memory.flag(done)) return skip;
    yield* countCheap;
    const out = yield* oneShot
      .run({
        prompt: episodePrompt(
          input.title,
          input.transcript,
          input.origin === "conversation" ? "conversation" : "agent",
        ),
        outputSchema: Episode,
        role: "background",
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (out === null) return result("retry");
    if (out.summary.trim() === "" || detectSecret(out.summary) !== null) return skip;
    const item = yield* memory
      .add({
        kind: "episode",
        text: episodeText(
          input.atMs ?? (yield* Clock.currentTimeMillis),
          input.title,
          out.summary,
          yield* zone,
        ),
        source: input.origin === "job" ? "job" : "thread",
        sourceRef: input.sourceRef,
        ...(input.project === null ? {} : { scope: "project" as const, scopeRef: input.project }),
        tainted: input.tainted,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (item === null) return result("retry");
    // Marked only once it is kept, so a failed call is tried again with the same turns.
    yield* memory.setFlag(done, true);
    return result("kept", item);
  });

  const learn = Effect.fn("BatonMemoryLearning.learn")(function* (input: LearnInput) {
    const none: LearnResult = { stored: 0, held: 0 };
    if (input.timeZone !== undefined && validZone(input.timeZone)) {
      yield* memory.setMeta("timeZone", input.timeZone);
    }
    // A persona's conversation gone idle: its turns were learned from one by one, so this keeps only the episode.
    if (input.origin === "conversation") {
      // Only a sourceRef this server would build, for the persona that sends it, so one persona cannot write another's.
      const ref = /^conversation:([a-z0-9][a-z0-9-]{0,63}):(\d+)-(\d+)$/.exec(
        input.sourceRef ?? "",
      );
      if (ref === null || input.agent === undefined || ref[1] !== input.agent)
        return { ...none, episode: "skip" as const };
      const name = readPack(NodePath.dirname(config.dbPath)).personas.find(
        (p) => p.id === input.agent,
      )?.name;
      const at = input.at === undefined ? Number.NaN : Date.parse(input.at);
      const { outcome, item } = yield* episode({
        origin: "conversation",
        title: name === undefined ? "a conversation" : `with ${name}`,
        transcript: input.said,
        sourceRef: ref[0],
        project: input.project,
        tainted: input.tainted,
        ...(Number.isNaN(at) ? {} : { atMs: at }),
      });
      return {
        stored: item !== null && !item.proposed ? 1 : 0,
        held: item?.proposed === true ? 1 : 0,
        episode: outcome,
      };
    }
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
    yield* countCheap;
    const proposals = yield* oneShot
      .run({
        prompt: extractionPrompt(input, known),
        outputSchema: Proposals,
        role: "background",
      })
      .pipe(Effect.orElseSucceed(() => ({ items: [] })));
    // A private persona's turn keeps all it learns to itself (pack `private: true`, Memory v2 §2.3).
    const privatePersona =
      input.agent !== undefined &&
      readPack(NodePath.dirname(config.dbPath)).personas.some(
        (p) => p.id === input.agent && p.private === true,
      );
    const drafts = draftsFromProposals(proposals.items, input, yield* Clock.currentTimeMillis)
      .map((d) =>
        walled === null
          ? d
          : { ...d, draft: { ...d.draft, scope: "project" as const, scopeRef: walled } },
      )
      .map((d) =>
        privatePersona ? { ...d, draft: { ...d.draft, visibility: "persona" as const } } : d,
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

  return BatonMemoryLearning.of({ learn, episode, consolidate, rewriteNearDuplicates });
});

export const layer = Layer.effect(BatonMemoryLearning, make);
