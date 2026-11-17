// @effect-diagnostics nodeBuiltinImport:off
/**
 * Her standing understanding (VOXTA-STUDY G4): one per person, by their people-graph or member id, and one of herself
 * per persona, each rewrite a new memory item superseding the last, run only once evidence has gathered. A fact is
 * forgotten one at a time, confirmed: its wordings leave every version and wait, restorable, in a bin for the people
 * bin's days, and no rewrite may write it back.
 */
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import {
  earlierLine,
  EVIDENCE_PER_REWRITE,
  factLines,
  findFact,
  nextUnderstanding,
  understandingPrompt,
  UnderstandingRewrite,
} from "@t3tools/tessaya-shared/understanding";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { TessayaMemoryService } from "./TessayaMemoryService.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { readBinDays, TessayaPeople } from "./TessayaPeople.ts";
import { emitAction, type TurnAction } from "./turnActions.ts";

/** A person by their people-graph or member id, or herself as one persona (unset is the lead). */
export type UnderstandingSubject =
  | { readonly about: "person"; readonly id: string }
  | { readonly about: "self"; readonly persona: string | undefined };

/** Evidence lines held per subject; older ones drop first. */
const HELD = 6;
const DAY_MS = 86_400_000;

/** A forget or restore's answer, in the people graph's shape: "asked" wants a clear yes before anything changes. */
export interface FactAnswer {
  readonly status: "asked" | "done" | "refused";
  readonly line: string;
}
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const shown = (fact: string) => fact.replace(/^\s*-\s*/, "");

export class TessayaUnderstanding extends Context.Service<
  TessayaUnderstanding,
  {
    /** The current understanding's text, or null when there is none yet. */
    readonly current: (subject: UnderstandingSubject) => Effect.Effect<string | null>;
    /**
     * New evidence (their words, or for herself a correction of her) with its cause (the turn's ref). Held until
     * enough has gathered, then one rewrite; callers fork it.
     */
    readonly evidence: (
      subject: UnderstandingSubject,
      said: string,
      cause: string,
    ) => Effect.Effect<void>;
    /** One fact forgotten, by its words: said back first, then into the bin with `confirmed`. Every other fact stays. */
    readonly forget: (
      subject: UnderstandingSubject,
      fact: string,
      options: { readonly actor: TurnAction["actor"]; readonly confirmed?: boolean | undefined },
    ) => Effect.Effect<FactAnswer>;
    /** A fact from the bin back into the current understanding. */
    readonly restore: (
      subject: UnderstandingSubject,
      fact: string,
      options: { readonly actor: TurnAction["actor"] },
    ) => Effect.Effect<FactAnswer>;
  }
>()("t3/tessaya/TessayaUnderstanding") {}

export const make = Effect.gen(function* () {
  const memory = yield* TessayaMemoryService;
  const oneShot = yield* Effect.serviceOption(TessayaOneShot);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const people = yield* Effect.serviceOption(TessayaPeople);
  const sql = yield* SqlClient.SqlClient;
  const binDays = Effect.provideService(readBinDays, SqlClient.SqlClient, sql);
  const lock = yield* Semaphore.make(1);
  // shortcut: held in memory, so a restart drops evidence short of a rewrite; persist it if that loses too much.
  const held = new Map<string, Array<{ readonly said: string; readonly cause: string }>>();

  const refOf = (subject: UnderstandingSubject) => {
    if (subject.about === "person") return `person:${subject.id}`;
    const { personas } = Option.isNone(config)
      ? DEFAULT_OS_PACK
      : readPack(NodePath.dirname(config.value.dbPath));
    const face =
      personas.find((p) => p.id === subject.persona) ?? personas.find((p) => p.lead) ?? personas[0];
    return `self:${face?.id ?? "lead"}`;
  };

  const versions = (ref: string, includeSuperseded: boolean) =>
    memory
      .list({ kinds: ["understanding"], scope: "person", includeSuperseded, limit: 100_000 })
      .pipe(Effect.map((items) => items.filter((i) => i.scopeRef === ref)));

  const currentItem = (ref: string) =>
    Effect.map(versions(ref, false), (items) => items[0] ?? null);

  /** The current version, then each one it was rewritten from, newest first, by the supersede chain. */
  const lineage = (ref: string) =>
    Effect.map(versions(ref, true), (items) => {
      const chain: Array<(typeof items)[number]> = [];
      for (
        let at = items.find((i) => i.supersededBy === null);
        at !== undefined && chain.length < items.length;
        at = items.find((i) => i.supersededBy === at!.id)
      )
        chain.push(at);
      return chain;
    });

  const binned = (ref: string) =>
    sql<{ id: string; fact: string }>`
      SELECT id, fact FROM tessaya_understanding_bin WHERE scope_ref = ${ref} ORDER BY at
    `.pipe(Effect.orDie);

  const personaOf = (subject: UnderstandingSubject, ref: string) =>
    subject.about === "self" ? { persona: ref.slice("self:".length) } : {};

  const store = (subject: UnderstandingSubject, ref: string, text: string, cause: string) =>
    memory.add({
      kind: "understanding",
      text,
      source: "thread",
      sourceRef: cause,
      scope: "person",
      scopeRef: ref,
      ...personaOf(subject, ref),
    });

  const rewrite = Effect.fn("TessayaUnderstanding.rewrite")(function* (
    subject: UnderstandingSubject,
    ref: string,
    evidence: ReadonlyArray<{ readonly said: string; readonly cause: string }>,
  ) {
    if (Option.isNone(oneShot)) return;
    const old = yield* currentItem(ref);
    const earlier = (yield* versions(ref, true))
      .filter((i) => i.supersededBy !== null)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((i) => ({ at: i.createdAt.slice(0, 10), text: i.text }));
    const forgotten = (yield* binned(ref)).map((b) => b.fact);
    const answer = yield* oneShot.value.run({
      prompt: understandingPrompt({
        about: subject.about,
        current: old?.text ?? null,
        evidence: evidence.map((e) => e.said),
        earlier,
        forgotten,
      }),
      outputSchema: UnderstandingRewrite,
      role: "consolidation",
      feature: "understanding",
    });
    const next = nextUnderstanding(old?.text ?? null, answer, forgotten);
    if (next === null) return;
    const cause = [...new Set(evidence.map((e) => e.cause))].join(", ").slice(0, 300);
    const item = yield* store(subject, ref, next.text, cause);
    if (old !== null) yield* memory.supersede(old.id, item.id);
    // Provenance (origin, actor, cause, evidence) for the write and the supersede, in the action log's shape.
    yield* emitAction({
      kind: old === null ? "understanding.write" : "understanding.supersede",
      actor: { kind: "persona", certainty: 0.7 },
      evidence: evidence.map((e) => ({ kind: "turn", ref: e.cause })),
      ...personaOf(subject, ref),
      subject: ref,
      outcome: item.id,
      data: { origin: memory.origin, supersedes: old?.id ?? null, changes: next.changes },
    });
  });

  // Forget and restore hold the rewrite's lock, so neither reads a version a rewrite is replacing.
  const forget = Effect.fn("TessayaUnderstanding.forget")(function* (
    subject: UnderstandingSubject,
    fact: string,
    options: { readonly actor: TurnAction["actor"]; readonly confirmed?: boolean | undefined },
  ) {
    const ref = refOf(subject);
    const chain = yield* lineage(ref);
    const lines = chain.map((i) => factLines(i.text));
    const at = chain[0] === undefined ? null : findFact(chain[0].text, fact);
    if (at === null)
      return {
        status: "refused",
        line: `Nothing I understand of ${subject.about === "self" ? "myself" : "you"} says that. Say it the way I have it.`,
      } satisfies FactAnswer;
    const line = lines[0]![at]!;
    const days = yield* binDays;
    if (options.confirmed !== true)
      return {
        status: "asked",
        line: `Forget that ${shown(line)}? It can be put back for ${days} days. Ask for a clear yes, then call again with confirmed.`,
      } satisfies FactAnswer;
    // Its earlier wordings, traced back version by version: each version loses that one line and keeps the rest.
    for (let v = 0, i: number | null = at; v < chain.length && i !== null; v++) {
      const drop: number = i;
      i = v + 1 < chain.length ? earlierLine(lines[v]!, lines[v + 1]!, drop) : null;
      yield* memory.overwrite(chain[v]!.id, lines[v]!.filter((_, n) => n !== drop).join("\n"));
    }
    const id = NodeCrypto.randomUUID();
    yield* sql`
      INSERT INTO tessaya_understanding_bin (id, scope_ref, fact, at, by)
      VALUES (${id}, ${ref}, ${line}, ${isoAt(yield* Clock.currentTimeMillis)}, ${options.actor.kind})
    `.pipe(Effect.orDie);
    yield* emitAction({
      kind: "understanding.forget",
      actor: options.actor,
      ...personaOf(subject, ref),
      subject: ref,
      outcome: id,
      data: { origin: memory.origin, binDays: days },
    });
    return {
      status: "done",
      line: `Forgotten. It can be put back for ${days} days.`,
    } satisfies FactAnswer;
  }, lock.withPermits(1));

  const restore = Effect.fn("TessayaUnderstanding.restore")(function* (
    subject: UnderstandingSubject,
    fact: string,
    options: { readonly actor: TurnAction["actor"] },
  ) {
    const ref = refOf(subject);
    const bin = yield* binned(ref);
    const at = findFact(bin.map((b) => b.fact).join("\n"), fact);
    const back = at === null ? undefined : bin[at];
    if (back === undefined)
      return {
        status: "refused",
        line: "That isn't among what I was asked to forget lately.",
      } satisfies FactAnswer;
    const old = yield* currentItem(ref);
    if (old === null) yield* store(subject, ref, back.fact, "restored").pipe(Effect.orDie);
    else yield* memory.overwrite(old.id, `${old.text.trim()}\n${back.fact}`);
    yield* sql`DELETE FROM tessaya_understanding_bin WHERE id = ${back.id}`.pipe(Effect.orDie);
    yield* emitAction({
      kind: "understanding.restore",
      actor: options.actor,
      ...personaOf(subject, ref),
      subject: ref,
      outcome: back.id,
      data: { origin: memory.origin },
    });
    return { status: "done", line: `Put back: ${shown(back.fact)}.` } satisfies FactAnswer;
  }, lock.withPermits(1));

  /** Past the bin's days a forgotten fact is gone for good, as a forgotten person is. */
  const sweep = Effect.gen(function* () {
    const before = isoAt((yield* Clock.currentTimeMillis) - (yield* binDays) * DAY_MS);
    const due = yield* sql<{ id: string; scope_ref: string }>`
      SELECT id, scope_ref FROM tessaya_understanding_bin WHERE at <= ${before}
    `;
    yield* sql`DELETE FROM tessaya_understanding_bin WHERE at <= ${before}`;
    for (const d of due)
      yield* emitAction({
        kind: "understanding.purge",
        actor: { kind: "system", certainty: 1 },
        subject: d.scope_ref,
        outcome: d.id,
      });
  }).pipe(Effect.orDie, Effect.withSpan("TessayaUnderstanding.sweep"));
  yield* sweep.pipe(
    Effect.catchCause((cause) => Effect.logWarning("understanding bin sweep failed", cause)),
    Effect.repeat(Schedule.spaced("6 hours")),
    Effect.forkScoped({ startImmediately: true }),
  );

  // The people graph's forget is the one wholesale removal: every version of their understanding goes with them.
  // shortcut: a merge (`into`) leaves the merged id's understanding behind; carry it over if merges get common.
  if (Option.isSome(people))
    yield* people.value.forgotten.pipe(
      Stream.runForEach(({ id, into }) =>
        into !== undefined
          ? Effect.void
          : Effect.flatMap(versions(`person:${id}`, true), (items) =>
              Effect.forEach(items, (i) => memory.overwrite(i.id, ""), { discard: true }).pipe(
                Effect.andThen(
                  sql`DELETE FROM tessaya_understanding_bin WHERE scope_ref = ${`person:${id}`}`.pipe(
                    Effect.orDie,
                  ),
                ),
              ),
            ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

  return TessayaUnderstanding.of({
    current: Effect.fn("TessayaUnderstanding.current")(function* (subject) {
      return (yield* currentItem(refOf(subject)))?.text ?? null;
    }),
    evidence: Effect.fn("TessayaUnderstanding.evidence")(function* (subject, said, cause) {
      if (said.trim() === "") return;
      const ref = refOf(subject);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const mine = [...(held.get(ref) ?? []), { said: said.trim(), cause }].slice(-HELD);
          const due = (yield* currentItem(ref)) === null ? 1 : EVIDENCE_PER_REWRITE;
          if (mine.length < due) {
            held.set(ref, mine);
            return;
          }
          held.delete(ref);
          yield* rewrite(subject, ref, mine).pipe(
            Effect.catchCause((why) =>
              Effect.logDebug("understanding: not rewritten", { why: String(why) }),
            ),
          );
        }),
      );
    }),
    forget,
    restore,
  });
});

export const layer = Layer.effect(TessayaUnderstanding, make);
