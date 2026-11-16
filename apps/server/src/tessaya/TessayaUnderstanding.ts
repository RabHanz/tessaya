// @effect-diagnostics nodeBuiltinImport:off
/**
 * Her standing understanding (VOXTA-STUDY G4): one per person, by their people-graph or member id, and one of herself
 * per persona. Each is one memory item of kind `understanding`; a rewrite is a new item that supersedes the last, so
 * every earlier wording stays with its date and nothing is deleted except by the people graph's forget. The cheap
 * rewrite runs only when evidence has gathered, never on every turn.
 */
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import {
  EVIDENCE_PER_REWRITE,
  nextUnderstanding,
  understandingPrompt,
  UnderstandingRewrite,
} from "@t3tools/tessaya-shared/understanding";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { TessayaMemoryService } from "./TessayaMemoryService.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { TessayaPeople } from "./TessayaPeople.ts";
import { emitAction } from "./turnActions.ts";

/** A person by their people-graph or member id, or herself as one persona (unset is the lead). */
export type UnderstandingSubject =
  | { readonly about: "person"; readonly id: string }
  | { readonly about: "self"; readonly persona: string | undefined };

/** Evidence lines held per subject; older ones drop first. */
const HELD = 6;

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
  }
>()("t3/tessaya/TessayaUnderstanding") {}

export const make = Effect.gen(function* () {
  const memory = yield* TessayaMemoryService;
  const oneShot = yield* Effect.serviceOption(TessayaOneShot);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const people = yield* Effect.serviceOption(TessayaPeople);
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
    const answer = yield* oneShot.value.run({
      prompt: understandingPrompt({
        about: subject.about,
        current: old?.text ?? null,
        evidence: evidence.map((e) => e.said),
        earlier,
      }),
      outputSchema: UnderstandingRewrite,
      role: "consolidation",
      feature: "understanding",
    });
    const next = nextUnderstanding(old?.text ?? null, answer);
    if (next === null) return;
    const cause = [...new Set(evidence.map((e) => e.cause))].join(", ").slice(0, 300);
    const item = yield* memory.add({
      kind: "understanding",
      text: next.text,
      source: "thread",
      sourceRef: cause,
      scope: "person",
      scopeRef: ref,
      ...(subject.about === "self" ? { persona: ref.slice("self:".length) } : {}),
    });
    if (old !== null) yield* memory.supersede(old.id, item.id);
    // Provenance (origin, actor, cause, evidence) for the write and the supersede, in the action log's shape.
    yield* emitAction({
      kind: old === null ? "understanding.write" : "understanding.supersede",
      actor: { kind: "persona", certainty: 0.7 },
      evidence: evidence.map((e) => ({ kind: "turn", ref: e.cause })),
      ...(subject.about === "self" ? { persona: ref.slice("self:".length) } : {}),
      subject: ref,
      outcome: item.id,
      data: { origin: memory.origin, supersedes: old?.id ?? null, changes: next.changes },
    });
  });

  // The people graph's forget is the one real removal: every version of their understanding goes with them.
  // shortcut: a merge (`into`) leaves the merged id's understanding behind; carry it over if merges get common.
  if (Option.isSome(people))
    yield* people.value.forgotten.pipe(
      Stream.runForEach(({ id, into }) =>
        into !== undefined
          ? Effect.void
          : Effect.flatMap(versions(`person:${id}`, true), (items) =>
              Effect.forEach(items, (i) => memory.forget(i.id), { discard: true }),
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
  });
});

export const layer = Layer.effect(TessayaUnderstanding, make);
