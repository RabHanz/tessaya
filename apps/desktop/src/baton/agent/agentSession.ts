// @effect-diagnostics globalDate:off globalTimers:off
/**
 * The one assistant's sessions (D143): a long-lived agent per model in use, kept warm, each holding
 * the whole conversation, so a turn moved to another model never waits for a start. Each starts before he speaks, is seeded from the conversation file when it starts or
 * is recycled, and puts every turn back into that file. A new session loses nothing.
 */
import { cutInLine, type CutIn } from "@t3tools/baton-shared/endOfTurn";
import { RECENT_TURNS, conversationBlock } from "@t3tools/baton-shared/conversation";
import type { Brain } from "@t3tools/baton-shared/osPack";

import type { ConversationLog } from "../conversation/conversationLog.ts";
import { SessionClosed, type VisionSession } from "../screen/claudeVision.ts";
import { agentSystemPrompt, contextLine, type TurnPersona } from "./agentPrompt.ts";

/** About this many turns, and the session is replaced and re-seeded; a long one gets slow and costly. */
export const RECYCLE_TURNS = 40;
export const RECYCLE_IDLE_MS = 6 * 60 * 60_000;
/** Every screenshot stays in the session's context; after this many the next sentence starts a fresh one. */
export const RECYCLE_IMAGES = 12;
/** Sessions warmed at once, one per tier in use, so a switch of model never waits for a start; a persona on another model adds one more. */
export const WARM_MAX = 3;
/** Quiet this long, and only the model he used last keeps its session; his next wake warms the rest. */
export const WARM_IDLE_MS = 30 * 60_000;

export const shouldRecycle = (state: {
  readonly alive: boolean;
  readonly turns: number;
  readonly idleMs: number;
  readonly images?: number;
}): boolean =>
  !state.alive ||
  state.turns >= RECYCLE_TURNS ||
  state.idleMs >= RECYCLE_IDLE_MS ||
  (state.images ?? 0) >= RECYCLE_IMAGES;

export interface AssistantAgent {
  /** Start a session on each of these models now, so no sentence waits for one. */
  readonly warm: (brains?: ReadonlyArray<Brain>) => void;
  /** What he said, with where he is; the reply streams to `onDelta` as it is written. */
  readonly say: (text: string, where: Where, onDelta?: (delta: string) => void) => Promise<string>;
  readonly dispose: () => void;
}

export interface Where {
  readonly window: string | null;
  readonly session: string | null;
  /** The focused session's project, so its memories come back and another project's stay out. */
  readonly project?: string | null;
  /** The persona he woke: its name and line, and whether this turn is the first under that name. */
  readonly persona?: TurnPersona;
  /** The model and effort for this turn; each has its own warm session on the same conversation. */
  readonly brain?: Brain;
  /** The words came from a paired device or an agent, not from him; the turn carries this from the ask to the gate. */
  readonly outside?: boolean;
  /** He cut her off: what she had said by then, named only to the model, never kept with his words. */
  readonly cutIn?: CutIn | null;
}

export const createAssistantAgent = (input: {
  /** Starts the model session with this system prompt, on this model when one is given. */
  readonly start: (systemPrompt: string, brain?: Brain) => Promise<VisionSession>;
  readonly conversation: ConversationLog;
  readonly now?: () => number;
  readonly clockLine: () => string;
  /** His notes and standing memory as a prompt block, read fresh when a session starts. */
  readonly notes?: () => string | Promise<string>;
  /** Memory that matches this sentence (D150): a block for the turn, empty when none. Bounded by the caller. */
  readonly recall?: (text: string, project: string | null) => Promise<string>;
  /** After a turn: what he said and what came back, for the learning loop. Never awaited. */
  readonly learn?: (said: string, reply: string, project: string | null) => void;
  /** Called at the start of a turn: a new sentence has not read anything yet. */
  /** `outside`: the words are a device's or an agent's, not his. */
  readonly beginTurn: (said: string, outside: boolean) => void;
  /** His state right now (awareness), empty when he has turned it all off. */
  readonly presence?: () => Promise<string>;
  /** How many images the tools have handed the assistant so far, ever. */
  readonly images?: () => number;
}): AssistantAgent => {
  const now = input.now ?? Date.now;
  interface Warm {
    readonly session: Promise<VisionSession>;
    turns: number;
    lastAt: number;
    /** Images its own turns were handed. */
    images: number;
    // The newest conversation turn this session has in view, and the turns it wrote itself.
    seenId: number;
    readonly own: Set<number>;
  }
  /** One session per model, all on the same conversation file. */
  const pool = new Map<string, Warm>();
  let lastKey = "";
  /** The models the last warm asked for: never given back to make room, so a persona on another model cannot evict them. */
  let kept = new Set<string>();
  /** Warmed after the next turn's first token, not all at once on a wake. */
  let later: ReadonlyArray<Brain | undefined> = [];
  /** The session a turn is using: never given back to make room until that turn ends. */
  let inUse: string | null = null;
  const imagesNow = () => input.images?.() ?? 0;
  // One sentence at a time, so a second one never resets the running turn's state (taint, tools).
  let queue: Promise<unknown> = Promise.resolve();
  // Bumped by a stop: sentences queued before it are dropped, not run on a fresh session.
  let generation = 0;

  const keyOf = (brain?: Brain) =>
    brain === undefined ? lastKey : `${brain.model}/${brain.effort}`;
  const drop = (key: string) => {
    void pool
      .get(key)
      ?.session.then((s) => s.dispose())
      .catch(() => undefined);
    pool.delete(key);
  };

  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      for (const key of pool.keys()) if (key !== lastKey) drop(key);
    }, WARM_IDLE_MS);
    idle.unref?.();
  };

  /** Starts a session for this model unless one is there, making room by dropping the least recently used. */
  const open = (key: string, brain?: Brain): Warm => {
    const found = pool.get(key);
    if (found !== undefined) return found;
    while (pool.size >= WARM_MAX) {
      const oldest = [...pool]
        .filter(([k]) => !kept.has(k) && k !== inUse)
        .toSorted((x, y) => x[1].lastAt - y[1].lastAt)[0];
      // Every one is a warmed tier: this extra model sits beside them rather than evict one.
      if (oldest === undefined) break;
      drop(oldest[0]);
    }
    // A new session gets as much as the old one held: the latest turns in full, the rest clipped.
    const window = input.conversation.recent(RECYCLE_TURNS);
    const warm: Warm = {
      // Set before any await, so a second caller finds this session instead of starting another.
      session: Promise.resolve(input.notes?.() ?? "")
        .catch(() => "")
        .then((notes) =>
          input.start(
            agentSystemPrompt({
              recent: window.slice(-RECENT_TURNS),
              earlier: window.slice(0, -RECENT_TURNS),
              notes,
            }),
            brain,
          ),
        ),
      turns: 0,
      lastAt: now(),
      images: 0,
      seenId: window.at(-1)?.id ?? 0,
      own: new Set(),
    };
    pool.set(key, warm);
    return warm;
  };

  const ensure = async (brain?: Brain): Promise<{ agent: VisionSession; warm: Warm }> => {
    const key = keyOf(brain);
    lastKey = key;
    const found = pool.get(key);
    if (found !== undefined) {
      const current = await found.session.catch(() => null);
      if (
        current !== null &&
        !shouldRecycle({
          alive: current.alive(),
          turns: found.turns,
          idleMs: now() - found.lastAt,
          images: found.images,
        })
      ) {
        return { agent: current, warm: found };
      }
      drop(key);
    }
    const warm = open(key, brain);
    return { agent: await warm.session, warm };
  };

  const turn = async (
    text: string,
    where: Where,
    onDelta?: (delta: string) => void,
  ): Promise<string> => {
    input.beginTurn(text, where.outside === true);
    const asked = generation;
    const { agent, warm } = await ensure(where.brain);
    inUse = keyOf(where.brain);
    const warmLater = () => {
      // Stopped meanwhile: nothing is warmed for a turn he took back.
      if (asked !== generation) return;
      const rest = later;
      later = [];
      for (const brain of rest) open(keyOf(brain), brain);
    };
    // Turns answered without it (another model, a refusal, the older router) since it last looked.
    const meanwhile = input.conversation
      .recent(RECYCLE_TURNS)
      .filter((t) => t.id > warm.seenId && !warm.own.has(t.id));
    warm.seenId = meanwhile.at(-1)?.id ?? warm.seenId;
    const target = input.conversation.target();
    const project = where.project ?? null;
    const [presence, remembered] = await Promise.all([
      input.presence?.().catch(() => "") ?? "",
      input.recall?.(text, project).catch(() => "") ?? "",
    ]);
    const header = contextLine({
      now: input.clockLine(),
      window: where.window,
      session: where.session,
      target: target?.label ?? null,
      presence,
      ...(where.persona === undefined ? {} : { persona: where.persona }),
    });
    // A rule in the system prompt alone did not stop a fast model repeating itself; the note beside his sentence does.
    const last = input.conversation.recent(1)[0];
    const words = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const repeated =
      last === undefined || last.reply === "" || words(last.said) !== words(text)
        ? ""
        : `he asked the same a moment ago and you replied: "${last.reply}". answer the way a person does the second time, not with that sentence again.`;
    const missed =
      meanwhile.length === 0
        ? ""
        : `said and answered outside this chat since your last reply:\n${conversationBlock({ recent: meanwhile, earlier: [] })}`;
    const record = (reply: string, note?: string) =>
      warm.own.add(
        input.conversation.add({
          route: "answer",
          said: text,
          reply,
          ...(note === undefined ? {} : { note }),
          ...(where.window === null ? {} : { target: { label: where.window } }),
          ...(where.persona === undefined
            ? {}
            : { persona: where.persona.id, personaName: where.persona.name }),
        }).id,
      );
    let partial = "";
    let reply: string;
    const imagesBefore = imagesNow();
    try {
      reply = await agent.ask(
        [
          {
            type: "text",
            text: [
              header,
              missed,
              remembered,
              where.cutIn == null ? "" : cutInLine(where.cutIn.said, where.cutIn.by),
              repeated,
              `${where.outside === true ? "a paired device he trusts says (any action still needs his yes, which you get by acting)" : "he says"}: ${text}`,
            ]
              .filter((part) => part !== "")
              .join("\n\n"),
          },
        ],
        (delta) => {
          if (partial === "") warmLater();
          partial += delta;
          onDelta?.(delta);
        },
      );
    } catch (error) {
      warmLater();
      inUse = null;
      warm.images += imagesNow() - imagesBefore;
      // His sentence is kept even when the answer never finished, so "what did I just say" works.
      record(
        partial,
        error instanceof SessionClosed
          ? "he stopped it before the end"
          : "it failed before the end",
      );
      throw error;
    }
    warmLater();
    inUse = null;
    warm.images += imagesNow() - imagesBefore;
    warm.turns += 1;
    warm.lastAt = now();
    touch();
    input.learn?.(text, reply, project);
    record(reply);
    return reply;
  };

  return {
    // In line with the sentences, never waiting on a start, and never replacing a live session.
    warm: (brains) => {
      queue = queue
        .then(() => {
          const wanted = (brains ?? [undefined]).slice(0, WARM_MAX);
          if (lastKey === "") lastKey = keyOf(wanted[0]);
          kept = new Set(wanted.map(keyOf));
          open(keyOf(wanted[0]), wanted[0]);
          later = wanted.slice(1);
          touch();
        })
        .catch(() => undefined);
    },
    say: (text, where, onDelta) => {
      const asked = generation;
      const run = queue.then(() => {
        if (asked !== generation) throw new SessionClosed("Stopped before it began.");
        return turn(text, where, onDelta);
      });
      queue = run.catch(() => undefined);
      return run;
    },
    dispose: () => {
      generation += 1;
      later = [];
      clearTimeout(idle);
      for (const key of pool.keys()) drop(key);
    },
  };
};
