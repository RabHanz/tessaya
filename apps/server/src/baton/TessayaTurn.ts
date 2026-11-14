/**
 * One turn pipeline for every vessel (tessaya-ops research/MEMORY-V2-DESIGN.md §2.0). Tessaya is one agent; the
 * desktop, a desk device, the phone and the mascot are vessels. Each sends the same envelope, gets the same memory
 * for the same words and persona, and every addressed turn it carries is learned from the same way.
 */
import {
  type Assurance,
  memberOfSpeaker,
  memberOfSubject,
  OWNER_MEMBER_ID,
  isPreferenceKey,
  type PreferenceKey,
  vesselSubject,
  voiceAssurance,
} from "@t3tools/baton-shared/household";
import { memoryBlock } from "@t3tools/baton-shared/memory";
import { comingUp, whenSaid } from "@t3tools/baton-shared/memoryDates";
import { foldSpelling, spellBack } from "@t3tools/baton-shared/spelling";
import {
  privatePersonOf,
  type PrivateTurn,
  type SpeakerLike,
} from "@t3tools/baton-shared/privateMemory";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { BatonMemoryLearning, type LearnResult } from "./BatonMemoryLearning.ts";
import { MemberPreferences } from "./MemberPreferences.ts";
import { HOME_KEY, HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";
import { BatonMemoryRefusedError, type BatonHouseholdCallInput } from "@t3tools/baton-contracts";
import { BatonMemoryService } from "./BatonMemoryService.ts";
import { BatonPrivateMemoryService, PrivateCaller } from "./BatonPrivateMemoryService.ts";
import { TessayaComms } from "./TessayaComms.ts";
import { commsWaitingLine } from "@t3tools/baton-shared/comms";
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
  /** The app in front, for a vessel with a screen ("excel.exe"): which of his skills fit. */
  readonly app?: string | null | undefined;
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
  /**
   * The vessel just recognised this speaker for the first time this session (its recognition cue): their name, which
   * she uses once, naturally, and not again in the conversation.
   */
  readonly nameOnce?: string | undefined;
  /** The conversation it continues, when the vessel or the arbiter names one; else `conversationKey`. */
  readonly conversation?: string | undefined;
  /** One of several people heard in the same turn: the reply is heard by all, so nothing private is read. */
  readonly sharedRoom?: boolean | undefined;
  /**
   * The member whose own signed-in device sent a typed turn (its session's `member:<id>` subject), or null for a
   * subject that names a member badly. Filled from `SessionMember` by `begin` and `end` when the vessel does not say.
   */
  readonly member?: string | null | undefined;
}

/**
 * One conversation per person, or the household's when the voice is not known (the arbiter's need): whichever
 * vessel answers him next continues it, and a persona switch stays in it.
 */
export const conversationKey = (turn: TurnEnvelope): string =>
  turn.conversation ??
  (turn.speaker?.verified === true && turn.speaker.personId !== null
    ? `person:${turn.speaker.personId}`
    : typeof turn.member === "string" && turn.member !== OWNER_MEMBER_ID
      ? `person:${turn.member}`
      : "household");

/**
 * The member a request's session acts for (`memberOfSubject` of its subject), set by the transport as `MemoryViewer`
 * is. Unset (upkeep, a device's own key) is the owner, as before the household model.
 */
export const SessionMember = Context.Reference<string | null>(
  "t3/baton/TessayaTurn/SessionMember",
  {
    defaultValue: () => OWNER_MEMBER_ID,
  },
);

export interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** The vessel it was said through. */
  readonly vessel: string;
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
  /** The member the turn is from (null: a guest's voice) and how sure (A0-A4): what Trust and the household gate on. */
  readonly member?: string | null;
  readonly assurance?: Assurance;
  /** The turn read outside content. */
  readonly tainted?: boolean;
  readonly persona?: string | null;
  /** A replay or test of the vessel: its writes are dry runs. */
  readonly rehearsal?: boolean;
} | null>("t3/baton/TessayaTurn/TurnOrigin", { defaultValue: () => null });

/**
 * Who a turn is from and how sure (ACCOUNTS-IDENTITY-DESIGN §2.4): a spoken turn is its voice's member at its voice's
 * level; a typed one on a signed-in desktop, phone or browser is the owner's device at A2 (I-0: those sessions are his
 * until a member's own device sends its turns); an agent's or a job's turn is the owner's at A0.
 */
export const turnIdentity = (
  turn: Pick<TurnEnvelope, "speaker" | "vessel" | "member">,
): { readonly member: string | null; readonly assurance: Assurance } =>
  turn.speaker !== null && turn.speaker !== undefined
    ? { member: memberOfSpeaker(turn.speaker), assurance: voiceAssurance(turn.speaker) }
    : {
        // A typed turn is its device's member: the owner's unless a member's own device sent it.
        member: turn.member === undefined ? OWNER_MEMBER_ID : turn.member,
        assurance:
          turn.vessel.kind === "desktop" ||
          turn.vessel.kind === "phone" ||
          turn.vessel.kind === "web"
            ? 2
            : 0,
      };

/** The origin a turn's tool calls run under. */
export const originOf = (turn: TurnEnvelope) => ({
  ...turn.vessel,
  label: turn.origin ?? turn.vessel.kind,
  hisVoice: hisVoice(turn.speaker ?? null),
  speaker: turn.speaker ?? null,
  ...turnIdentity(turn),
  tainted: turn.tainted === true,
  persona: turn.persona ?? null,
  rehearsal: turn.rehearsal === true,
});

/** Forget's answer to any voice but his verified one, also what a replay hears (it is never verified). */
export const NOT_HIS_VOICE_TO_FORGET =
  "I can forget that only when I know it's your voice. You can forget it in Memory on your desktop or phone.";

/** One member she has lately heard, or whose devices are connected, and which of the two backs the guess. */
export interface WhoIsHome {
  readonly member: string;
  readonly name: string;
  /** Last verified voice or own-device turn: where (the vessel, "R1", "desktop"), its id, and how long ago. */
  readonly heard: {
    readonly via: string;
    readonly vessel: string;
    readonly minutesAgo: number;
  } | null;
  /** Their own devices: how many are connected now, and minutes since one was (0 while connected). */
  readonly devices: { readonly connected: number; readonly minutesAgo: number } | null;
  /** Heard within the last half hour, or a device connected now. */
  readonly likelyHome: boolean;
}
/** Heard this recently: likely still home. */
const PRESENCE_HOME_MS = 30 * 60_000;
/** Forgotten after a day: presence is a state, never a history. */
const PRESENCE_FORGET_MS = 24 * 60 * 60_000;

/** A member asked to keep something and has no store of their own yet. */
export const NO_STORE_FOR_MEMBER =
  "Set up your own memory first: choose your PIN in Tessaya on your phone. Until then I can't keep that for you.";

/**
 * The private-store view of a turn: typed on a member's own desktop, phone or browser (that device's member), or
 * spoken (the voice decides; a saved person's on their own path). A device with no voice is never typed.
 */
export const privateTurnOf = (
  turn: Pick<TurnEnvelope, "vessel" | "speaker" | "tainted" | "member">,
): PrivateTurn => {
  const typed =
    (turn.speaker === null || turn.speaker === undefined) &&
    turn.member !== undefined &&
    (turn.vessel.kind === "desktop" || turn.vessel.kind === "phone" || turn.vessel.kind === "web");
  return {
    route: !typed && turn.speaker?.kind === "saved" ? "outside" : "assistant",
    typed,
    tainted: turn.tainted === true,
    speaker: turn.speaker ?? null,
    ...(typed ? { member: turn.member ?? null } : {}),
  };
};

/** What `remember` did, in words she can say. */
export interface Remembered {
  readonly kept: "his" | "noted" | "held" | "rehearsal" | "theirs";
  readonly id: string | null;
  readonly line: string;
}

/** The line the brain gets when a vessel first recognises who it is talking to this session. */
export const nameOnceLine = (name: string | undefined): string =>
  name === undefined || name.trim() === ""
    ? ""
    : `You know this voice: it is ${name.trim().slice(0, 40)}. Use their name once in this reply, naturally, and not again this conversation.`;

export interface TurnContext {
  /** Standing memory (sessionless vessels only), then what matches this sentence. */
  readonly block: string;
  /**
   * What to tell the speaker now, as her own instruction rather than remembered data: messages that waited for them
   * (COMMS-DESIGN §2.4). Empty or absent when there is nothing.
   */
  readonly notice?: string;
  /** The ids matched to this sentence, best first: the same for every vessel given the same words and persona. */
  readonly ids: ReadonlyArray<string>;
  /** The speaker's own private memories, only when the gate allows it; else "". */
  readonly privateBlock: string;
  /** The conversation so far on any vessel, oldest first (empty after a quiet spell). */
  readonly conversation: { readonly key: string; readonly turns: ReadonlyArray<ConversationTurn> };
  /** How the person she is talking to likes things (their own, never another member's); empty for a guest. */
  readonly preferences: Readonly<Partial<Record<PreferenceKey, string>>>;
  /** Who she is talking to: the member and what to call them (their `name` preference, else their member name). */
  readonly who: { readonly member: string | null; readonly name: string | null };
}

/** How much of a conversation every vessel shares, and how long it waits for him to go on. */
const CONVERSATION_TURNS = 12;
const CONVERSATION_IDLE_MS = 10 * 60_000;

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
  // A member's own device typed it: their words never teach his store (HOUSEHOLD-DESIGN §6).
  if (turn.member !== undefined && turn.member !== OWNER_MEMBER_ID) return "not the owner's device";
  return null;
};

/**
 * One thread of her attention (PERSONA-MODEL-AUDIT, Concurrent self CS1): a persona in one conversation, on the vessel
 * that heard its last turn. Live while turns keep coming, closed at the conversation's own idle boundary.
 */
export interface LiveThread {
  readonly persona: string | null;
  readonly conversation: string;
  readonly vessel: TurnEnvelope["vessel"];
  /** The verified person or the member's own device; null for a voice she does not know. */
  readonly person: string | null;
  readonly openedAt: number;
  readonly lastAt: number;
}

export class TessayaTurn extends Context.Service<
  TessayaTurn,
  {
    /** The memory a turn is answered with, as the caller's viewer (set by its transport) may see it. */
    readonly begin: (turn: TurnEnvelope) => Effect.Effect<TurnContext>;
    /**
     * Several people heard in one turn (HOUSEHOLD-DESIGN §9b): one context each, in speaking order, built only from
     * that person's own preferences and conversation, with nothing private read for anyone.
     */
    /**
     * Who is home, as far as she can tell (HOUSEHOLD-DESIGN §7): each member heard by a verified voice or a turn on their
     * own device today, and whose devices are connected (the household's, asked as the caller), most recent first.
     * A state for noticing and suggestions, not a history.
     */
    readonly whoIsHome: Effect.Effect<ReadonlyArray<WhoIsHome>>;
    /** What his memories say is coming up this week, as the caller may see them (Memory v2 step 8). */
    readonly comingUp: Effect.Effect<
      ReadonlyArray<{ readonly text: string; readonly when: string; readonly kind: string }>
    >;
    readonly beginMany: (
      turns: ReadonlyArray<TurnEnvelope>,
    ) => Effect.Effect<ReadonlyArray<TurnContext>>;
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
    /** The speaking member's own preference (TurnOrigin's member), set or cleared with null. */
    readonly setPreference: (
      key: string,
      value: string | null,
    ) => Effect.Effect<
      {
        readonly member: string;
        readonly key: string;
        readonly value: string | null;
        /** What she says back: "Kept. Zayd, Z-A-Y-D." for a spelled name. */
        readonly line: string;
      },
      BatonMemoryRefusedError
    >;
    readonly end: (
      turn: TurnEnvelope,
      done: { readonly reply: string; readonly previous?: string | null | undefined },
    ) => Effect.Effect<LearnResult | null>;
    /** Her live threads, one persona's or all, newest first: the base of the presence board (CS2). */
    readonly threads: (persona?: string) => Effect.Effect<ReadonlyArray<LiveThread>>;
  }
>()("t3/baton/TessayaTurn") {}

export const make = Effect.gen(function* () {
  const memory = yield* BatonMemoryService;
  const learning = yield* BatonMemoryLearning;
  const stores = yield* Effect.serviceOption(BatonPrivateMemoryService);
  const preferences = yield* MemberPreferences;
  const sql = yield* SqlClient.SqlClient;

  /** A member's name in the household (the identity lane's members table); null for a guest or no row. */
  const memberName = Effect.fn("TessayaTurn.memberName")(function* (member: string | null) {
    if (member === null) return null;
    const rows = yield* sql<{ name: string }>`
      SELECT name FROM tessaya_household_members WHERE id = ${member} AND removed_at IS NULL
    `.pipe(Effect.orElseSucceed(() => []));
    return rows[0]?.name ?? null;
  });

  /** Where this home's members live: null here, else the linked server's label. */
  const homeOn = sql<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${HOME_KEY}`.pipe(
    Effect.map((rows) => (rows[0]?.value ?? "") || null),
    Effect.orElseSucceed(() => null),
  );

  /** The household's own call (routed to the home when it lives elsewhere), as this member asking for themselves. */
  const askHousehold = Effect.fn("TessayaTurn.askHousehold")(function* (
    input: BatonHouseholdCallInput,
    caller: { readonly member: string; readonly assurance: Assurance; readonly tainted: boolean },
  ) {
    const household = yield* Effect.serviceOption(TessayaHousehold);
    if (Option.isNone(household)) return null;
    return yield* household.value
      .call(input)
      .pipe(
        Effect.provideService(HouseholdCaller, { ...caller, via: "Tessaya, for their own turn" }),
      );
  });

  /** A member's own preferences, from the home where the members live; nothing for a guest. */
  const preferencesOf = Effect.fn("TessayaTurn.preferencesOf")(function* (member: string | null) {
    if (member === null) return {} as Partial<Record<PreferenceKey, string>>;
    if ((yield* homeOn) === null) return yield* preferences.of(member);
    const there = yield* askHousehold(
      { op: "preferences", id: member },
      { member, assurance: 2, tainted: false },
    );
    // An unreachable home leaves her with no preferences, never another server's stale copy.
    return (there?.status === "done" ? (there.preferences ?? {}) : {}) as Partial<
      Record<PreferenceKey, string>
    >;
  });

  /** The speaking member's own preference, set or (null) cleared; a guest has none to set. */
  const setPreference = Effect.fn("TessayaTurn.setPreference")(function* (
    key: string,
    value: string | null,
  ) {
    const origin = yield* TurnOrigin;
    if (!isPreferenceKey(key))
      return yield* new BatonMemoryRefusedError({
        reason: `There is no preference called ${key}.`,
      });
    const member = origin === null ? OWNER_MEMBER_ID : origin.member;
    if (member === null || member === undefined)
      return yield* new BatonMemoryRefusedError({
        reason: "I can keep preferences only for people in this household.",
      });
    if (origin?.rehearsal === true)
      return { member, key, value, line: value === null ? "Cleared." : "Kept." };
    if ((yield* homeOn) !== null) {
      // The members live on another server: the change is made there, under its rules (A2, untainted).
      const there = yield* askHousehold(
        { op: "setPreference", id: member, key, value },
        {
          member,
          assurance: origin?.assurance ?? 0,
          tainted: origin?.tainted === true,
        },
      );
      if (there === null || there.status !== "done")
        return yield* new BatonMemoryRefusedError({
          reason: there?.line ?? "This home's members can't be reached right now.",
        });
      return { member, key, value: there.preferences?.[key] ?? null, line: there.line };
    }
    const set = yield* preferences.set(member, key, value);
    return { member, key, value: set.value, line: set.line };
  });
  const pools = yield* Effect.serviceOption(TurnPools);

  const privateFor = Effect.fn("TessayaTurn.private")(function* (turn: TurnEnvelope) {
    // His own store only, by his verified voice: a typed turn's private memories come through its own client's
    // path, and another member's are not read into a turn others may hear (HOUSEHOLD-DESIGN §6) until 5b's next step.
    const asked: PrivateTurn = {
      route: "assistant",
      typed: false,
      tainted: turn.tainted === true,
      speaker: turn.speaker ?? null,
    };
    if ("refused" in privatePersonOf(asked) || Option.isNone(stores)) return "";
    // shortcut: only a store opened for this vessel's own session is read; nothing opens one for a device yet (M2).
    const recalled = yield* stores.value.recall({ turn: asked, text: turn.text }).pipe(
      Effect.provideService(PrivateCaller, {
        session: vesselSubject(turn.vessel.id),
        desktop: true,
        member: memberOfSubject(vesselSubject(turn.vessel.id)),
      }),
      Effect.option,
    );
    return Option.isSome(recalled) ? recalled.value.block : "";
  });

  // shortcut: held in this server's memory, so a restart starts every conversation afresh; persist when one must last.
  const conversations = new Map<string, { at: number; turns: Array<ConversationTurn> }>();
  const conversationOf = Effect.fn("TessayaTurn.conversation")(function* (turn: TurnEnvelope) {
    const key = conversationKey(turn);
    const held = conversations.get(key);
    const now = yield* Clock.currentTimeMillis;
    return {
      key,
      turns: held === undefined || now - held.at > CONVERSATION_IDLE_MS ? [] : [...held.turns],
    };
  });
  const addExchange = Effect.fn("TessayaTurn.converse")(function* (
    turn: TurnEnvelope,
    reply: string,
  ) {
    const key = conversationKey(turn);
    const now = yield* Clock.currentTimeMillis;
    const held = conversations.get(key);
    const turns = held === undefined || now - held.at > CONVERSATION_IDLE_MS ? [] : held.turns;
    const said: Array<ConversationTurn> = [
      { role: "user", content: turn.text, vessel: turn.vessel.id },
      ...(reply.trim() === ""
        ? []
        : [{ role: "assistant" as const, content: reply, vessel: turn.vessel.id }]),
    ];
    conversations.set(key, { at: now, turns: [...turns, ...said].slice(-CONVERSATION_TURNS) });
  });

  // shortcut: in this server's memory like `conversations`; mirror to the Record when the board needs history (CS7).
  const live = new Map<string, LiveThread>();
  const touchThread = Effect.fn("TessayaTurn.touchThread")(function* (turn: TurnEnvelope) {
    if (turn.rehearsal === true || turn.addressed === false) return;
    const conversation = conversationKey(turn);
    const persona = turn.persona ?? null;
    const id = `${persona ?? ""}|${conversation}`;
    const now = yield* Clock.currentTimeMillis;
    const held = live.get(id);
    const person =
      turn.speaker?.verified === true && turn.speaker.personId !== null
        ? turn.speaker.personId
        : typeof turn.member === "string"
          ? turn.member
          : null;
    live.set(id, {
      persona,
      conversation,
      vessel: turn.vessel,
      person,
      openedAt:
        held === undefined || now - held.lastAt > CONVERSATION_IDLE_MS ? now : held.openedAt,
      lastAt: now,
    });
  });
  const threads = Effect.fn("TessayaTurn.threads")(function* (persona?: string) {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, t] of live) if (now - t.lastAt > CONVERSATION_IDLE_MS) live.delete(id);
    return [...live.values()]
      .filter((t) => persona === undefined || t.persona === persona)
      .toSorted((a, b) => b.lastAt - a.lastAt);
  });

  /** A typed turn takes its session's member when the vessel did not name one. */
  const withMember = Effect.fn("TessayaTurn.member")(function* (turn: TurnEnvelope) {
    if (turn.member !== undefined || (turn.speaker !== null && turn.speaker !== undefined))
      return turn;
    return { ...turn, member: yield* SessionMember };
  });

  const begin = Effect.fn("TessayaTurn.begin")(function* (raw: TurnEnvelope) {
    const turn = yield* withMember(raw);
    yield* touchThread(turn);
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
    const member = turnIdentity(turn).member;
    yield* notePresence(turn);
    const preferences = yield* preferencesOf(member);
    const waiting = yield* waitingLine(turn, member, preferences.name ?? null);
    return {
      notice: waiting,
      block: [standing.block, extra, nameOnceLine(turn.nameOnce)]
        .filter((b) => b !== "")
        .join("\n\n"),
      ids: sentence.ids,
      privateBlock: turn.sharedRoom === true ? "" : yield* privateFor(turn),
      conversation: yield* conversationOf(turn),
      preferences,
      who: { member, name: preferences.name ?? (yield* memberName(member)) },
    };
  });

  /**
   * Messages that waited for this member, told once on the turn that proves they are here (COMMS-DESIGN §2.4): only a
   * verified voice or their own device, never a replay.
   */
  const waitingLine = Effect.fn("TessayaTurn.waitingLine")(function* (
    turn: TurnEnvelope,
    member: string | null,
    name: string | null,
  ) {
    const comms = yield* Effect.serviceOption(TessayaComms);
    if (Option.isNone(comms) || member === null || turn.rehearsal === true) return "";
    if (turnIdentity(turn).assurance < 2) return "";
    const waiting = yield* comms.value.waitingFor(member, turn.vessel.id);
    return commsWaitingLine(name ?? (yield* memberName(member)) ?? "them", waiting);
  });

  // shortcut: in this server's memory, as HOUSEHOLD-DESIGN §7 asks (a state, not a history); a restart forgets it.
  const seen = new Map<string, { at: number; via: string; vessel: string }>();
  /**
   * Who was just here: a voice verified on its own audio (A2) on a vessel, or a member's own signed-in device typing.
   * A guess (an unverified or carried-over voice), a guest, a replay or a turn not said to her proves nothing.
   */
  const notePresence = Effect.fn("TessayaTurn.notePresence")(function* (turn: TurnEnvelope) {
    if (turn.rehearsal === true || turn.addressed === false) return;
    const identity = turnIdentity(turn);
    if (identity.member === null || identity.assurance < 2) return;
    seen.set(identity.member, {
      at: yield* Clock.currentTimeMillis,
      via: turn.origin ?? `${turn.vessel.kind} ${turn.vessel.id}`,
      vessel: turn.vessel.id,
    });
  });

  const whoIsHome = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const origin = yield* TurnOrigin;
    const asked = yield* askHousehold(
      { op: "home" },
      origin === null
        ? { member: OWNER_MEMBER_ID, assurance: 2, tainted: false }
        : {
            member: origin.member ?? memberOfSpeaker(origin.speaker ?? null) ?? "",
            assurance: origin.assurance ?? voiceAssurance(origin.speaker ?? null),
            tainted: origin.tainted === true,
          },
    ).pipe(Effect.orElseSucceed(() => null));
    const devices = new Map((asked?.around ?? []).map((d) => [d.id, d]));
    const out: Array<WhoIsHome> = [];
    for (const [member, s] of seen) {
      if (now - s.at > PRESENCE_FORGET_MS) seen.delete(member);
    }
    for (const member of new Set([...seen.keys(), ...devices.keys()])) {
      const s = seen.get(member);
      const d = devices.get(member);
      const heard =
        s === undefined
          ? null
          : { via: s.via, vessel: s.vessel, minutesAgo: Math.floor((now - s.at) / 60_000) };
      out.push({
        member,
        name:
          (yield* preferencesOf(member)).name ?? d?.name ?? (yield* memberName(member)) ?? member,
        heard,
        devices: d === undefined ? null : { connected: d.connected, minutesAgo: d.minutesAgo },
        likelyHome:
          (s !== undefined && now - s.at <= PRESENCE_HOME_MS) ||
          (d !== undefined && d.connected > 0),
      });
    }
    const latest = (p: WhoIsHome) =>
      Math.min(p.heard?.minutesAgo ?? Infinity, p.devices?.minutesAgo ?? Infinity);
    return out.toSorted((a, b) => latest(a) - latest(b));
  }).pipe(Effect.withSpan("TessayaTurn.whoIsHome"));

  const comingUpNow = Effect.gen(function* () {
    const origin = yield* TurnOrigin;
    const items = yield* memory.list({
      limit: 2_000,
      ...(origin?.persona == null ? {} : { agent: origin.persona }),
    });
    const zone =
      (yield* memory.meta("timeZone")) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return comingUp(items, yield* Clock.currentTimeMillis, zone).map((c) => ({
      text: c.item.text,
      when: whenSaid(c.inDays),
      kind: c.kind,
    }));
  }).pipe(Effect.withSpan("TessayaTurn.comingUp"));

  const beginMany = Effect.fn("TessayaTurn.beginMany")(function* (
    turns: ReadonlyArray<TurnEnvelope>,
  ) {
    const shared = turns.length > 1;
    return yield* Effect.forEach(turns, (t) => begin(shared ? { ...t, sharedRoom: true } : t));
  });

  const end = Effect.fn("TessayaTurn.end")(function* (
    raw: TurnEnvelope,
    done: { readonly reply: string; readonly previous?: string | null | undefined },
  ) {
    const turn = yield* withMember(raw);
    if (turn.addressed !== false && turn.rehearsal !== true) yield* addExchange(turn, done.reply);
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

  const remember = Effect.fn("TessayaTurn.remember")(function* (said: string) {
    const origin = yield* TurnOrigin;
    // "Dr Qadri, Q-A-D-R-I": the name kept as spelled, said back once, and taught to the voice.
    const folded = foldSpelling(said.trim());
    const text = folded.text;
    const spelledBack = spellBack(folded.names);
    if (origin?.rehearsal !== true) yield* preferences.teach(folded.names);
    if (origin?.rehearsal === true)
      return {
        kept: "rehearsal" as const,
        id: null,
        line: `Kept.${spelledBack}`,
      };
    if (origin?.speaker?.kind === "guest")
      return yield* new BatonMemoryRefusedError({
        reason: "I can only keep things in his memory for him. Ask him to tell me.",
      });
    // Another member's words go to their own store, never his (HOUSEHOLD-DESIGN §4).
    if (
      origin !== null &&
      (origin.speaker?.kind === "saved" ||
        (origin.member !== undefined && origin.member !== OWNER_MEMBER_ID))
    )
      return yield* Effect.map(rememberForMember(origin, text), (r) => ({
        ...r,
        line: `${r.line}${spelledBack}`,
      }));
    const his = origin?.hisVoice === true;
    const item = yield* memory.add({
      kind: "note",
      text: text.trim(),
      source: his ? "user" : "thread",
      // He asked for it to be kept, so it stands in every later turn's memory (standing needs 0.6), unlike a guess.
      ...(his ? {} : { confidence: 0.7 }),
      sourceRef: origin === null ? "agent" : `vessel:${origin.kind}:${origin.id}`,
      // Where it came from, for "Why?" and the household model: the vessel, the voice and the persona that heard it.
      ...(origin === null
        ? { surface: "agent" }
        : {
            surface: origin.kind,
            speaker: his ? "owner" : (origin.speaker?.personId ?? null),
            persona: origin.persona ?? null,
          }),
      // An agent outside a turn only proposes; he says yes in Memory.
      ...(origin === null ? { tainted: true } : {}),
    });
    return item.proposed
      ? { kept: "held" as const, id: item.id, line: "Noted; it waits for his yes in Memory." }
      : his
        ? { kept: "his" as const, id: item.id, line: `Kept.${spelledBack}` }
        : {
            kept: "noted" as const,
            id: item.id,
            line: `Kept.${spelledBack}`,
          };
  });

  /** A member's "remember this": into their own encrypted store, open or locked; refused when they have none. */
  const rememberForMember = Effect.fn("TessayaTurn.rememberForMember")(function* (
    origin: NonNullable<typeof TurnOrigin.Service>,
    text: string,
  ) {
    if (Option.isNone(stores))
      return yield* new BatonMemoryRefusedError({ reason: NO_STORE_FOR_MEMBER });
    const kept = yield* stores.value
      .remember({
        turn: privateTurnOf({
          vessel: { kind: origin.kind, id: origin.id },
          speaker: origin.speaker ?? null,
          tainted: origin.tainted === true,
          ...(origin.member === undefined ? {} : { member: origin.member }),
        }),
        text: text.trim(),
        kind: "note",
      })
      .pipe(
        Effect.provideService(PrivateCaller, {
          session: vesselSubject(origin.id),
          desktop: true,
          member: origin.member ?? null,
        }),
        Effect.mapError((e) => new BatonMemoryRefusedError({ reason: e.reason })),
      );
    if (!kept.stored)
      return yield* new BatonMemoryRefusedError({ reason: kept.reason ?? NO_STORE_FOR_MEMBER });
    return { kept: "theirs" as const, id: null, line: "Kept, in your own memory." };
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

  return TessayaTurn.of({
    begin,
    beginMany,
    end,
    remember,
    forget,
    about,
    setPreference,
    whoIsHome,
    comingUp: comingUpNow,
    threads,
  });
});

export const layer = Layer.effect(TessayaTurn, make);
