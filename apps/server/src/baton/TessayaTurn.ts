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
import { BatonMemoryRefusedError } from "@t3tools/baton-contracts";
import { BatonMemoryService } from "./BatonMemoryService.ts";
import { BatonPrivateMemoryService, PrivateCaller } from "./BatonPrivateMemoryService.ts";
import { TurnPools } from "./TurnPools.ts";

export type VesselKind = "desktop" | "device" | "phone" | "web" | "mcp" | "job";

export interface TurnEnvelope {
  readonly vessel: { readonly kind: VesselKind; readonly id: string };
  /** How approvals, replies and the Record name the vessel that heard it ("R1", "desktop", "phone"). */
  readonly origin?: string | undefined;
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

/** His own voice on this very turn: the only voice whose words are kept as his, or that may forget for him. */
const hisVoice = (speaker: SpeakerLike | null) =>
  speaker !== null && speaker.kind === "owner" && speaker.verified && !speaker.inherited;

/** The vessel that heard the turn, for every tool it calls: a tool reads it to name where a request came from. */
export const TurnOrigin = Context.Reference<{
  readonly kind: VesselKind;
  readonly id: string;
  readonly label: string;
  /**
   * His own voice, verified on this turn's audio (identity design A2): his yes for what the turn asks, and his words.
   * False for any other voice, an unverified one, or one carried over from an earlier turn.
   */
  readonly hisVoice?: boolean;
  /** Who spoke, so a tool that writes for him knows whose words they are. */
  readonly speaker?: SpeakerLike | null;
  readonly persona?: string | null;
  /** A replay or test of the vessel: its writes are dry runs. */
  readonly rehearsal?: boolean;
} | null>("t3/baton/TessayaTurn/TurnOrigin", { defaultValue: () => null });

/** The origin a turn's tool calls run under. */
export const originOf = (turn: TurnEnvelope) => ({
  ...turn.vessel,
  label: turn.origin ?? turn.vessel.kind,
  hisVoice: hisVoice(turn.speaker ?? null),
  speaker: turn.speaker ?? null,
  persona: turn.persona ?? null,
  rehearsal: turn.rehearsal === true,
});

/** Forget's answer to any voice but his verified one, also what a replay hears (it is never verified). */
export const NOT_HIS_VOICE_TO_FORGET =
  "I can forget that only when I know it's your voice. You can forget it in Memory on your desktop or phone.";

/** What `remember` did, in words she can say. */
export interface Remembered {
  readonly kept: "his" | "noted" | "held" | "rehearsal";
  readonly id: string | null;
  readonly line: string;
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
    /**
     * "Remember this", from any vessel or agent. His verified voice keeps it as his words; a voice not yet known
     * keeps it as a note she was told (like what she learns); a guest's or another person's is refused; an agent
     * outside a turn proposes it, held for his yes.
     */
    readonly remember: (text: string) => Effect.Effect<Remembered, BatonMemoryRefusedError>;
    /** Forgets by id, only for his verified voice; otherwise says where he can. */
    readonly forget: (id: string) => Effect.Effect<string>;
    /** "What do you know about X": the memories closest to it, best first, his words marked, at most `limit`. */
    readonly about: (
      subject: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly line: string }>>;
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
  const pools = yield* Effect.serviceOption(TurnPools);

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
    const learn = learning.learn({
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
    // Learning is background work: one model call at a time across every vessel, behind any spoken turn.
    return yield* Option.isNone(pools)
      ? learn
      : pools.value.run("learn", { vessel: turn.vessel.id, class: "background" }, learn);
  });

  const remember = Effect.fn("TessayaTurn.remember")(function* (text: string) {
    const origin = yield* TurnOrigin;
    if (origin?.rehearsal === true)
      return {
        kept: "rehearsal" as const,
        id: null,
        line: "Kept.",
      };
    const kind = origin?.speaker?.kind;
    if (kind === "guest" || kind === "saved")
      return yield* new BatonMemoryRefusedError({
        reason: "I can only keep things in his memory for him. Ask him to tell me.",
      });
    const his = origin?.hisVoice === true;
    const item = yield* memory.add({
      kind: "note",
      text: text.trim(),
      source: his ? "user" : "thread",
      sourceRef: origin === null ? "agent" : `vessel:${origin.kind}:${origin.id}`,
      // An agent outside a turn only proposes; he says yes in Memory.
      ...(origin === null ? { tainted: true } : {}),
    });
    return item.proposed
      ? { kept: "held" as const, id: item.id, line: "Noted; it waits for his yes in Memory." }
      : his
        ? { kept: "his" as const, id: item.id, line: "Kept." }
        : {
            kept: "noted" as const,
            id: item.id,
            line: "Kept.",
          };
  });

  const forget = Effect.fn("TessayaTurn.forget")(function* (id: string) {
    const origin = yield* TurnOrigin;
    if (origin === null || origin.hisVoice !== true) return NOT_HIS_VOICE_TO_FORGET;
    if (origin.rehearsal === true) return "Forgotten.";
    return (yield* memory.forget(id)) ? "Forgotten." : "There is no memory by that id.";
  });

  const about = Effect.fn("TessayaTurn.about")(function* (subject: string, limit = 8) {
    const origin = yield* TurnOrigin;
    const ranked = yield* memory.related({
      text: subject,
      ...(origin?.persona == null ? {} : { agent: origin.persona }),
    });
    return ranked.slice(0, limit).map((item) => ({
      id: item.id,
      line: `${item.text} (${item.source === "user" ? "his words" : `${item.kind}, ${Math.round(item.confidence * 100)}%`}, ${item.updatedAt.slice(0, 10)})`,
    }));
  });

  return TessayaTurn.of({ begin, end, remember, forget, about });
});

export const layer = Layer.effect(TessayaTurn, make);
