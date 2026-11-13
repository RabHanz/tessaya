/**
 * One turn pipeline for every vessel (tessaya-ops research/MEMORY-V2-DESIGN.md §2.0). Tessaya is one agent; the
 * desktop, a desk device, the phone and the mascot are vessels. Each sends the same envelope, gets the same memory
 * for the same words and persona, and every addressed turn it carries is learned from the same way.
 */
import { memoryBlock } from "@t3tools/baton-shared/memory";
import { privatePersonOf, type SpeakerLike } from "@t3tools/baton-shared/privateMemory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BatonMemoryLearning, type LearnResult } from "./BatonMemoryLearning.ts";
import { BatonMemoryService } from "./BatonMemoryService.ts";
import { BatonPrivateMemoryService, PrivateCaller } from "./BatonPrivateMemoryService.ts";

export type VesselKind = "desktop" | "device" | "phone" | "web" | "mcp" | "job";

export interface TurnEnvelope {
  readonly vessel: { readonly kind: VesselKind; readonly id: string };
  /** What was said this turn. */
  readonly text: string;
  /** The persona answering (its pack id); its walls apply. */
  readonly persona?: string | undefined;
  readonly speaker?: SpeakerLike | null | undefined;
  /** Said to her. Absent counts as said to her until every vessel sends it. */
  readonly addressed?: boolean | undefined;
  /** The turn read outside content: what it learns waits for his yes, and nothing private is read. */
  readonly tainted?: boolean | undefined;
  /** The project the turn is about (the focused session's); other projects' items stay out. */
  readonly project?: string | null | undefined;
  /** His IANA zone, so "yesterday" is his day. */
  readonly timeZone?: string | undefined;
  /** Records which memories the turn used. */
  readonly turnRef?: string | undefined;
  /** No warm session holds the standing memory, so the turn carries it (a desk device's every turn). */
  readonly sessionless?: boolean | undefined;
  /** A replay or test of the vessel: it reads as a real turn and learns nothing. */
  readonly rehearsal?: boolean | undefined;
}

export interface TurnContext {
  /** Standing memory (sessionless vessels only), then what matches this sentence. */
  readonly block: string;
  /** The ids matched to this sentence, best first: the same for every vessel given the same words and persona. */
  readonly ids: ReadonlyArray<string>;
  /** The speaker's own private memories, only when the gate allows it; else "". */
  readonly privateBlock: string;
}

/** Standing memory a sessionless turn carries, as a session's system prompt does (MEMORY.md §5). */
const STANDING_TOKENS = 600;
/** What one sentence adds, as the desktop's per-sentence block. */
const SENTENCE_TOKENS = 300;

/** Why a turn teaches memory nothing, or null when it may. */
export const notLearnable = (turn: TurnEnvelope): string | null => {
  if (turn.addressed === false) return "not said to her";
  if (turn.rehearsal === true) return "a rehearsal";
  // Until the household model (HOUSEHOLD-DESIGN.md), only the owner or an unidentified voice teaches his store.
  const kind = turn.speaker?.kind;
  if (kind === "guest" || kind === "saved") return "not the owner's voice";
  return null;
};

export class TessayaTurn extends Context.Service<
  TessayaTurn,
  {
    /** The memory a turn is answered with, as the caller's viewer (set by its transport) may see it. */
    readonly begin: (turn: TurnEnvelope) => Effect.Effect<TurnContext>;
    /**
     * After the reply: learn from the exchange when the turn may teach (null when it may not). A spoken vessel forks
     * it; it waits on a model call.
     */
    readonly end: (
      turn: TurnEnvelope,
      done: { readonly reply: string; readonly previous?: string | null | undefined },
    ) => Effect.Effect<LearnResult | null>;
  }
>()("t3/baton/TessayaTurn") {}

export const make = Effect.gen(function* () {
  const memory = yield* BatonMemoryService;
  const learning = yield* BatonMemoryLearning;
  const stores = yield* Effect.serviceOption(BatonPrivateMemoryService);

  const privateFor = Effect.fn("TessayaTurn.private")(function* (turn: TurnEnvelope) {
    const asked = {
      route: "assistant" as const,
      typed: false,
      tainted: turn.tainted === true,
      speaker: turn.speaker ?? null,
    };
    if ("refused" in privatePersonOf(asked) || Option.isNone(stores)) return "";
    // shortcut: only a store opened for this vessel's own session is read; nothing opens one for a device yet (M2).
    const recalled = yield* stores.value.recall({ turn: asked, text: turn.text }).pipe(
      Effect.provideService(PrivateCaller, {
        session: `vessel:${turn.vessel.id}`,
        desktop: true,
      }),
      Effect.option,
    );
    return Option.isSome(recalled) ? recalled.value.block : "";
  });

  const begin = Effect.fn("TessayaTurn.begin")(function* (turn: TurnEnvelope) {
    const view = {
      ...(turn.persona === undefined ? {} : { agent: turn.persona }),
      ...(turn.timeZone === undefined ? {} : { timeZone: turn.timeZone }),
      ...(turn.project === undefined ? {} : { scopeRef: turn.project }),
    };
    const standing =
      turn.sessionless === true
        ? memoryBlock(yield* memory.related(view), STANDING_TOKENS)
        : { block: "", ids: [] };
    const ranked = yield* memory.related({ ...view, text: turn.text });
    // The ids are the sentence's own ranking, the same for every vessel; the text leaves out what standing holds.
    const sentence = memoryBlock(ranked, SENTENCE_TOKENS);
    const held = new Set(standing.ids);
    const extra = memoryBlock(
      ranked.filter((i) => !held.has(i.id)),
      SENTENCE_TOKENS,
    ).block;
    if (turn.turnRef !== undefined && sentence.ids.length > 0)
      yield* memory.markUsed(turn.turnRef, sentence.ids);
    return {
      block: [standing.block, extra].filter((b) => b !== "").join("\n\n"),
      ids: sentence.ids,
      privateBlock: yield* privateFor(turn),
    };
  });

  const end = Effect.fn("TessayaTurn.end")(function* (
    turn: TurnEnvelope,
    done: { readonly reply: string; readonly previous?: string | null | undefined },
  ) {
    if (notLearnable(turn) !== null) return null;
    return yield* learning.learn({
      origin: "turn",
      said: turn.text,
      reply: done.reply,
      sourceRef: `vessel:${turn.vessel.kind}:${turn.vessel.id}${turn.turnRef === undefined ? "" : `:${turn.turnRef}`}`,
      tainted: turn.tainted === true,
      project: turn.project ?? null,
      previous: done.previous ?? null,
      ...(turn.persona === undefined ? {} : { agent: turn.persona }),
      ...(turn.timeZone === undefined ? {} : { timeZone: turn.timeZone }),
    });
  });

  return TessayaTurn.of({ begin, end });
});

export const layer = Layer.effect(TessayaTurn, make);
