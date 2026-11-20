// @effect-diagnostics globalJsonInEffect:off
/**
 * The one turn with tools, for every vessel (tessaya-ops research/SPINE-UNIFY.md): the vessel reads what is around it
 * and brings its own hands; the brain reads his work, picks the route and Opus, speaks her sentences and learns. A
 * vessel's adapter (the R1's chat route today) only gathers, holds and finishes.
 */
import {
  ESCALATION_CARRY_MS,
  ESCALATION_KINDS,
  LONG_REQUEST_WORDS,
  escalationDecision,
  escalationRulesLine,
  type EscalationAsk,
} from "@t3tools/tessaya-shared/brainEscalation";
import { firstClause, isNarration, withoutSelfIntro } from "@t3tools/tessaya-shared/narration";
import { CONVERSATION_END, REST_MARK } from "@t3tools/tessaya-shared/stopPhrases";
import { plainExpression } from "@t3tools/tessaya-shared/expression";
import { clockAsk } from "@t3tools/tessaya-shared/turnTier";
import { toneOf } from "@t3tools/tessaya-shared/expressionMap";
import type { AffectVariant } from "@t3tools/tessaya-contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { R1Brain, RoomTool, RoomToolSet, ToolOutcome, ToolTurn } from "../home/R1Brain.ts";
import type { SessionSpec } from "../home/VoiceSessions.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  TurnOrigin,
  conversationKey,
  moodMember,
  originOf,
  type TurnEnvelope,
} from "./TessayaTurn.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { expressOr } from "./TessayaExpression.ts";
import { TurnPools } from "./TurnPools.ts";
import { turnSkills } from "./TurnSkills.ts";

/** What one thing she did came to, as the vessel reports it. */
export interface ActOutcome {
  readonly ok: boolean;
  readonly status: string;
  readonly line: string;
}

/** One tool call of a turn, as the tool suite reads it back (a replay's `trace`). */
export interface RoomCall {
  readonly name: string;
  readonly input: unknown;
  readonly isError: boolean;
  readonly status?: string;
  readonly text: string;
}

/** The most of one tool's answer her turn reads: a whole device report came back "too large to read" (18 Nov). */
export const TOOL_TEXT_MAX = 8_000;
export const capToolText = (o: ToolOutcome): ToolOutcome =>
  o.text.length <= TOOL_TEXT_MAX
    ? o
    : {
        ...o,
        text: `${o.text.slice(0, TOOL_TEXT_MAX)}\n[cut: ${o.text.length - TOOL_TEXT_MAX} more characters. Ask for one item or one device for the rest.]`,
      };
/** His work's reads before the model starts take 20-180 ms; past this they wait for nobody. */
const WORK_READ_MS = 300;
/**
 * A turn this soon after a read of his work uses that read while a fresh one runs: one in three turns waited the full
 * 300 ms on a slow read (15 Nov). shortcut: held in this server's memory per tool set, tool and vessel; starts cold.
 */
const WORK_KEPT_MS = 30_000;
const workKept = new WeakMap<
  RoomToolSet,
  Map<string, { readonly at: number; readonly read: WorkRead | null }>
>();
interface WorkRead {
  readonly name: string;
  readonly text: string;
}

/** A turn's brain call takes one of the shared brain slots, so many vessels at once never overload the box (§2.0a). */
export const inBrainSlot =
  (turn: TurnEnvelope) =>
  <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Effect.serviceOption(TurnPools), (pools) =>
      Option.isNone(pools)
        ? work
        : pools.value.run(
            "brain",
            {
              vessel: turn.vessel.id,
              class: "interactive",
              persona: turn.persona ?? null,
              // With the vessel: a turn that asks another vessel (laptop_ask) never waits on its own slot.
              thread: `${turn.vessel.id}|${turn.persona ?? ""}|${conversationKey(turn)}`,
            },
            work,
          ),
    );

/**
 * What a vessel hears of her streamed words: her first clause, then whole sentences, never one that is her reasoning (`isNarration`),
 * and never a "Freya here." opener (`withoutSelfIntro`; `names` are the pack's personas). What is spoken is what the
 * Record keeps and what she learns from. `flush` speaks what is left once she has finished.
 */
export const speakableSentences = (
  say: (sentence: string) => void,
  names: ReadonlyArray<string> = [],
) => {
  let held = "";
  let spoke = false;
  const out = (sentence: string) => {
    if (sentence.trim() === "" || isNarration(sentence)) return;
    const kept = withoutSelfIntro(sentence, names);
    // A sentence that was only the opener says nothing. Each one ends in a space, the last too: the vessel speaks a
    // sentence once a space follows it, and the stream's end waits for the turn's Record write (14 Nov, 21:40).
    if (kept.trim() === "") return;
    spoke = true;
    say(/\s$/.test(kept) ? kept : `${kept} `);
  };
  return {
    push: (words: string) => {
      held += words;
      const end = /[.!?…]+["'”’)\]]*\s+/g;
      let from = 0;
      while (end.exec(held) !== null) {
        out(held.slice(from, end.lastIndex));
        from = end.lastIndex;
      }
      held = held.slice(from);
      // Her first words go out at the first clause, not the first full stop (about 0.4 s sooner, 15 Nov).
      const clause = spoke ? null : firstClause(held);
      // A clause that is her reasoning waits for its whole sentence, which is then judged and dropped as one.
      if (clause !== null && !isNarration(clause.head)) {
        out(clause.head);
        held = clause.rest;
      }
    },
    flush: () => {
      out(held);
      held = "";
    },
  };
};

/** Hands a hard task to the deep role (BRAIN-DESIGN §2.2), on either route; the deep row says where Opus runs. */
const ESCALATE: RoomTool = {
  name: "brain_escalate",
  description:
    'Hand this task to Opus, the deeper model, for a plan, code, research, a judgement call or a long request. It answers go (say only "Putting Opus on this." and stop), ask (offer it to him once, briefly, in your own words, and stop) or no (answer it yourself and do not mention Opus). Also call it with accept: true when he says yes to an open Opus offer, and with continuing: true when he goes on with a task Opus just answered. Never for his choice of model from now on ("talk to me on Opus", "use Haiku for voice"): that is the brainModels setting.',
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...ESCALATION_KINDS] },
      why: { type: "string", description: "The task, in a few words." },
      rule: {
        type: "integer",
        description:
          "The number of his rule for Opus (listed in his message) that covers this task, or 0 when he has none or none covers it.",
      },
      accept: { type: "boolean", description: "He just said yes to the open Opus offer." },
      continuing: { type: "boolean", description: "He goes on with the task Opus just answered." },
    },
    required: ["kind", "why", "rule"],
  },
};

/** A session turn's tools. The vessel's warm sessions start with this same list, or the first turn finds none warm. */
export const sessionTools = (shared: ReadonlyArray<RoomTool>, own: ReadonlyArray<RoomTool>) => [
  ...shared,
  ...own,
  ESCALATE,
  CONVERSATION_END,
];

/**
 * Per conversation: an open Opus offer, the task Opus last answered, and whether the last turn's tools kept failing.
 * shortcut: held in this server's memory; a restart forgets an open offer, which only means he is asked again.
 */
const escalations = new Map<
  string,
  {
    offer?: { why: string; at: number } | undefined;
    deep?: { why: string; at: number } | undefined;
    failedAt?: number | undefined;
  }
>();
/** Opus turns started without asking, per day in his time zone. */
const deepStarted = new Map<string, number>();
const dayOf = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(ms);

const escalationAsk = (args: unknown): EscalationAsk | null => {
  if (typeof args !== "object" || args === null) return null;
  const a = args as Record<string, unknown>;
  const kind = ESCALATION_KINDS.find((k) => k === a["kind"]);
  if (kind === undefined || typeof a["why"] !== "string") return null;
  return {
    kind,
    why: a["why"].slice(0, 200),
    ...(typeof a["rule"] === "number" && a["rule"] > 0 ? { rule: a["rule"] } : {}),
    ...(a["accept"] === true ? { accept: true } : {}),
    ...(a["continuing"] === true ? { continuing: true } : {}),
  };
};

/** What the turn's note says about Opus, from his settings and this conversation's state. */
const escalationNote = (
  rules: string | null,
  held: ReturnType<typeof escalations.get>,
  heard: string,
  now: number,
) =>
  [
    rules,
    held?.offer !== undefined && now - held.offer.at < ESCALATION_CARRY_MS
      ? `An Opus offer is open (${held.offer.why}): if he says yes, call brain_escalate with accept: true; if no, carry on yourself.`
      : null,
    held?.deep !== undefined && now - held.deep.at < ESCALATION_CARRY_MS
      ? `Opus answered his last request (${held.deep.why}): if he goes on with it, call brain_escalate with continuing: true.`
      : null,
    heard.split(/\s+/).length > LONG_REQUEST_WORDS
      ? "This request is long: it qualifies for Opus."
      : null,
    held?.failedAt !== undefined && now - held.failedAt < ESCALATION_CARRY_MS
      ? "Your tools failed more than once on his last request: if this retries it, it qualifies for Opus."
      : null,
  ]
    .filter((l) => l !== null)
    .join("\n");

/** A tool only this vessel has (its camera, its screen): called on it, never through the shared table. */
export interface VesselTool {
  readonly spec: RoomTool;
  readonly run: (args: unknown) => Effect.Effect<ToolOutcome>;
}

/** What the brain adds to the vessel's turn data: Opus, his work, and his skills that fit this turn. */
export interface TurnNotes {
  readonly brain: string;
  readonly work: string;
  readonly skills: string;
}

/** The shared tools a persona's own list allows: only those are offered, and a call to any other is refused. */
export const personaTools = (tools: RoomToolSet, allowed: ReadonlyArray<string>): RoomToolSet => ({
  ...tools,
  specs: tools.specs.filter((t) => allowed.includes(t.name)),
  run: (name, input, device) =>
    allowed.includes(name)
      ? tools.run(name, input, device)
      : Effect.succeed({ text: `${name} is not one of this persona's tools.`, isError: true }),
});

/** What the vessel read before the model starts. */
export interface Gathered<R> {
  readonly turn: TurnEnvelope;
  /** Persona names: an opener with one of them is never spoken. */
  readonly names: ReadonlyArray<string>;
  /** The turn's message, with the brain's notes on his work and on Opus. */
  readonly user: (notes: TurnNotes) => string;
  /** What the vessel read on the model's behalf, for the trace. */
  readonly readBefore: ReadonlyArray<RoomCall>;
  readonly own: ReadonlyArray<VesselTool>;
  /** The answering persona's tool list; the shared tools outside it are neither offered nor run. Null is all. */
  readonly allowed?: ReadonlyArray<string> | null;
  /** The Record, learning and the vessel's own end of turn (eyes, a guess waiting to be played). */
  readonly finish: (
    said: string,
    outcomes: ReadonlyArray<ActOutcome>,
    turn: TurnEnvelope,
  ) => Effect.Effect<void, never, R>;
}

export interface VesselTurn<E, R> {
  readonly gather: Effect.Effect<Gathered<R>, E, R>;
  readonly system: string;
  /** Claude Code's own tools for a vessel whose turn runs on its own machine (the desktop's files). */
  readonly builtins?: SessionSpec["builtins"];
  /** The shared tools (the one registry), called for `device`. */
  readonly tools: RoomToolSet;
  readonly device: string | undefined;
  /** Her fillers for this turn, in her own words about it; unset or null says nothing (B-056: no fixed phrase). */
  readonly fillers?: { readonly hold: string | null; readonly web: string | null };
  /** Wraps every call: a guessed turn's changes wait for his final words. */
  readonly hold: (name: string) => (call: Effect.Effect<ToolOutcome>) => Effect.Effect<ToolOutcome>;
  /** The model failed before a word: why, in its own words (a login's limit and when it resets, say). */
  readonly failed?: (detail: string) => void;
  /** She ended the conversation (conversation_end): no filler may come after it, only her goodbye. */
  readonly ended?: () => void;
  /** Her reply opened in a tone (`toneOf`): the vessel's voice says it in that tone; a vessel without one ignores it. */
  readonly tone?: (tone: AffectVariant) => void;
}

/** A brain failure's own words, for the log: the R1BrainError's detail, else the cause as text. */
export const brainFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return (
    typeof error === "object" && error !== null && "detail" in error
      ? String(error.detail)
      : String(error)
  ).slice(0, 300);
};

/**
 * A turn with the vessel's tools, on his key (`api`) or in the vessel's warm subscription session (`session`). Null
 * when it did not answer before a word was said, so the caller can fall back; once she has spoken, a failure ends the
 * turn with an apology.
 */
export const brainTurn = Effect.fn("TessayaBrain.turn")(function* <E, R>(
  vessel: VesselTurn<E, R>,
  brain: R1Brain["Service"],
  say: (words: string) => void,
  via: "api" | "session",
  calls?: Array<RoomCall>,
) {
  let tools = vessel.tools;
  const startedAt = yield* Clock.currentTimeMillis;
  // His work, read alongside the vessel: "what needs me" or "what's in flight" then needs no tool round.
  const workRead = Effect.fnUntraced(function* (name: string) {
    const key = `${name} ${vessel.device ?? ""}`;
    const byKey = workKept.get(vessel.tools) ?? new Map();
    workKept.set(vessel.tools, byKey);
    const read = yield* tools.run(name, {}, vessel.device).pipe(
      Effect.map((o): WorkRead | null =>
        o.isError ? null : { name, text: o.text.slice(0, 1200) },
      ),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.tap((read) =>
        Effect.map(Clock.currentTimeMillis, (at) => void byKey.set(key, { at, read })),
      ),
      Effect.forkDetach,
    );
    const kept = byKey.get(key);
    if (kept !== undefined && startedAt - kept.at < WORK_KEPT_MS) return kept.read;
    // A read that breaks or is slow only leaves the line out: the model can still ask for it (14 Nov: 2.5-5.4 s).
    return yield* Fiber.join(read).pipe(
      Effect.timeoutOption(WORK_READ_MS),
      Effect.map(Option.getOrNull),
    );
  });
  const [gathered, needs, work] = yield* Effect.all(
    [vessel.gather, workRead("tessaya_watch"), workRead("tessaya_work_now")],
    { concurrency: "unbounded" },
  );
  const { turn, names, own } = gathered;
  const allowed = gathered.allowed ?? null;
  if (allowed !== null) tools = personaTools(vessel.tools, allowed);
  const escalationSettings = yield* Effect.serviceOption(ServerSettingsService).pipe(
    Effect.flatMap((s) => (Option.isNone(s) ? Effect.succeed(null) : s.value.getSettings)),
    Effect.map((all) => all?.brainEscalation ?? {}),
    Effect.orElseSucceed(() => ({})),
  );
  const key = conversationKey(turn);
  const timeZone = turn.timeZone ?? "UTC";
  // The time or the date alone needs no model: her own wording with the house clock in it, at once. Under load a warm
  // session took 12.5 s to say "What time is it?" (20 Nov 13:26).
  const asked = clockAsk(turn.text);
  // A name the loop asked her to use once is said by the model, so that turn is not answered from the clock.
  if (asked !== null && turn.private !== true && turn.nameOnce === undefined) {
    const now = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      ...(asked === "time"
        ? { hour: "numeric", minute: "2-digit", hour12: true }
        : { weekday: "long", day: "numeric", month: "long" }),
    }).format(yield* Clock.currentTimeMillis);
    const persona = turn.persona ?? undefined;
    const line =
      (yield* expressOr("clock.now", { persona, facts: { now } }))?.text ??
      plainExpression("clock.now", persona ?? "executive", { now })?.text ??
      `It's ${now}.`;
    say(line);
    yield* gathered.finish(line, [], turn);
    yield* Effect.logInfo("R1 turn timing", {
      route: "clock",
      gatherMs: (yield* Clock.currentTimeMillis) - startedAt,
    });
    return line;
  }
  const toolNames = [...tools.specs, ...own.map((t) => t.spec)].map((t) => t.name);
  const user = gathered.user({
    skills: yield* turnSkills(turn, toolNames),
    brain: escalationNote(
      escalationRulesLine(escalationSettings),
      escalations.get(key),
      turn.text,
      yield* Clock.currentTimeMillis,
    ),
    work: [
      needs === null ? null : `What needs him (tessaya_watch), live as of this turn: ${needs.text}`,
      work === null
        ? null
        : `What he and his agents are on, on all his machines (tessaya_work_now), live as of this turn: ${work.text}`,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  });
  // The suite's trace shows what the turn read before the model started, as it shows the model's own calls.
  const readBefore = "read before the turn";
  calls?.push(...gathered.readBefore);
  for (const read of [needs, work])
    if (read !== null)
      calls?.push({
        name: read.name,
        input: {},
        isError: false,
        status: readBefore,
        text: read.text,
      });
  yield* Effect.logInfo("R1 turn timing", {
    route: via === "api" ? "tools" : "session",
    gatherMs: (yield* Clock.currentTimeMillis) - startedAt,
  });
  const outcomes: Array<ActOutcome> = [];
  let said = "";
  let readTheWeb = false;
  // What the vessel hears first, from the turn's start: her first whole sentence, or the cue before a tool call.
  const clock = yield* Clock.Clock;
  let firstSentenceAt: number | null = null;
  let cueAt: number | null = null;
  let toolsRun = 0;
  const sentences = speakableSentences((raw) => {
    // A tone mark is never said or kept; only one opening her reply sets the tone.
    const { tone, text: sentence } = toneOf(raw);
    // Once a tool has run, the reply is a task's: said plainly, whatever the model marked.
    if (tone !== null && said === "" && toolsRun === 0) vessel.tone?.(tone);
    if (sentence.trim() === "") return;
    firstSentenceAt ??= clock.currentTimeMillisUnsafe();
    said += sentence;
    say(sentence);
  }, names);
  const vesselId = turn.vessel.id;
  const ownSpecs = own.map((t) => t.spec);
  const builtins = vessel.builtins === undefined ? {} : { builtins: vessel.builtins };
  let failed = 0;
  /** The task Sonnet handed to Opus this turn, once the policy said go. */
  let handOff: string | null = null;
  /** conversation_end was called, and what she had said by then: her goodbye. */
  let ended = false;
  let goodbye = "";
  const escalate = Effect.fn("TessayaBrain.escalate")(function* (args: unknown) {
    const ask = escalationAsk(args);
    if (ask === null) return { text: "brain_escalate needs a kind and a why.", isError: true };
    const now = yield* Clock.currentTimeMillis;
    const held = escalations.get(key) ?? {};
    const day = dayOf(now, timeZone);
    const decided = escalationDecision(escalationSettings, ask, {
      offerOpen: held.offer !== undefined && now - held.offer.at < ESCALATION_CARRY_MS,
      deepRecently: held.deep !== undefined && now - held.deep.at < ESCALATION_CARRY_MS,
      autoToday: deepStarted.get(day) ?? 0,
    });
    yield* Effect.logInfo("R1 escalation", {
      ...ask,
      decision: decided.decision,
      because: decided.why,
    });
    if (decided.decision === "go") {
      if (decided.counts) deepStarted.set(day, (deepStarted.get(day) ?? 0) + 1);
      for (const d of deepStarted.keys()) if (d !== day) deepStarted.delete(d);
      escalations.set(key, { ...held, offer: undefined });
      handOff = held.offer?.why ?? ask.why;
      return {
        text: 'go: Opus takes this. Say only "Putting Opus on this." and stop.',
        isError: false,
      };
    }
    if (decided.decision === "ask") {
      escalations.set(key, { ...held, offer: { why: ask.why, at: now } });
      // Opus warms while he decides, so a yes starts on a ready session.
      yield* brain
        .warm({
          vessel: vesselId,
          system: vessel.system,
          tools: [...tools.specs, ...ownSpecs],
          role: "deep",
          ...builtins,
        })
        .pipe(Effect.forkDetach);
      return {
        text: `ask (${decided.why}): offer Opus to him once, briefly, in your own words, and stop.`,
        isError: false,
      };
    }
    return {
      text: `no (${decided.why}): answer it yourself and do not mention Opus.`,
      isError: false,
    };
  });
  const toolTurn: ToolTurn = {
    system: vessel.system,
    user,
    tools: sessionTools(tools.specs, ownSpecs),
    run: (name, args) =>
      // Her own words before a tool ("Let me find that project.") are heard now, not held until the tool answers.
      Effect.sync(() => sentences.flush()).pipe(
        Effect.andThen(() =>
          name === ESCALATE.name
            ? escalate(args)
            : name === CONVERSATION_END.name
              ? Effect.sync((): ToolOutcome => {
                  // Her goodbye plays now, not after the model's next pass (that wait was a 3 s "One moment.", 18 Nov).
                  const words =
                    typeof args === "object" && args !== null && "goodbye" in args
                      ? args.goodbye
                      : null;
                  if (said.trim() === "" && typeof words === "string")
                    sentences.push(words.slice(0, 200));
                  sentences.flush();
                  ended = true;
                  goodbye = said;
                  vessel.ended?.();
                  return { text: "Ended: say nothing more.", isError: false };
                })
              : (own.find((t) => t.spec.name === name)?.run(args) ??
                tools.run(name, args, vessel.device)),
        ),
        vessel.hold(name),
        // Every tool the turn calls knows which vessel heard it.
        Effect.provideService(TurnOrigin, originOf(turn)),
        Effect.catchCause(() =>
          Effect.succeed<ToolOutcome>({ text: "it did not work", isError: true }),
        ),
        Effect.map(capToolText),
        Effect.tap((o: ToolOutcome) =>
          Effect.sync(() => {
            calls?.push({
              name,
              input: args,
              isError: o.isError,
              ...(o.status === undefined ? {} : { status: o.status }),
              text: o.text.slice(0, 4000),
            });
            if (o.status !== undefined)
              outcomes.push({ ok: !o.isError, status: o.status, line: o.text });
            toolsRun += 1;
            if (o.isError) failed += 1;
          }),
        ),
      ),
  };
  const words =
    via === "api"
      ? brain.converse(toolTurn)
      : brain.session({ ...toolTurn, vessel: vesselId, cue, ...builtins });
  // Only a web search, which takes seconds, is cued: a stock line at every tool start sounded out of place (18 Nov).
  function cue(web: boolean) {
    if (!web) return;
    readTheWeb = true;
    const line = vessel.fillers?.web ?? null;
    if (said === "" && line !== null) {
      cueAt ??= clock.currentTimeMillisUnsafe();
      say(`${line} `);
    }
  }
  const speak = (stream: typeof words) =>
    stream.pipe(
      // After her goodbye, nothing more is said; a goodbye written only after the call still is.
      Stream.runForEach((words) =>
        Effect.sync(() => (ended && goodbye.trim() !== "" ? undefined : sentences.push(words))),
      ),
      inBrainSlot(turn),
      Effect.exit,
    );
  let ran = yield* speak(words);
  sentences.flush();
  // Sonnet said "Putting Opus on this.": the same turn goes on in an Opus session, with the vessel's tools.
  const task: string | null = handOff;
  if (task !== null && Exit.isSuccess(ran)) {
    ran = yield* speak(
      brain.session({
        ...toolTurn,
        tools: toolTurn.tools.filter((t) => t.name !== ESCALATE.name),
        user: `${toolTurn.user}\nShe handed this to you, the deeper model, because: ${JSON.stringify(task)}. She has told him you are on it: answer him now.`,
        vessel: vesselId,
        role: "deep",
        cue,
        ...builtins,
      }),
    );
    sentences.flush();
  }
  const settledAt = yield* Clock.currentTimeMillis;
  const held = escalations.get(key) ?? {};
  escalations.set(key, {
    ...held,
    ...(task === null ? {} : { deep: { why: task, at: settledAt } }),
    ...(failed >= 2 ? { failedAt: settledAt } : { failedAt: undefined }),
  });
  // The model's first token (brainFirstMs) is not speakable; this is what the vessel can say.
  yield* Effect.logInfo("R1 turn first said", {
    route: via === "api" ? "tools" : "session",
    firstSentenceMs: firstSentenceAt === null ? null : firstSentenceAt - startedAt,
    cueMs: cueAt === null ? null : cueAt - startedAt,
  });
  if (Exit.isFailure(ran)) {
    const detail = brainFailure(ran.cause);
    yield* Effect.logWarning("brain turn failed", {
      route: via,
      detail,
      spoke: said.trim() !== "",
    });
    if (said.trim() === "") vessel.failed?.(detail);
  }
  // The vessel rests once her goodbye has played; a goodbye of no words still ends the turn.
  if (ended) say(REST_MARK);
  if (said.trim() === "" && !ended) return null;
  if (Exit.isFailure(ran)) {
    const sorry = " Sorry, something went wrong on my side.";
    said += sorry;
    say(sorry);
  }
  // Her mood hears how a task went (CS6): an act's outcome or a broken turn, never what she read or said.
  const mood = yield* Effect.serviceOption(TessayaMood);
  if (
    Option.isSome(mood) &&
    moodMember(turn) !== null &&
    (outcomes.length > 0 || Exit.isFailure(ran))
  )
    yield* mood.value.note(turn.persona, {
      kind: "turn_outcome",
      ok: Exit.isSuccess(ran) && outcomes.every((o) => o.ok),
    });
  // What she read on the web is outside content: what the turn teaches waits for his yes.
  yield* gathered.finish(said.trim(), outcomes, readTheWeb ? { ...turn, tainted: true } : turn);
  return said;
});
