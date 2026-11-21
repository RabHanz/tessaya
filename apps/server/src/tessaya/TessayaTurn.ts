// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off
/**
 * One turn pipeline for every vessel (tessaya-ops research/MEMORY-V2-DESIGN.md §2.0). Tessaya is one agent; the
 * desktop, a desk device, the phone and the mascot are vessels. Each sends the same envelope, gets the same memory
 * for the same words and persona, and every addressed turn it carries is learned from the same way.
 */
import { alsoLine, bodyLine, type BodyNow } from "@t3tools/tessaya-shared/embodiment";
import { SAME_CONVERSATION_MS, sinceLine } from "@t3tools/tessaya-shared/agentPrompt";
import {
  type Assurance,
  memberOfSpeaker,
  memberOfSubject,
  OWNER_MEMBER_ID,
  isPreferenceKey,
  type PreferenceKey,
  vesselSubject,
  voiceAssurance,
} from "@t3tools/tessaya-shared/household";
import { inputLine } from "@t3tools/tessaya-shared/inputQuality";
import { memoryBlock, type MemoryUnsure } from "@t3tools/tessaya-shared/memory";
import {
  repairBoundsFor,
  repairLine,
  repairVerdict,
  type HeardWord,
  type RepairVerdict,
} from "@t3tools/tessaya-shared/transcriptRepair";
import { comingUp, whenSaid, zoneMidnight } from "@t3tools/tessaya-shared/memoryDates";
import { foldSpelling, spellBack } from "@t3tools/tessaya-shared/spelling";
import {
  ownVoiceVerified,
  privatePersonOf,
  type PrivateTurn,
  type SpeakerLike,
} from "@t3tools/tessaya-shared/privateMemory";
import { PRESENCE_BARS, presenceReason } from "@t3tools/tessaya-shared/presence";
import { emitAction, type TurnAction } from "./turnActions.ts";
import { make as makeLive, TurnLiveContext } from "./TurnLiveContext.ts";
import { recordText } from "@t3tools/tessaya-shared/audit";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { TessayaMemoryLearning, type LearnResult } from "./TessayaMemoryLearning.ts";
import { MemberPreferences } from "./MemberPreferences.ts";
import { HOME_KEY, makeBrainLink } from "./BrainHost.ts";
import * as ServerConfig from "../config.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";
import {
  BatonMemoryRefusedError,
  type TessayaHouseholdCallInput,
} from "@t3tools/tessaya-contracts";
import { readBinDays, TessayaMemoryService } from "./TessayaMemoryService.ts";
import { TessayaPrivateMemoryService, PrivateCaller } from "./TessayaPrivateMemoryService.ts";
import { TessayaComms } from "./TessayaComms.ts";
import { commsWaitingLine } from "@t3tools/tessaya-shared/comms";
import { TurnOrigin, type VesselKind } from "./TurnOrigin.ts";
import { TurnPools } from "./TurnPools.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { CurrentPersona } from "./CurrentPersona.ts";
import { TessayaCast } from "./TessayaCast.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { newsOnce } from "./TessayaWhatsNew.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { AffectCause } from "./AffectCause.ts";
import { TessayaUnderstanding, type UnderstandingSubject } from "./TessayaUnderstanding.ts";
import { make as makePresence, TessayaPresence } from "./TessayaPresence.ts";
import {
  faceForLine,
  faceLine,
  moodLine,
  roomLine,
  type AffectView,
  type Who,
} from "@t3tools/tessaya-shared/affect";
import { understandingLine } from "@t3tools/tessaya-shared/understanding";
import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { SpeechService } from "../speech/SpeechService.ts";
import { ownerLineFor, personasList } from "./OperatingSystemPack.ts";
import { TessayaJobService } from "./TessayaJobService.ts";
import { WorkSessionService } from "./WorkSessionService.ts";
import { leadFitLine } from "@t3tools/tessaya-shared/jobs";
import type {
  AffectVariant,
  InputQuality,
  RegisteredDevice,
  TessayaVoicePrint,
} from "@t3tools/tessaya-contracts";
import { toneFor } from "@t3tools/tessaya-shared/expressionMap";

export { TurnOrigin, type VesselKind } from "./TurnOrigin.ts";

export interface TurnEnvelope {
  readonly vessel: { readonly kind: VesselKind; readonly id: string };
  /** How approvals, replies and the Record name the vessel that heard it ("Tessel", "desktop", "phone"). */
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
  /** Where her voice plays now, live from the vessel that heard it; over any older record of the device's. */
  readonly plays?: "bt" | "onboard" | undefined;
  /** Her volume now (0-100), live from the vessel; over the device record, which may be another hub's. */
  readonly volume?: number | undefined;
  /** The app in front, for a vessel with a screen ("excel.exe"): which of his skills fit. */
  readonly app?: string | null | undefined;
  /** The project the turn is about (the focused session's); other projects' items stay out. */
  readonly project?: string | null | undefined;
  /** His IANA zone, so "yesterday" is his day. */
  readonly timeZone?: string | undefined;
  /** How his voice sounded, where the vessel hears it (the room's SenseVoice label: "happy", "sad"...). */
  readonly emotion?: string | undefined;
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
  /**
   * A voice that is no member: this turn's speaker embedding (numbers, never audio), so the people graph knows them
   * next time (HOUSEHOLD-DESIGN §11). Sent only for a guest's voice.
   */
  readonly print?: TessayaVoicePrint | undefined;
  /** Each word with the recogniser's confidence (transcript repair, V-018); absent where the vessel has none. */
  readonly words?: ReadonlyArray<HeardWord> | undefined;
  /** The recogniser that heard `words`, whose calibrated bounds judge them ("parakeet-tdt-v3"). */
  readonly recogniser?: string | undefined;
  /** How their sound came in, measured by the vessel (inputQuality.ts); she mentions it when it was not good. */
  readonly input?: InputQuality | undefined;
  /**
   * One speaker of a group turn (M-021): its reply is kept under its name, and only the first speaker keeps and
   * learns from his words, so they are not kept once per persona.
   */
  readonly group?: { readonly name: string; readonly first: boolean } | undefined;
  /**
   * A private moment's turn (PersonaLayers.ts): it reads all she reads, and leaves no words on shared views (the
   * action log, used-memory marks); her own board shows only that it happened. Its words stay sealed in the layer.
   */
  readonly private?: boolean | undefined;
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
  "t3/tessaya/TessayaTurn/SessionMember",
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

/** His own voice on this very turn's audio: kept as his, forgets for him, gives a standing yes or a signed approval. */
const hisVoice = (speaker: SpeakerLike | null) =>
  speaker?.kind === "owner" && ownVoiceVerified(speaker);

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

/**
 * The member a turn shows and moves her relationship with (EMOTION-SYSTEM §4, Director 16 Nov): their verified voice or
 * their own device, said to her, alone, never a replay. Null (a guest, an unsure voice, a shared room) is the general
 * mood only: nobody's relationship is shown to anyone else.
 */
export const moodMember = (turn: TurnEnvelope): string | null => {
  const { member, assurance } = turnIdentity(turn);
  return assurance >= 2 &&
    turn.speaker?.lifted !== true &&
    turn.rehearsal !== true &&
    turn.addressed !== false &&
    turn.sharedRoom !== true
    ? member
    : null;
};

/**
 * The origin a turn's tool calls run under. A verdict his session carries (`session`, lifted) reads and talks as him but
 * acts at A1: owner acts, accounts, consent and signed approvals need this turn's own score or a step-up (REQ-13-089).
 */
export const originOf = (turn: TurnEnvelope) => {
  const identity = turnIdentity(turn);
  const carried = turn.speaker?.session === true || turn.speaker?.lifted === true;
  return {
    ...turn.vessel,
    label: turn.origin ?? turn.vessel.kind,
    hisVoice: hisVoice(turn.speaker ?? null),
    speaker: turn.speaker ?? null,
    ...identity,
    assurance: carried ? (Math.min(identity.assurance, 1) as Assurance) : identity.assurance,
    tainted: turn.tainted === true,
    persona: turn.persona ?? null,
    rehearsal: turn.rehearsal === true,
  };
};

/** Forget's answer to any voice but his verified one, also what a replay hears (it is never verified). */
export const NOT_HIS_VOICE_TO_FORGET =
  "I can forget that only when I know it's your voice. You can forget it in Memory on your desktop or phone.";

/** How a guest reads in "who's here": the people graph names them only to the owner. */
const GUEST_NAME = "a guest";
/** Someone at the vessel whose voice was not heard for this long has been quiet in the group. */
const QUIET_MINUTES = 10;
/** Her mood as the room may hear it: what is one person's (why, opinion, shared story) stays out (MA-021). */
const privateOut = (v: AffectView): AffectView => ({ ...v, why: [], impression: null, shared: [] });
/** Where a turn came from, for what it teaches: its vessel and, when it has one, its ref. */
const turnSource = (turn: TurnEnvelope) =>
  `vessel:${turn.vessel.kind}:${turn.vessel.id}${turn.turnRef === undefined ? "" : `:${turn.turnRef}`}`;

/** One member she has lately heard, or whose devices are connected, and which of the two backs the guess. */
export interface WhoIsHome {
  /** A member id, or a guest's people-graph id. */
  readonly member: string;
  /** Someone she heard who is no member: present, never named or followed here. */
  readonly guest: boolean;
  readonly name: string;
  /** Last verified voice or own-device turn: where (the vessel, "Tessel", "desktop"), its id, and how long ago. */
  readonly heard: {
    readonly via: string;
    readonly vessel: string;
    readonly minutesAgo: number;
  } | null;
  /** Their own devices: how many are connected now, and minutes since one was (0 while connected). */
  readonly devices: { readonly connected: number; readonly minutesAgo: number } | null;
  /** Fused confidence at or over PRESENCE_BARS.around: heard in about the last half hour, or a device connected now. */
  readonly likelyHome: boolean;
  /** Fused confidence they are around, 0..1. */
  readonly confidence: number;
  /** The vessel they are most likely nearest (its name), and how sure. */
  readonly nearest: {
    readonly vessel: string;
    readonly name: string;
    readonly confidence: number;
  } | null;
  /** Why, strongest first, in words ("heard your voice on Tessel, 3 min ago"). */
  readonly reasons: ReadonlyArray<string>;
}

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

/**
 * Her words when the voice is near his but not proven (the Director, 20 Nov): she keeps it and checks, never refuses,
 * and never takes a spoken yes as proof.
 */
export const UNSURE_LINE =
  'This voice sounds like him but was not verified. If he asks you to remember or note something, say "Got it" and that you\'ll check it was him; never say it is saved for him and never say you can\'t remember it. You may ask once, briefly, "Is that you?", but a yes out loud is not proof: it stays unconfirmed until his voice or his phone confirms it.';

/** Voice ID judges every turn afresh: what she may say of it (G-29, 21 Nov: "now confirmed", then "I overstated"). */
const VOICE_FRESH =
  "Voice ID judges every turn afresh, so a turn it verifies and the next it does not are both right: if you speak of whether it is him, say only what this line says of this turn, never that an earlier turn was wrong, never that it is settled from now on, and never its score as a percentage or a chance.";

/** What Voice ID says of this turn, in her words: the only ground she has for saying whether it is him. */
export const voiceLine = (speaker: SpeakerLike | null | undefined): string => {
  if (speaker?.kind !== "owner" || speaker.voiceIdOff === true) return "";
  if (!speaker.verified) return `${UNSURE_LINE} ${VOICE_FRESH}`;
  const how =
    speaker.session === true
      ? "Voice ID holds this voice verified as him on this turn, by his session's recent turns."
      : "Voice ID verified this voice as him on this turn's own audio.";
  return `${how} ${VOICE_FRESH}`;
};

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
  /**
   * How she feels toward the speaker and why, and how to be with them (mood, understanding, the room): hers, so a
   * vessel puts it as her own line, not inside the quoted memory. "" when the mood is off or nobody is addressed.
   */
  readonly feeling: string;
  /** The tone her voice may take for this reply (`toneFor` her feeling), offered to a speaking vessel; null is plain. */
  readonly tone: AffectVariant | null;
  /** The ids matched to this sentence, best first: the same for every vessel given the same words and persona. */
  readonly ids: ReadonlyArray<string>;
  /** The speaker's own private memories, only when the gate allows it; else "". */
  readonly privateBlock: string;
  /** The conversation so far on any vessel, oldest first (empty after a quiet spell). */
  readonly conversation: { readonly key: string; readonly turns: ReadonlyArray<ConversationTurn> };
  /** How the person she is talking to likes things (their own, never another member's); empty for a guest. */
  readonly preferences: Readonly<Partial<Record<PreferenceKey, string>>>;
  /** Who she is talking to: the member and what to call them (their `name` preference, else their member name). */
  readonly who: {
    readonly member: string | null;
    readonly name: string | null;
    /** The people graph's id for a voice that is no member (MA-021's key for a stranger); null otherwise. */
    readonly person?: string | null;
  };
  /** The persona's line about him (`ownerLine`): only on his own untainted turns, else "". */
  readonly owner?: string;
  /** How the words were heard (V-018): absent when taken as heard; "drop" means the vessel answers nothing. */
  readonly repair?: Exclude<RepairVerdict, { kind: "accept" }>;
}

/** The most one turn's "where you are" line may add (P8): a few dozen tokens, flat however many people are home. */
// room for her embodiment (M-077) beside the readings; still one bounded line
const HERE_MAX_CHARS = 700;

/**
 * Where she is this turn (SPINE-UNIFY §10, P8; PERSONA-MODEL-AUDIT CS0): the vessel she speaks through, the body and
 * room it is in, what it can do and its state now, and who is home. Only what the registry knows; private items left
 * out. Empty when there is nothing to say.
 */
export const hereLine = (
  device: RegisteredDevice | null,
  home: ReadonlyArray<string> | null,
  now: number,
  plays?: "bt" | "onboard",
  volume?: number,
  embody?: { readonly also: ReadonlyArray<BodyNow>; readonly crew: ReadonlyArray<string> },
): string => {
  const parts: string[] = [];
  if (device !== null) {
    const valueOf = (id: string) => device.values.find((x) => x.itemId === id);
    const value = (id: string) => {
      const v = valueOf(id)?.value;
      return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
    };
    const body = value("body.current");
    const room = value("body.room");
    parts.push(
      `You are speaking through ${device.name}${body === null ? "" : `, in ${body}`}${room === null ? "" : `, in the ${room}`}: this turn came through it, so it is on and hears him.`,
    );
    // He talks to her through it while the registry has it offline (17 Nov): the link is down, not its power.
    if (!device.online)
      parts.push(
        "Its link to this server is down just now: its readings may be old and a change sent to it may not arrive.",
      );
    // the body she is in here, and what it lets her feel and show (M-077)
    const felt = bodyLine(device.items);
    if (felt !== "") parts.push(felt);
    // Live from the device this turn (18 Nov, 00:38: a day-old "output speaker" told him his headphones had not taken).
    if (plays !== undefined)
      parts.push(
        `Your voice plays ${plays === "bt" ? "through Bluetooth (his headphones or speaker)" : "on its own speaker"} right now, live from it.`,
      );
    if (volume !== undefined) parts.push(`Its volume is ${volume}% right now, live from it.`);
    const open = device.items
      .filter((i) => i.privacy !== true && i.group !== "body")
      .filter((i) => plays === undefined || !LIVE_FROM_VESSEL.has(i.id))
      .filter((i) => volume === undefined || i.id !== "audio.volume")
      .toSorted((a, b) => hereRank(a.id) - hereRank(b.id));
    // He said the battery is irrelevant while it charges (16 Nov), so it is not there to be said.
    const charging = valueOf("power.charging")?.value === true;
    const read = open
      .filter((i) => !(charging && i.id === "power.battery_pct"))
      .flatMap((i) => {
        const v = valueOf(i.id);
        if (
          v === undefined ||
          (typeof v.value !== "number" &&
            typeof v.value !== "boolean" &&
            typeof v.value !== "string")
        )
          return [];
        const age = now - Date.parse(v.at);
        return [
          `${i.label} ${String(v.value)}${i.unit === undefined ? "" : i.unit}${age > HERE_FRESH_MS ? ` (as of ${agoWords(age)})` : ""}`,
        ];
      });
    if (read.length > 0) parts.push(`Last reported: ${read.slice(0, 6).join(", ")}.`);
    const can = open.filter((i) => i.access.includes("write")).map((i) => i.label);
    if (can.length > 0) parts.push(`It can: ${can.slice(0, 8).join(", ")}.`);
  }
  if (home !== null && home.length > 0) parts.push(`Likely home: ${home.slice(0, 8).join(", ")}.`);
  const also = embody === undefined ? "" : alsoLine(embody.also, embody.crew);
  if (also !== "") parts.push(also);
  const line = parts.join(" ");
  return line.length <= HERE_MAX_CHARS ? line : `${line.slice(0, HERE_MAX_CHARS - 1)}…`;
};

/** Readings the vessel's own live word replaces: where her voice plays. */
const LIVE_FROM_VESSEL: ReadonlySet<string> = new Set([
  "audio.output",
  "audio.playing",
  "audio.device",
]);

/** What a turn on a body most needs of its readings: whose eyes it shows and where its voice plays, first. */
const HERE_FIRST = ["eye.persona", "audio.output", "audio.device", "power.charging"];
const hereRank = (id: string) => {
  const at = HERE_FIRST.indexOf(id);
  return at === -1 ? HERE_FIRST.length : at;
};
/** A reading older than this is given with its age: the device may have changed since. */
const HERE_FRESH_MS = 15 * 60_000;
/** How long a face shown for someone else still needs explaining to the next speaker there. */
const FACE_FOR_MS = 10 * 60_000;
const agoWords = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min < 90
    ? `${min} min ago`
    : min < 36 * 60
      ? `${Math.round(min / 60)} h ago`
      : `${Math.round(min / 1440)} days ago`;
};

/** The presence board's ceiling (the bounded-context rule): about 100 tokens, however many talk to her at once. */
const BOARD_MAX_CHARS = 400;

/**
 * Her other live conversations, as this turn may see them (CS2): the owner hears who each is with, where, how long
 * ago and what his own are about (D1), a private moment only as one; anyone else only how many; a guest nothing.
 */
export const boardLine = (
  others: ReadonlyArray<{
    readonly persona: string;
    readonly person: string;
    readonly where: string;
    readonly minutesAgo: number;
    readonly about?: string | null | undefined;
    readonly private?: boolean | undefined;
    readonly doing?: string | null | undefined;
  }>,
  viewer: "owner" | "member" | "guest",
): string => {
  if (others.length === 0 || viewer === "guest") return "";
  if (viewer === "member")
    return `You are also in ${others.length} other conversation${others.length === 1 ? "" : "s"} now; say nothing of them.`;
  const rows = others
    .slice(0, 6)
    .map(
      (o) =>
        `${o.persona} with ${o.person} on ${o.where} (${o.minutesAgo} min ago)${o.private === true ? ", a private moment" : `${o.about ? `, about ${o.about}` : ""}${o.doing ? `, ${o.doing}` : ""}`}`,
    );
  const line = `Your other conversations now (mention one only if it matters here): ${rows.join("; ")}.`;
  return line.length <= BOARD_MAX_CHARS ? line : `${line.slice(0, BOARD_MAX_CHARS - 1)}…`;
};

export const handOffLine = (from: string): string =>
  `${from} handed this conversation to you: carry on from where it is, without a greeting or starting over.`;

/** A closed thread or conversation stays in the store this long past its idle boundary, then is swept. */
const KEPT_CLOSED_MS = 24 * 60 * 60_000;
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
// Rows only this file writes: a bad one is skipped, not trusted.
const parsedOr = <A>(json: string, fallback: A) =>
  decodeJson(json).pipe(
    Effect.map((v) => v as A),
    Effect.orElseSucceed(() => fallback),
  );
/** How much of a conversation every vessel shares, and how long it waits for him to go on. */
const CONVERSATION_TURNS = 24;
const CONVERSATION_IDLE_MS = SAME_CONVERSATION_MS;
/** The room transcript is kept as long as the Record (ActionLog's 30 days). */
const TRANSCRIPT_KEEP_MS = 30 * 86_400_000;
/** What a private moment leaves in the transcript: only that it happened. */
export const PRIVATE_LINE = "(a private moment)";
/** One line of the room's transcript. */
export interface TranscriptLine {
  readonly at: number;
  readonly vessel: string;
  readonly conversation: string;
  readonly role: "them" | "her";
  /** The member who spoke (their words only), or null for a guest or an unsure voice. */
  readonly who: string | null;
  readonly text: string;
  readonly private: number;
}
/** How soon after a vessel's last exchange a turn Voice ID could not judge still continues it. */
const THREAD_CARRY_MS = 2 * 60_000;
/** A dictation this recent may be the turn it became; older words were typed again. */
const DICTATION_FRESH_MS = 2 * 60_000;

/** Standing memory a sessionless turn carries, as a session's system prompt does (MEMORY.md §5). */
const STANDING_TOKENS = 600;
/** What one sentence adds, as the desktop's per-sentence block. */
const SENTENCE_TOKENS = 300;
/** Recall also asks with the conversation's last messages, so "and her?" finds who "her" is (VOXTA-STUDY G5). */
const RECALL_WINDOW = 10;

/** Why a turn teaches memory nothing, or null when it may. */
export const notLearnable = (turn: TurnEnvelope): string | null => {
  if (turn.addressed === false) return "not said to her";
  if (turn.rehearsal === true) return "a rehearsal";
  if (turn.group?.first === false) return "a later speaker in a group";
  // Until the household model (HOUSEHOLD-DESIGN.md), only his voice (or any, where Voice ID cannot run) teaches his store.
  if (turn.speaker != null && memberOfSpeaker(turn.speaker) !== OWNER_MEMBER_ID)
    return "not the owner's voice";
  // Voice ID is the guard: only his voice verified (or a vessel with no Voice ID, typed or his own device) teaches
  // his memory; a voice only near his, carried over or lifted by his session goes to nobody's store.
  if (
    turn.speaker != null &&
    turn.speaker.voiceIdOff !== true &&
    (voiceAssurance(turn.speaker) < 2 || turn.speaker.lifted === true)
  )
    return "his voice not verified";
  // A member's own device typed it: their words never teach his store (HOUSEHOLD-DESIGN §6).
  if (turn.member !== undefined && turn.member !== OWNER_MEMBER_ID) return "not the owner's device";
  return null;
};

/** The event a turn's mood changes are kept against: its own ref, else its vessel at this moment. */
const causeOf = (turn: TurnEnvelope) =>
  Effect.map(Clock.currentTimeMillis, (now) => ({
    ref: turn.turnRef === undefined ? `${turnSource(turn)}@${now}` : turnSource(turn),
    vessel: turn.vessel.id,
  }));

/** A verified turn on the same vessel this soon after places what a voice near theirs said (the Director, 20 Nov). */
const UNSURE_CONFIRM_MS = 30 * 60_000;

/**
 * What an owner-labelled voice below the act bar teaches: held as "not sure who" (never merged, never lost) until his
 * verified voice, his own device or Voice ID proves it was him. Null when the turn is not that case.
 */
export const unsureOf = (turn: TurnEnvelope): MemoryUnsure | null =>
  notLearnable(turn) === "his voice not verified" && turn.speaker?.kind === "owner"
    ? {
        turn: turnSource(turn),
        conversation: conversationKey(turn),
        vessel: turn.vessel.id,
        nearest: OWNER_MEMBER_ID,
        confidence: turn.speaker.confidence ?? null,
      }
    : null;

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
  /** Where he is with her in it. */
  readonly surface: "voice" | "desk" | "window" | "phone" | "group";
  /** A private moment's thread is its own row, seen by her public self only as "a private moment", never its words. */
  readonly tier: "public" | "private";
  /** What it is about now, a few words; only ever for his own public threads. */
  readonly gist: string | null;
  /** When he last spoke or typed in it. */
  readonly presentAt: number | null;
  /** What she is doing in it now (a scene playing on her body), and until when; never for a private thread. */
  readonly doing?: { readonly what: string; readonly until: number } | null;
}

export const surfaceOf = (turn: TurnEnvelope): LiveThread["surface"] =>
  turn.group !== undefined
    ? "group"
    : turn.vessel.kind === "device"
      ? "voice"
      : turn.vessel.kind === "desktop"
        ? "desk"
        : turn.vessel.kind === "phone"
          ? "phone"
          : "window";

const GIST_WORD = /[a-z][a-z']{3,}/g;
const NOT_TOPIC = new Set(
  "what that this with have just your about there they them would could should please thanks okay yeah really going want like know think make tell then when where which will from been were into some more also back right sure".split(
    " ",
  ),
);
const topicWords = (text: string) =>
  new Set((text.toLowerCase().match(GIST_WORD) ?? []).filter((w) => !NOT_TOPIC.has(w)));
/**
 * Whether his sentence moved the thread's topic, so its gist is written again (only on new evidence, as MA-024).
 * shortcut: shared words with the gist, not meaning; replace with the embedder's similarity if gists churn or stick.
 */
export const topicMoved = (gist: string | null, said: string): boolean => {
  const words = topicWords(said);
  if (words.size < 3) return false;
  if (gist === null) return true;
  const known = topicWords(gist);
  return ![...words].some((w) => known.has(w));
};
const GIST_MAX = 80;
const Gist = Schema.Struct({ gist: Schema.String });

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
    /** The room's exchanges between `from` and `to` (ms), oldest first: their words and hers, a private one noted. */
    readonly transcript: (from: number, to: number) => Effect.Effect<ReadonlyArray<TranscriptLine>>;
    /** What his memories say is coming up this week, as the caller may see them (Memory v2 step 8). */
    readonly comingUp: Effect.Effect<
      ReadonlyArray<{
        readonly text: string;
        readonly when: string;
        readonly kind: string;
        /** When that day begins in his zone. */
        readonly at: number;
      }>
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
    /** Forgets by id into the bin, or puts back from it, only for his verified voice; otherwise says where he can. */
    readonly forget: (id: string, restore?: boolean) => Effect.Effect<string>;
    /**
     * "That wasn't me, it was the kids": what she put down to the person speaking (verified, or their own device) moves
     * to whoever it was, or to nobody known. Her feelings from it are taken back and what she learned from it goes back
     * to "not sure who". One event (`ref`), or the last `minutes` of what was only assumed to be them (a desk touch),
     * or on one vessel. The line to say.
     */
    readonly reassign: (input: {
      readonly to?: string | undefined;
      readonly ref?: string | undefined;
      readonly vessel?: string | undefined;
      readonly minutes?: number | undefined;
    }) => Effect.Effect<string>;
    /**
     * One fact she understands of the person speaking (their own voice or device) or of herself (his voice), forgotten
     * once confirmed, or put back from the bin.
     */
    readonly understandingFact: (input: {
      readonly fact: string;
      readonly about?: "them" | "herself" | undefined;
      readonly confirmed?: boolean | undefined;
      readonly restore?: boolean | undefined;
    }) => Effect.Effect<string>;
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
    /** A worker's change to her one conversation list, applied on her brain. */
    readonly threadAct: (
      act: ThreadAct,
    ) => Effect.Effect<ReadonlyArray<LiveThread> | ReadonlyArray<TranscriptLine> | null>;
    /** What she is doing in one of her threads (its id, as body focus names it) until `until`; null clears it. */
    readonly setDoing: (
      thread: string,
      doing: { readonly what: string; readonly until: number } | null,
    ) => Effect.Effect<void>;
    /** The model's hand-off of this turn's conversation to another persona, or back (CS8). */
    readonly handOff: (input: {
      readonly to?: string | undefined;
      readonly back?: boolean | undefined;
    }) => Effect.Effect<{ readonly line: string; readonly persona?: string }>;
  }
>()("t3/tessaya/TessayaTurn") {}

/** One change to her conversation list, sent by a worker to her brain. */
export type ThreadAct =
  | { readonly a: "keep"; readonly id: string; readonly row: unknown }
  | { readonly a: "drop"; readonly id: string }
  | {
      readonly a: "doing";
      readonly thread: string;
      readonly doing: { readonly what: string; readonly until: number } | null;
    }
  | { readonly a: "list"; readonly persona: string | null }
  | { readonly a: "said"; readonly lines: ReadonlyArray<TranscriptLine> }
  | { readonly a: "transcript"; readonly from: number; readonly to: number };

export const make = Effect.gen(function* () {
  const memory = yield* TessayaMemoryService;
  const learning = yield* TessayaMemoryLearning;
  const stores = yield* Effect.serviceOption(TessayaPrivateMemoryService);
  const jobService = yield* Effect.serviceOption(TessayaJobService);
  const workSessionService = yield* Effect.serviceOption(WorkSessionService);
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

  /**
   * A guest's voice, filed in the people graph on the household's home (HOUSEHOLD-DESIGN §11): who they are, if she has
   * met them, and her line for them. Never a member's voice, a shared room's mixed one, or a replay.
   */
  const personFor = Effect.fn("TessayaTurn.personFor")(function* (turn: TurnEnvelope) {
    if (
      turn.print === undefined ||
      turn.rehearsal === true ||
      turn.sharedRoom === true ||
      turn.speaker?.kind !== "guest"
    )
      return null;
    const household = yield* Effect.serviceOption(TessayaHousehold);
    if (Option.isNone(household)) return null;
    const heard = yield* household.value
      .call({
        op: "peopleObserve",
        vessel: turn.vessel.id,
        said: turn.text.slice(0, 400),
        print: turn.print,
      })
      .pipe(
        Effect.provideService(HouseholdCaller, {
          member: null,
          assurance: 0,
          via: "Tessaya, hearing a voice",
          heard: true,
        }),
      );
    return heard.person ?? null;
  });

  /** The household's own call (routed to the home when it lives elsewhere), as this member asking for themselves. */
  const askHousehold = Effect.fn("TessayaTurn.askHousehold")(function* (
    input: TessayaHouseholdCallInput,
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
    const recalled = yield* stores.value
      .recall({
        turn: asked,
        text: turn.text,
        persona: turn.persona ?? null,
        // only an open private moment (the layer's gate held) reads that moment's own notes
        moment: turn.private === true,
      })
      .pipe(
        Effect.provideService(PrivateCaller, {
          session: vesselSubject(turn.vessel.id),
          desktop: true,
          member: memberOfSubject(vesselSubject(turn.vessel.id)),
        }),
        Effect.option,
      );
    return Option.isSome(recalled) ? recalled.value.block : "";
  });

  // Kept on this server's store too, so a restart or a standby carries on where he was (architecture §1.3).
  const conversations = new Map<string, { at: number; turns: Array<ConversationTurn> }>();
  const keptSince = (yield* Clock.currentTimeMillis) - CONVERSATION_IDLE_MS;
  yield* sql`DELETE FROM tessaya_conversations WHERE at <= ${keptSince - KEPT_CLOSED_MS}`.pipe(
    Effect.ignore,
  );
  for (const r of yield* sql<{ key: string; at: number; turns: string }>`
    SELECT key, at, turns FROM tessaya_conversations WHERE at > ${keptSince}
  `.pipe(Effect.orElseSucceed(() => []))) {
    const turns = yield* parsedOr<Array<ConversationTurn>>(r.turns, []);
    if (turns.length > 0) conversations.set(r.key, { at: Number(r.at), turns });
  }
  /** Conversations whose last turn here was not a private moment (sinceFor). */
  const endedOpen = new Set<string>();
  /** The conversation each vessel last spoke in. */
  const lastOn = new Map<string, { key: string; at: number }>();
  /**
   * A turn too short for Voice ID to judge goes on with the conversation its vessel was just in: "Can you?" after
   * his verified question was answered with no thread at all (17 Nov). A guest or another member never does.
   */
  const keyOf = (turn: TurnEnvelope, now: number) => {
    const key = conversationKey(turn);
    const last = lastOn.get(turn.vessel.id);
    return key === "household" &&
      turn.speaker?.kind === "unverified" &&
      last !== undefined &&
      now - last.at <= THREAD_CARRY_MS
      ? last.key
      : key;
  };
  const conversationOf = Effect.fn("TessayaTurn.conversation")(function* (turn: TurnEnvelope) {
    const now = yield* Clock.currentTimeMillis;
    const key = keyOf(turn, now);
    const held = conversations.get(key);
    const turns = held === undefined || now - held.at > CONVERSATION_IDLE_MS ? [] : held.turns;
    return {
      key,
      // Carried over, only what was said aloud through this vessel: its room heard that already.
      turns:
        key === conversationKey(turn)
          ? [...turns]
          : turns.filter((t) => t.vessel === turn.vessel.id),
    };
  });
  /**
   * After a quiet spell the conversation starts afresh, so how long it has been and what he said last is the turn's
   * own line (`sinceLine`): hours after "I'll sleep for a bit" she can tell he is back (presence-diagnosis 20 Nov).
   */
  const sinceFor = (turn: TurnEnvelope, now: number, zone: string | undefined): string => {
    if (turn.rehearsal === true) return "";
    const key = keyOf(turn, now);
    const held = conversations.get(key);
    // Only a conversation this server saw end in the open: a private moment's words never come back here.
    if (held === undefined || now - held.at <= CONVERSATION_IDLE_MS || !endedOpen.has(key))
      return "";
    const said = held.turns.findLast((t) => t.role === "user")?.content;
    if (said === undefined) return "";
    return (
      sinceLine({ at: DateTime.formatIso(DateTime.makeUnsafe(held.at)), said }, now, zone) ?? ""
    );
  };
  let transcriptSweptAt = 0;
  const transcriptHere = (from: number, to: number) =>
    sql<TranscriptLine>`
      SELECT at, vessel, conversation, role, who, text, private FROM tessaya_room_transcript
      WHERE at >= ${from} AND at < ${to} ORDER BY seq LIMIT 2000
    `.pipe(Effect.orElseSucceed((): ReadonlyArray<TranscriptLine> => []));
  /** The day's transcript is kept once, on her brain: a worker sends its lines up (queued while she's away). */
  const transcript = Effect.fn("TessayaTurn.transcript")(function* (from: number, to: number) {
    if (!(yield* brain.isBrain)) {
      yield* brain.replay();
      const theirs = yield* brain.send("threads", { a: "transcript", from, to });
      if (Option.isSome(theirs) && Array.isArray(theirs.value))
        return theirs.value as ReadonlyArray<TranscriptLine>;
    }
    return yield* transcriptHere(from, to);
  });
  const keepLines = Effect.fn("TessayaTurn.keepLines")(function* (
    lines: ReadonlyArray<TranscriptLine>,
  ) {
    if (!(yield* brain.isBrain)) {
      yield* brain.sendOrQueue("threads", { a: "said", lines });
      return;
    }
    for (const l of lines)
      yield* sql`
        INSERT INTO tessaya_room_transcript (at, vessel, conversation, role, who, text, private)
        VALUES (${l.at}, ${l.vessel}, ${l.conversation}, ${l.role}, ${l.who}, ${l.text}, ${l.private})
      `.pipe(Effect.ignore);
    const now = yield* Clock.currentTimeMillis;
    if (now - transcriptSweptAt > 3_600_000) {
      transcriptSweptAt = now;
      yield* sql`DELETE FROM tessaya_room_transcript WHERE at < ${now - TRANSCRIPT_KEEP_MS}`.pipe(
        Effect.ignore,
      );
    }
  });
  const addExchange = Effect.fn("TessayaTurn.converse")(function* (
    turn: TurnEnvelope,
    reply: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const key = keyOf(turn, now);
    lastOn.set(turn.vessel.id, { key, at: now });
    const held = conversations.get(key);
    const turns = held === undefined || now - held.at > CONVERSATION_IDLE_MS ? [] : held.turns;
    const said: Array<ConversationTurn> = [
      ...(turn.group?.first === false
        ? []
        : [{ role: "user" as const, content: turn.text, vessel: turn.vessel.id }]),
      ...(reply.trim() === ""
        ? []
        : [
            {
              role: "assistant" as const,
              content: turn.group === undefined ? reply : `${turn.group.name}: ${reply}`,
              vessel: turn.vessel.id,
            },
          ]),
    ];
    const kept = [...turns, ...said].slice(-CONVERSATION_TURNS);
    conversations.set(key, { at: now, turns: kept });
    if (turn.private === true) endedOpen.delete(key);
    else endedOpen.add(key);
    // The day's transcript keeps every exchange (the conversation above keeps only its last few).
    if (turn.rehearsal !== true && said.length > 0) {
      const who = turnIdentity(turn).member;
      yield* keepLines(
        said.map((t) => ({
          at: now,
          vessel: turn.vessel.id,
          conversation: key,
          role: t.role === "user" ? ("them" as const) : ("her" as const),
          who: t.role === "user" ? who : null,
          text: turn.private === true ? PRIVATE_LINE : recordText(t.content, 2000),
          private: turn.private === true ? 1 : 0,
        })),
      ).pipe(Effect.ignore);
    }
    yield* encodeJson(kept).pipe(
      Effect.flatMap(
        (json) => sql`
          INSERT INTO tessaya_conversations (key, at, turns) VALUES (${key}, ${now}, ${json})
          ON CONFLICT (key) DO UPDATE SET at = excluded.at, turns = excluded.turns
        `,
      ),
      Effect.ignore,
    );
  });

  const live = new Map<string, LiveThread>();
  yield* sql`DELETE FROM tessaya_live_threads WHERE at <= ${keptSince - KEPT_CLOSED_MS}`.pipe(
    Effect.ignore,
  );
  for (const r of yield* sql<{ id: string; row: string }>`
    SELECT id, row FROM tessaya_live_threads WHERE at > ${keptSince}
  `.pipe(Effect.orElseSucceed(() => []))) {
    const row = yield* parsedOr<LiveThread | null>(r.row, null);
    if (row !== null) live.set(r.id, row);
  }
  /**
   * Her conversation list lives once, on her brain. A worker keeps only an in-memory cache of what it wrote (for its own
   * next turn) and sends each change there; with the brain away the change waits in the outbox, in order, and lands once.
   */
  const brain = yield* makeBrainLink;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  let movedUp = false;
  /** A worker's own rows from before the brain held them go up once (dry-run count, a copy kept), then are deleted. */
  const moveUp = Effect.fn("TessayaTurn.threadsMoveUp")(function* () {
    if (movedUp) return;
    const rows = yield* sql<{
      id: string;
      row: string;
    }>`SELECT id, row FROM tessaya_live_threads`.pipe(Effect.orElseSucceed(() => []));
    if (rows.length === 0) return void (movedUp = true);
    yield* emitAction({
      kind: "threads.move",
      actor: { kind: "rule", id: "oneBrain", certainty: 1 },
      outcome: "dryRun",
      data: { rows: rows.length },
    });
    if (Option.isNone(config)) return;
    const kept = NodePath.join(config.value.stateDir, "live-threads.before-brain.json");
    yield* Effect.sync(() => {
      if (!NodeFS.existsSync(kept)) NodeFS.writeFileSync(kept, `${JSON.stringify(rows)}\n`);
    });
    let sent = 0;
    for (const r of rows) {
      const row = yield* parsedOr<LiveThread | null>(r.row, null);
      if (row === null) continue;
      // sent now, or queued in order for when the brain is back: either way it is no longer this server's
      yield* brain.sendOrQueue("threads", { a: "keep", id: r.id, row });
      sent++;
    }
    yield* sql`DELETE FROM tessaya_live_threads`.pipe(Effect.ignore);
    movedUp = true;
    yield* emitAction({
      kind: "threads.move",
      actor: { kind: "rule", id: "oneBrain", certainty: 1 },
      outcome: "moved",
      data: { rows: sent },
    });
  });
  const keepThread = Effect.fn("TessayaTurn.keepThread")(function* (id: string, row: LiveThread) {
    live.set(id, row);
    if (!(yield* brain.isBrain)) {
      yield* moveUp();
      yield* brain.sendOrQueue("threads", { a: "keep", id, row });
      return;
    }
    yield* encodeJson(row).pipe(
      Effect.flatMap(
        (json) => sql`
          INSERT INTO tessaya_live_threads (id, at, row) VALUES (${id}, ${row.lastAt}, ${json})
          ON CONFLICT (id) DO UPDATE SET at = excluded.at, row = excluded.row
        `,
      ),
      Effect.ignore,
    );
  });
  const dropThread = (id: string) =>
    Effect.sync(() => live.delete(id)).pipe(
      Effect.andThen(
        Effect.flatMap(brain.isBrain, (here) =>
          here ? Effect.void : Effect.asVoid(brain.sendOrQueue("threads", { a: "drop", id })),
        ),
      ),
      Effect.andThen(sql`DELETE FROM tessaya_live_threads WHERE id = ${id}`.pipe(Effect.ignore)),
    );
  const threadId = (turn: TurnEnvelope) =>
    `${turn.persona ?? ""}|${conversationKey(turn)}${turn.private === true ? "|private" : ""}`;
  const current = yield* Effect.serviceOption(CurrentPersona);
  const cast = yield* Effect.serviceOption(TessayaCast);
  const touchThread = Effect.fn("TessayaTurn.touchThread")(function* (turn: TurnEnvelope) {
    if (turn.rehearsal === true || turn.addressed === false) return;
    const conversation = conversationKey(turn);
    const persona = turn.persona ?? null;
    const id = threadId(turn);
    const now = yield* Clock.currentTimeMillis;
    const held = live.get(id);
    const person =
      turn.speaker?.verified === true && turn.speaker.personId !== null
        ? turn.speaker.personId
        : typeof turn.member === "string"
          ? turn.member
          : null;
    if (persona !== null && Option.isSome(current)) yield* current.value.set(conversation, persona);
    if (Option.isSome(cast)) yield* cast.value.touch(turn.vessel.id);
    const fresh = held === undefined || now - held.lastAt > CONVERSATION_IDLE_MS;
    yield* keepThread(id, {
      persona,
      conversation,
      vessel: turn.vessel,
      person,
      openedAt: fresh ? now : held.openedAt,
      lastAt: now,
      surface: surfaceOf(turn),
      tier: turn.private === true ? "private" : "public",
      gist: fresh || turn.private === true ? null : held.gist,
      presentAt: person === OWNER_MEMBER_ID ? now : (held?.presentAt ?? null),
    });
  });

  /**
   * His own public thread's gist, written by the cheap model only when his sentence moved its topic: background work
   * after the reply, never on the way to her first word.
   */
  const gistFor = Effect.fn("TessayaTurn.gist")(function* (turn: TurnEnvelope) {
    const id = threadId(turn);
    const held = live.get(id);
    if (held === undefined || held.tier !== "public" || held.person !== OWNER_MEMBER_ID) return;
    if (!topicMoved(held.gist, turn.text)) return;
    const oneShot = yield* Effect.serviceOption(TessayaOneShot);
    if (Option.isNone(oneShot)) return;
    const lines = (conversations.get(conversationKey(turn))?.turns ?? [])
      .slice(-6)
      .map((t) => `${t.role === "user" ? "He" : "She"}: ${t.content.slice(0, 300)}`)
      .join("\n");
    const out = yield* oneShot.value
      .run({
        prompt: `In at most eight plain words, say what this conversation is about now, as a topic ("the heating schedule", "his trip to Lahore"). No quotes, no full sentence.\n\n${lines}`,
        outputSchema: Gist,
        role: "gist",
        feature: "attention-gist",
      })
      .pipe(Effect.orElseSucceed(() => null));
    const gist = out?.gist.replace(/\s+/g, " ").trim().slice(0, GIST_MAX) ?? "";
    const now = live.get(id);
    if (gist !== "" && now !== undefined) yield* keepThread(id, { ...now, gist });
  });

  // Who had each conversation before its last hand-off (the way back), and the hand-off its new persona is told of once.
  const handedFrom = new Map<string, string>();
  const handedTo = new Map<string, { readonly to: string; readonly from: string }>();
  /**
   * The model's hand-off (CS8, persona_handoff): `to` takes this turn's conversation, or with `back` whoever had it
   * before. Every other persona's live row in it moves to `to`, keeping when it opened.
   */
  const handOff = Effect.fn("TessayaTurn.handOff")(function* (input: {
    readonly to?: string | undefined;
    readonly back?: boolean | undefined;
  }) {
    const origin = yield* TurnOrigin;
    if (origin === null) return { line: "Only a conversation can be handed over." };
    const conversation = conversationKey({
      vessel: origin,
      text: "",
      speaker: origin.speaker,
      member: origin.member,
    });
    const { personas } = yield* personasList;
    const wanted =
      input.back === true ? handedFrom.get(conversation) : input.to?.trim().toLowerCase();
    const target = personas.find(
      (p) => wanted !== undefined && (p.id === wanted || p.name.toLowerCase() === wanted),
    );
    if (target === undefined)
      return {
        line:
          input.back === true
            ? "Nothing was handed over in this conversation to give back."
            : `There is no persona called ${input.to ?? "that"}. Say who should take it.`,
      };
    const now = yield* Clock.currentTimeMillis;
    const rows = [...live.entries()]
      .filter(
        ([, t]) =>
          t.conversation === conversation &&
          t.tier === "public" &&
          now - t.lastAt <= CONVERSATION_IDLE_MS,
      )
      .toSorted(([, a], [, b]) => b.lastAt - a.lastAt);
    const from =
      rows.find(([, t]) => t.persona !== null && t.persona !== target.id)?.[1].persona ??
      (origin.persona !== target.id ? (origin.persona ?? null) : null);
    const mine = rows.find(([, t]) => t.persona === target.id)?.[1] ?? rows[0]?.[1];
    for (const [key, t] of rows) if (t.persona !== target.id) yield* dropThread(key);
    const vessel = mine?.vessel ?? { kind: origin.kind, id: origin.id };
    yield* keepThread(`${target.id}|${conversation}`, {
      persona: target.id,
      conversation,
      vessel,
      person: mine?.person ?? null,
      openedAt: Math.min(now, ...rows.map(([, t]) => t.openedAt)),
      lastAt: now,
      surface: mine?.surface ?? surfaceOf({ vessel, text: "" }),
      tier: "public",
      gist: mine?.gist ?? null,
      presentAt: mine?.presentAt ?? null,
    });
    if (Option.isSome(current)) yield* current.value.set(conversation, target.id);
    const fromName = personas.find((p) => p.id === from)?.name ?? "the persona before";
    if (from !== null) handedFrom.set(conversation, from);
    // On a Tessel the persona must be worn there too, or "Alfred has it from here" is not what he hears (18 Nov).
    const body =
      origin.kind !== "device" || Option.isNone(cast) || origin.persona === target.id
        ? null
        : yield* cast.value
            .call(
              { op: "call", body: origin.id, persona: target.id, stay: false },
              false,
              origin.tainted !== true,
            )
            .pipe(
              Effect.as(null),
              Effect.catch((why: string) => Effect.succeed(why)),
            );
    if (body !== null)
      return {
        line: `${target.name} has this conversation, but this device could not switch to ${target.name} (${body}): say that plainly, never that ${target.name} is here.`,
        persona: target.id,
      };
    // The persona speaking now carries on itself; another one hears it on its next turn.
    if (origin.persona === target.id) return { line: handOffLine(fromName), persona: target.id };
    handedTo.set(conversation, { to: target.id, from: fromName });
    return {
      line: `${target.name} has this conversation now: say so in a few words.`,
      persona: target.id,
    };
  });
  /**
   * What crosses back when a private moment ends (architecture §2b.4, D5): one content-free episode her own everyday
   * self may recall ("we had a private moment this evening"), never its words, and no other persona's.
   */
  const privateTrace = Effect.fn("TessayaTurn.privateTrace")(function* (t: LiveThread) {
    if (t.persona === null) return;
    const minutes = Math.max(1, Math.round((t.lastAt - t.openedAt) / 60_000));
    yield* memory
      .add({
        kind: "episode",
        text: `A private moment with him${t.surface === "voice" ? "" : ` at the ${t.surface}`}, about ${minutes} min. What was said there stays private.`,
        source: "thread",
        sourceRef: `private:${t.openedAt}`,
        visibility: "persona",
        persona: t.persona,
      })
      .pipe(Effect.ignore);
  });

  const setDoing = Effect.fn("TessayaTurn.setDoing")(function* (
    thread: string,
    doing: { readonly what: string; readonly until: number } | null,
  ) {
    if (!(yield* brain.isBrain)) {
      yield* brain.sendOrQueue("threads", { a: "doing", thread, doing });
      return;
    }
    const row = live.get(thread);
    if (row === undefined || row.tier === "private") return;
    yield* keepThread(thread, { ...row, doing });
  });

  const threads = Effect.fn("TessayaTurn.threads")(function* (persona?: string) {
    if (!(yield* brain.isBrain)) {
      yield* moveUp();
      // what waited for the brain lands first, so the list read back holds it
      yield* brain.replay();
      const theirs = yield* brain.send("threads", { a: "list", persona: persona ?? null });
      if (Option.isSome(theirs) && Array.isArray(theirs.value))
        return theirs.value as ReadonlyArray<LiveThread>;
    }
    const now = yield* Clock.currentTimeMillis;
    for (const [id, t] of live)
      if (now - t.lastAt > CONVERSATION_IDLE_MS) {
        yield* dropThread(id);
        if (t.tier === "private" && t.person === OWNER_MEMBER_ID) yield* privateTrace(t);
      }
    return [...live.values()]
      .filter((t) => persona === undefined || t.persona === persona)
      .toSorted((a, b) => b.lastAt - a.lastAt);
  });

  /** A desktop, web or phone turn whose words this server just dictated carries that dictation's sound. */
  const withDictation = Effect.fn("TessayaTurn.dictation")(function* (turn: TurnEnvelope) {
    if (turn.input !== undefined || turn.vessel.kind === "device") return turn;
    const speech = yield* Effect.serviceOption(SpeechService);
    if (Option.isNone(speech)) return turn;
    const heard = yield* speech.value.heard;
    const now = yield* Clock.currentTimeMillis;
    return heard !== null &&
      now - heard.at < DICTATION_FRESH_MS &&
      turn.text.toLowerCase().includes(heard.text.trim().toLowerCase())
      ? { ...turn, input: heard.input }
      : turn;
  });

  /** A typed turn takes its session's member when the vessel did not name one. */
  const withMember = Effect.fn("TessayaTurn.member")(function* (turn: TurnEnvelope) {
    if (turn.member !== undefined || (turn.speaker !== null && turn.speaker !== undefined))
      return turn;
    return { ...turn, member: yield* SessionMember };
  });

  const liveStore =
    Option.getOrUndefined(yield* Effect.serviceOption(TurnLiveContext)) ?? (yield* makeLive);
  /** How the words were heard, judged on the recogniser's own bounds; null when the vessel sent no scores. */
  const repairFor = Effect.fn("TessayaTurn.repairFor")(function* (turn: TurnEnvelope) {
    if (turn.words === undefined) return null;
    const words = turn.words;
    const { personas } = yield* personasList;
    const verdict = repairVerdict(
      words,
      repairBoundsFor(turn.recogniser),
      new Set(personas.map((p) => p.name.toLowerCase())),
    );
    const scores = words.flatMap((w) => (w.p === null ? [] : [w.p]));
    // The verdict carries the words it doubted: a private moment's stay out of the shared log.
    if (turn.private === true) return verdict.kind === "accept" ? null : verdict;
    yield* emitAction({
      kind: "turn.repair.verdict",
      actor: {
        kind: "rule",
        id: turn.recogniser ?? "recogniser",
        certainty: scores.length === 0 ? 0 : Math.min(...scores),
      },
      ...(turn.turnRef === undefined ? {} : { evidence: [{ kind: "turn", ref: turn.turnRef }] }),
      persona: turn.persona ?? null,
      subject: turn.vessel.id,
      outcome: verdict.kind,
      data: verdict,
    });
    return verdict.kind === "accept" ? null : verdict;
  });

  const begin = Effect.fn("TessayaTurn.begin")(function* (raw: TurnEnvelope) {
    const turn = yield* withDictation(yield* withMember(raw));
    const repair = yield* repairFor(turn);
    const conversation = yield* conversationOf(turn);
    // Noise, or words never really heard: no thread, no memory, no mood, no reply.
    if (repair?.kind === "drop")
      return {
        block: "",
        feeling: "",
        tone: null,
        ids: [],
        privateBlock: "",
        conversation,
        preferences: {},
        who: { member: turnIdentity(turn).member, name: null },
        repair,
      } satisfies TurnContext;
    yield* touchThread(turn);
    const view = {
      ...(turn.persona === undefined ? {} : { agent: turn.persona }),
      // Persona x person (P7): a known person's turn reads none of the persona's notes from someone else.
      person:
        turn.speaker?.verified === true && turn.speaker.personId !== null
          ? turn.speaker.personId
          : typeof turn.member === "string"
            ? turn.member
            : null,
      ...(turn.timeZone === undefined ? {} : { timeZone: turn.timeZone }),
      ...(turn.project === undefined ? {} : { scopeRef: turn.project }),
    };
    const standing =
      turn.sessionless === true
        ? memoryBlock(yield* memory.related(view), STANDING_TOKENS)
        : { block: "", ids: [] };
    // The sentence ranks first; the conversation's last messages add what it points back to ("and her?").
    const window = conversation.turns
      .slice(-RECALL_WINDOW)
      .map((t) => t.content)
      .join("\n");
    const { asked, around } = yield* Effect.all(
      {
        asked: memory.related({ ...view, text: turn.text }),
        around: window === "" ? Effect.succeed([]) : memory.related({ ...view, text: window }),
      },
      { concurrency: 2 },
    );
    const first = new Set(asked.map((i) => i.id));
    const added = around.filter((i) => !first.has(i.id));
    const ranked = [...asked, ...added];
    if (window !== "" && turn.private !== true)
      yield* emitAction({
        kind: "turn.recall.window",
        actor: { kind: "rule", id: "recall", certainty: 1 },
        evidence: added.map((i) => ({ kind: "memory", ref: i.id })),
        persona: turn.persona ?? null,
        subject: conversation.key,
        data: { messages: Math.min(RECALL_WINDOW, conversation.turns.length), asked: asked.length },
      });
    // The ids are the sentence's own ranking, the same for every vessel; the text leaves out what standing holds.
    const sentence = memoryBlock(ranked, SENTENCE_TOKENS);
    const held = new Set(standing.ids);
    const extra = memoryBlock(
      ranked.filter((i) => !held.has(i.id)),
      SENTENCE_TOKENS,
    ).block;
    if (turn.turnRef !== undefined && sentence.ids.length > 0 && turn.private !== true)
      yield* memory.markUsed(turn.turnRef, sentence.ids);
    const member = turnIdentity(turn).member;
    const person = yield* personFor(turn);
    yield* notePresence(turn);
    const preferences = yield* preferencesOf(member);
    const waiting = yield* waitingLine(turn, member, preferences.name ?? null);
    // One person's context among several heard at once (beginMany) does not spend the turn again.
    const live = yield* liveStore.take({
      vessel: turn.vessel.id,
      persona: turn.persona ?? null,
      spend: turn.sharedRoom !== true,
    });
    // Her lines name them by name or their own pronouns, never "he" for everyone (MA-021).
    const identified = moodMember(turn) !== null;
    const who: Who = identified
      ? { name: preferences.name ?? (yield* memberName(member)), pronouns: preferences.pronouns }
      : { name: person?.name ?? null };
    const here = yield* hereFor(turn, member);
    const felt = yield* moodFor(turn, person?.id ?? null, who).pipe(
      Effect.provideService(AffectCause, yield* causeOf(turn)),
    );
    const board = [yield* boardFor(turn, member), yield* leadFor(turn, member)]
      .filter((l) => l !== "")
      .join(" ");
    // Once after a release, on his own turn: one new thing in her she may mention (TessayaSelf).
    const news =
      member === OWNER_MEMBER_ID && turn.sharedRoom !== true && turn.rehearsal !== true
        ? yield* newsOnce()
        : "";
    const since = sinceFor(
      turn,
      yield* Clock.currentTimeMillis,
      turn.timeZone ?? (yield* memory.meta("timeZone")) ?? undefined,
    );
    const key = conversationKey(turn);
    const pending = handedTo.get(key);
    const handed =
      pending !== undefined && pending.to === turn.persona && turn.rehearsal !== true
        ? handOffLine(pending.from)
        : "";
    if (handed !== "") handedTo.delete(key);
    return {
      // An instruction, not remembered data: the brain reads `notice` as hers to act on, the block as his data.
      notice: [
        repair === null ? "" : repairLine(repair, turn.text),
        inputLine(turn.input),
        waiting,
        voiceLine(turn.speaker),
      ]
        .filter((l) => l !== "")
        .join(" "),
      feeling: [felt.line, since, news].filter((l) => l !== "").join(" "),
      tone: felt.tone,
      block: [
        here,
        live,
        handed,
        board,
        standing.block,
        extra,
        nameOnceLine(turn.nameOnce),
        person?.line ?? "",
      ]
        .filter((b) => b !== "")
        .join("\n\n"),
      ids: sentence.ids,
      privateBlock: turn.sharedRoom === true ? "" : yield* privateFor(turn),
      conversation,
      ...(repair === null ? {} : { repair }),
      preferences,
      who: {
        member,
        name: preferences.name ?? (yield* memberName(member)) ?? person?.name ?? null,
        person: person?.id ?? null,
      },
      owner:
        member === OWNER_MEMBER_ID && turn.tainted !== true
          ? yield* ownerLineFor(turn.persona)
          : "",
    };
  });

  /**
   * The turn's "where you are" line: its vessel from the registry, and for a member (never a guest, never a shared
   * room) who was heard here lately. Only what this server holds in memory: no call that would slow the first word.
   */
  const hereFor = Effect.fn("TessayaTurn.hereFor")(function* (
    turn: TurnEnvelope,
    member: string | null,
  ) {
    const registry = yield* Effect.serviceOption(DeviceRegistry);
    const device = Option.isNone(registry)
      ? null
      : yield* registry.value.get(turn.vessel.id).pipe(Effect.orElseSucceed(() => null));
    const now = yield* Clock.currentTimeMillis;
    // every other body she is in right now, live from the Cast with who wears it, and who stands with her on this one
    const view = Option.isNone(cast)
      ? null
      : // a cast that can't say leaves her where-you-are without it, never the turn
        yield* cast.value.view.pipe(Effect.catchCause(() => Effect.succeed(null)));
    const nameOf = (id: string) => view?.personas.find((p) => p.id === id)?.name ?? id;
    const here = view?.bodies.find((b) => b.id === turn.vessel.id);
    const embody =
      view === null || turn.persona === undefined
        ? undefined
        : {
            also: view.bodies
              .filter((b) => b.id !== turn.vessel.id)
              .map((b): BodyNow => ({
                name: b.name,
                kind: b.kind,
                online: b.online,
                wearer: b.wearing === null ? null : nameOf(b.wearing),
                you: b.wearing === turn.persona,
                ...(b.shown === undefined ? {} : { shown: b.shown }),
                ...(b.screen === undefined ? {} : { screen: b.screen }),
              })),
            crew: (here?.on ?? []).filter((p) => p !== turn.persona).map(nameOf),
          };
    if (member === null || turn.sharedRoom === true)
      return hereLine(device, null, now, turn.plays, turn.volume, embody);
    const names: string[] = [];
    for (const p of (yield* presence.estimate()).members)
      if (p.confidence >= PRESENCE_BARS.around)
        names.push(p.guest ? GUEST_NAME : ((yield* memberName(p.member)) ?? p.member));
    return hereLine(device, names, now, turn.plays, turn.volume, embody);
  });

  /**
   * Her mood for the turn (CS6): the identified person's relationship over the general mood (a member, else a guest the
   * people graph knows by voice), read before their turn counts, so a return after hours is still in it; then the turn
   * is heard. Anyone else gets the general mood, no why. With others here (MA-021), the room's mood and how to be in a
   * group, and nothing private to the speaker: no why, no opinion, no shared story.
   */
  const moodFor = Effect.fn("TessayaTurn.moodFor")(function* (
    turn: TurnEnvelope,
    person: string | null,
    who: Who,
  ) {
    const mood = yield* Effect.serviceOption(TessayaMood);
    if (Option.isNone(mood) || turn.rehearsal === true) return { line: "", tone: null };
    const member = moodMember(turn) ?? (turn.addressed === false ? null : person);
    const zone = turn.timeZone ?? (yield* memory.meta("timeZone")) ?? undefined;
    const spoken = turn.vessel.kind === "device";
    const room = yield* roomOf(turn);
    const before = (yield* conversationOf(turn)).turns
      .slice(-4)
      .map((t) => `${t.role === "user" ? "them" : "her"}: ${t.content.slice(0, 150)}`)
      .join("\n");
    // The face a device shows at rest (R1Device.publishRestMood) can be another person's or persona's mood: whoever
    // asks about it hears it in general words, so she never disowns what is on her face.
    // Her face here a moment ago may have been for someone else (M-094): this speaker hears it wasn't about them.
    const face = Effect.fn("TessayaTurn.face")(function* (label: string, speaker: string | null) {
      const now = yield* Clock.currentTimeMillis;
      const aimed = (yield* mood.value.facesOn(turn.vessel.id)).find(
        (f) => f.faceFor !== "room" && f.faceFor !== "general" && now - f.at < FACE_FOR_MS,
      );
      if (
        aimed !== undefined &&
        aimed.faceFor !== speaker &&
        aimed.label !== "neutral" &&
        aimed.intensity >= 0.2
      )
        return faceForLine({
          label: aimed.label,
          name: aimed.private ? null : yield* memberName(aimed.faceFor),
          private: aimed.private,
        });
      if (!spoken) return "";
      const f = yield* mood.value.atDevice(turn.vessel.id, undefined, zone);
      return f.intensity >= 0.2 && f.label !== label ? faceLine(f) : "";
    });
    const understanding = yield* Effect.serviceOption(TessayaUnderstanding);
    const self = yield* understood({ about: "self", persona: turn.persona });
    if (member === null) {
      if (turn.addressed === false) return { line: "", tone: null };
      // Likely them (their voice carried over, not yet verified): only that they were around, as presence would say.
      // Nothing else is written under them below the bar: no bond, no return, no opinion (voice ID is the guard).
      const likely = turnIdentity(turn);
      if (likely.assurance === 1 && likely.member !== null && turn.sharedRoom !== true)
        yield* mood.value.note(turn.persona, { kind: "seen" }, likely.member);
      // A room's talk moves the general mood (its flow only: nobody's tone, opinion or story).
      if (turn.sharedRoom === true)
        yield* mood.value
          .hisWords(turn.persona, turn.text, null, { before })
          .pipe(Effect.forkDetach);
      const view =
        room.here.length > 1
          ? yield* mood.value.roomView(turn.persona, room.here, zone)
          : yield* mood.value.view(turn.persona, zone);
      return {
        line: [
          moodLine(privateOut(view), spoken),
          self,
          roomLine({ ...room, drawIn: view.leanings?.drawIn ?? 0.6 }),
          yield* face("", null),
        ]
          .filter((l) => l !== "")
          .join(" "),
        tone: toneFor(view.label, view.intensity),
      };
    }
    // How they sound moves her before this turn's line is read, so her answer already meets it.
    if (turn.emotion !== undefined)
      yield* mood.value.note(turn.persona, { kind: "his_voice", emotion: turn.emotion }, member);
    // Judged beside her reply, not before it: the cheap model's second would be their wait. Her face and next turn see it.
    // A turn that showed something new about them is evidence for her understanding of them (G4). A private moment's
    // words stay sealed: her one mood hears that he came (`heard`), never what was said.
    if (turn.private !== true)
      yield* mood.value
        .hisWords(turn.persona, turn.text, member, { voice: turn.emotion, before })
        .pipe(
          Effect.flatMap((news) =>
            news && Option.isSome(understanding)
              ? understanding.value.evidence(
                  { about: "person", id: member },
                  turn.text,
                  turnSource(turn),
                )
              : Effect.void,
          ),
          Effect.forkDetach,
        );
    const view = yield* mood.value.view(turn.persona, zone, member);
    const others = room.here.some((h) => h.key !== member);
    const line = moodLine(others ? privateOut(view) : view, spoken, who);
    yield* mood.value.heard(turn.persona, zone, member);
    // Her understanding of them is theirs alone: on their own turn, never with anyone else here.
    const theirs = others ? "" : yield* understood({ about: "person", id: member }, who.name);
    return {
      line: [
        line,
        theirs,
        self,
        others ? roomLine({ ...room, drawIn: view.leanings?.drawIn ?? 0.6 }) : "",
        yield* face(view.label, member),
      ]
        .filter((l) => l !== "")
        .join(" "),
      tone: toneFor(view.label, view.intensity),
    };
  });

  /** Her standing understanding of a person or of herself as the turn's line, "" when there is none. */
  const understood = Effect.fn("TessayaTurn.understood")(function* (
    subject: UnderstandingSubject,
    name?: string | null,
  ) {
    const understanding = yield* Effect.serviceOption(TessayaUnderstanding);
    const text = Option.isNone(understanding) ? null : yield* understanding.value.current(subject);
    return text === null ? "" : understandingLine(subject.about, text, name);
  });

  /** Who is at this turn's vessel (members and guests, by key), who of them has been quiet, and whether it is busy. */
  const roomOf = Effect.fn("TessayaTurn.roomOf")(function* (turn: TurnEnvelope) {
    const at = (yield* presence.estimate()).members.filter(
      (m) => m.nearest?.vessel === turn.vessel.id && m.nearest.confidence >= PRESENCE_BARS.around,
    );
    const names: string[] = [];
    const quiet: string[] = [];
    for (const m of at) {
      const name = m.guest ? GUEST_NAME : ((yield* memberName(m.member)) ?? GUEST_NAME);
      names.push(name);
      if (!m.evidence.some((e) => e.source === "voice" && e.minutesAgo < QUIET_MINUTES))
        quiet.push(name);
    }
    return {
      here: at.map((m) => ({ key: m.member, weight: m.nearest!.confidence })),
      names,
      quiet,
      busy: at.length >= 4 || (turn.sharedRoom === true && at.length >= 3),
    };
  });

  /** The presence board for this turn (CS2): her other live threads, filtered by who is asking. */
  /** The jobs this turn's persona leads, told only to the owner: his jobs are his. */
  const leadFor = Effect.fn("TessayaTurn.leadFor")(function* (
    turn: TurnEnvelope,
    member: string | null,
  ) {
    if (
      turn.persona === undefined ||
      member !== OWNER_MEMBER_ID ||
      turn.sharedRoom === true ||
      turnIdentity(turn).assurance < 2 ||
      Option.isNone(jobService) ||
      Option.isNone(workSessionService)
    )
      return "";
    const mine = (yield* jobService.value.allTerms()).filter((t) => t.lead === turn.persona);
    if (mine.length === 0) return "";
    const active = new Map(
      (yield* workSessionService.value
        .list({ includeArchived: false })
        .pipe(Effect.orElseSucceed(() => [])))
        .filter((s) => s.status === "active")
        .map((s) => [s.id as string, s.title]),
    );
    const { personas } = yield* personasList;
    return leadFitLine(
      mine.flatMap((t) => {
        const title = active.get(t.workSessionId);
        if (title === undefined) return [];
        const kept = (t.leadMoves ?? []).flatMap((m) =>
          m.declined === undefined
            ? []
            : [personas.find((p) => p.id === m.declined)?.name ?? m.declined],
        );
        return [{ title, kept: [...new Set(kept)] }];
      }),
    );
  });

  const boardFor = Effect.fn("TessayaTurn.boardFor")(function* (
    turn: TurnEnvelope,
    member: string | null,
  ) {
    const self = conversationKey(turn);
    const tier = turn.private === true ? "private" : "public";
    // A private moment shows only to her own self (D5), and never to a member or guest, not even as a count.
    const others = (yield* threads()).filter(
      (t) =>
        (t.conversation !== self || t.tier !== tier) &&
        (t.tier === "public" || t.persona === (turn.persona ?? null)),
    );
    const viewer =
      member === null || turn.sharedRoom === true
        ? "guest"
        : member === OWNER_MEMBER_ID && turnIdentity(turn).assurance >= 2
          ? "owner"
          : "member";
    // Anyone but the owner hears only how many: no names are read for them.
    if (others.length === 0 || viewer !== "owner")
      return boardLine(
        others
          .filter((t) => t.tier === "public")
          .map(() => ({ persona: "", person: "", where: "", minutesAgo: 0 })),
        viewer,
      );
    const { personas } = yield* personasList;
    const registry = yield* Effect.serviceOption(DeviceRegistry);
    const now = yield* Clock.currentTimeMillis;
    const rows = [];
    for (const t of others) {
      const device = Option.isNone(registry)
        ? null
        : yield* registry.value.get(t.vessel.id).pipe(Effect.orElseSucceed(() => null));
      rows.push({
        persona: personas.find((p) => p.id === t.persona)?.name ?? t.persona ?? "Tessaya",
        person:
          t.person === null
            ? "someone she doesn't know"
            : ((yield* memberName(t.person)) ?? t.person),
        where: device?.name ?? t.vessel.kind,
        minutesAgo: Math.floor((now - t.lastAt) / 60_000),
        about: t.gist,
        private: t.tier === "private",
        doing: t.doing != null && t.doing.until > now ? t.doing.what : null,
      });
    }
    return boardLine(rows, viewer);
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

  // The one presence store (B-043); a turn built alone (a test) keeps its own.
  const presence =
    Option.getOrUndefined(yield* Effect.serviceOption(TessayaPresence)) ?? (yield* makePresence);
  const vesselName = Effect.fn("TessayaTurn.vesselName")(function* (id: string) {
    const registry = yield* Effect.serviceOption(DeviceRegistry);
    const device = Option.isNone(registry)
      ? null
      : yield* registry.value.get(id).pipe(Effect.orElseSucceed(() => null));
    return device?.name ?? id;
  });
  /**
   * Who was just here: a voice verified on its own audio (A2) on a vessel, or a member's own signed-in device typing.
   * A guess (an unverified or carried-over voice), a guest, a replay or a turn not said to her proves nothing.
   */
  const notePresence = Effect.fn("TessayaTurn.notePresence")(function* (turn: TurnEnvelope) {
    if (turn.rehearsal === true || turn.addressed === false) return;
    const identity = turnIdentity(turn);
    if (identity.member === null || identity.assurance < 2) return;
    yield* presence.note({
      member: identity.member,
      // A verified voice, or a member's own signed-in device typing.
      source: turn.speaker === null || turn.speaker === undefined ? "typed" : "voice",
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
    // Their own devices: connected now, or when one last was.
    const estimate = yield* presence.estimate(
      [...devices.values()].map((d) => ({
        member: d.id,
        source: "device",
        vessel: null,
        at: d.connected > 0 ? now : now - d.minutesAgo * 60_000,
      })),
    );
    const out: Array<WhoIsHome> = [];
    for (const p of estimate.members) {
      const d = devices.get(p.member);
      const heard = p.evidence.find((e) => e.source === "voice" || e.source === "typed");
      const reasons: Array<string> = [];
      for (const e of p.evidence) {
        const reason = presenceReason(e, e.vessel === null ? null : yield* vesselName(e.vessel));
        reasons.push(p.guest ? reason.replace(/\byour\b/, "their") : reason);
      }
      out.push({
        member: p.member,
        guest: p.guest,
        name: p.guest
          ? GUEST_NAME
          : ((yield* preferencesOf(p.member)).name ??
            d?.name ??
            (yield* memberName(p.member)) ??
            p.member),
        heard:
          heard === undefined || heard.vessel === null
            ? null
            : {
                via: yield* vesselName(heard.vessel),
                vessel: heard.vessel,
                minutesAgo: heard.minutesAgo,
              },
        devices: d === undefined ? null : { connected: d.connected, minutesAgo: d.minutesAgo },
        likelyHome: p.confidence >= PRESENCE_BARS.around,
        confidence: Math.round(p.confidence * 100) / 100,
        nearest:
          p.nearest === null
            ? null
            : {
                vessel: p.nearest.vessel,
                name: yield* vesselName(p.nearest.vessel),
                confidence: Math.round(p.nearest.confidence * 100) / 100,
              },
        reasons,
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
      at: zoneMidnight(c.on, zone),
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
    if (turn.addressed !== false && turn.rehearsal !== true) {
      yield* addExchange(turn, done.reply);
      const gist = gistFor(turn);
      // Background like learning below: a spoken vessel forks `end`, so this never holds her voice.
      yield* Option.isNone(pools)
        ? gist
        : pools.value.run("learn", { vessel: turn.vessel.id, class: "background" }, gist);
    }
    const unsure = unsureOf(turn);
    if (notLearnable(turn) !== null && unsure === null) return null;
    // His own voice verified: what a voice near his said on this vessel lately is now his.
    if (unsure === null && turn.speaker != null && voiceAssurance(turn.speaker) === 2) {
      const now = yield* Clock.currentTimeMillis;
      yield* memory.resolveUnsure({
        person: OWNER_MEMBER_ID,
        how: "verified-turn",
        vessel: turn.vessel.id,
        since: DateTime.formatIso(DateTime.makeUnsafe(now - UNSURE_CONFIRM_MS)),
      });
    }
    const learn = learning.learn({
      ...(unsure === null ? {} : { unsure }),
      origin: "turn",
      said: turn.text,
      reply: done.reply,
      sourceRef: turnSource(turn),
      tainted: turn.tainted === true,
      project: turn.project ?? null,
      previous: done.previous ?? null,
      ...(turn.persona === undefined ? {} : { agent: turn.persona }),
      ...(turn.timeZone === undefined ? {} : { timeZone: turn.timeZone }),
    });
    // Learning is background work: one model call at a time across every vessel, behind any spoken turn.
    const learned = yield* Option.isNone(pools)
      ? learn
      : pools.value.run("learn", { vessel: turn.vessel.id, class: "background" }, learn);
    if (unsure !== null && learned.held > 0) yield* askWasItYou(unsure, turn.text);
    // A correction the learning loop kept is theirs, model-judged: it moves their relationship (CS6).
    const mood = yield* Effect.serviceOption(TessayaMood);
    if ((learned.corrections ?? 0) > 0 && Option.isSome(mood) && moodMember(turn) !== null)
      yield* mood.value
        .note(turn.persona, { kind: "correction" }, moodMember(turn))
        .pipe(Effect.provideService(AffectCause, yield* causeOf(turn)));
    // A correction of her is evidence for how she sees herself (G4).
    const understanding = yield* Effect.serviceOption(TessayaUnderstanding);
    if ((learned.corrections ?? 0) > 0 && Option.isSome(understanding))
      yield* understanding.value
        .evidence({ about: "self", persona: turn.persona }, turn.text, turnSource(turn))
        .pipe(Effect.forkDetach);
    return learned;
  });

  /**
   * A card on his own phone (it needs the phone's unlock, as an approval does): "Was this you?" with the words. His yes
   * there places what is held from that turn; no, someone else or no answer leaves it in "not sure who".
   */
  const askWasItYou = Effect.fn("TessayaTurn.askWasItYou")(function* (
    unsure: MemoryUnsure,
    words: string,
  ) {
    const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
    if (Option.isNone(inbox) || unsure.nearest === null) return;
    const phone = inbox.value;
    const id = `unsure-${yield* Clock.currentTimeMillis}-${yield* Random.nextIntBetween(0, 1e6)}`;
    yield* phone.mirror({
      id,
      title: "Was this you?",
      detail: `She heard, not sure it was you: "${words.trim().slice(0, 300)}"`,
      buttons: ["Yes, it was me", "No", "Someone else"],
      yes: 0,
      cancel: 1,
      needs: "cloud-approve",
    });
    const nearest = unsure.nearest;
    yield* phone.promptAnswer(id).pipe(
      Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (a) => a !== null }),
      Effect.timeoutOption(`${yield* phone.cardLife} millis`),
      Effect.flatMap((answer) =>
        Option.isSome(answer) && answer.value === 0
          ? memory.resolveUnsure({ person: nearest, how: "device", turn: unsure.turn })
          : Effect.void,
      ),
      Effect.ignore,
      Effect.forkDetach,
    );
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
    if (origin?.speaker != null && memberOfSpeaker(origin.speaker) === null)
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
    // A voice near his but not proven: held as "not sure who" until his voice or his phone confirms it, never refused.
    if (!his && origin?.speaker?.kind === "owner" && origin.speaker.voiceIdOff !== true) {
      const unsure: MemoryUnsure = {
        turn: `vessel:${origin.kind}:${origin.id}:remember-${yield* Clock.currentTimeMillis}`,
        conversation: "",
        vessel: origin.id,
        nearest: OWNER_MEMBER_ID,
        confidence: origin.speaker.confidence ?? null,
      };
      const held = yield* memory.add({
        kind: "note",
        text: text.trim(),
        source: "thread",
        sourceRef: unsure.turn,
        surface: origin.kind,
        persona: origin.persona ?? null,
        unsure,
      });
      yield* askWasItYou(unsure, text);
      return {
        kept: "held" as const,
        id: held.id,
        line: `Got it. I'll check it was you.${spelledBack}`,
      };
    }
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

  /** From Recently forgotten by its id or words: its words, or null. */
  const putBackMemory = (key: string, actor: TurnAction["actor"]) =>
    Effect.flatMap(memory.factBin, (bin) =>
      bin === null ? Effect.succeed(null) : bin.restore(key, actor),
    );
  const ownerVoice = (assurance: number): TurnAction["actor"] => ({
    kind: "owner",
    id: OWNER_MEMBER_ID,
    certainty: assurance >= 3 ? 1 : 0.8,
  });

  const reassign = Effect.fn("TessayaTurn.reassign")(function* (input: {
    readonly to?: string | undefined;
    readonly ref?: string | undefined;
    readonly vessel?: string | undefined;
    readonly minutes?: number | undefined;
  }) {
    const origin = yield* TurnOrigin;
    // Only they can say it wasn't them: their own verified voice, or their own device.
    if (origin === null || (origin.assurance ?? 0) < 2 || origin.member == null)
      return "Only the person it was put down to can say it wasn't them: their own voice or device.";
    if (origin.rehearsal === true) return "Moved.";
    const from = origin.member;
    const named = input.to?.trim() ?? "";
    const members =
      named === ""
        ? []
        : (((yield* askHousehold(
            { op: "list" },
            { member: from, assurance: 2, tainted: origin.tainted === true },
          ))?.members ?? []) as ReadonlyArray<{ readonly id: string; readonly name: string }>);
    const to =
      members.find((m) => m.id === named || m.name.toLowerCase() === named.toLowerCase())?.id ??
      null;
    const now = yield* Clock.currentTimeMillis;
    const since = now - Math.min(Math.max(input.minutes ?? 30, 1), 24 * 60) * 60_000;
    const which =
      input.ref !== undefined
        ? { ref: input.ref }
        : input.vessel !== undefined
          ? { vessel: input.vessel, since }
          : { since, assumedOnly: true };
    const mood = yield* Effect.serviceOption(TessayaMood);
    const moved = Option.isNone(mood)
      ? 0
      : yield* mood.value.reassign({ from, to, by: from, ...which });
    const learned =
      "assumedOnly" in which
        ? []
        : yield* memory.unassign({
            from,
            to,
            ...(input.ref === undefined ? {} : { ref: input.ref }),
            ...(input.vessel === undefined
              ? {}
              : { vessel: input.vessel, since: DateTime.formatIso(DateTime.makeUnsafe(since)) }),
          });
    if (moved === 0 && learned.length === 0)
      return "I found nothing of that put down to you to move.";
    const who = to === null ? (named === "" ? "someone else" : named) : named;
    return `Got it: that was ${who}, not you. I've taken it back from you${learned.length > 0 ? ", and what I learned from it waits as not sure who" : ""}.`;
  });

  const forget = Effect.fn("TessayaTurn.forget")(function* (id: string, restore = false) {
    const origin = yield* TurnOrigin;
    if (origin === null || origin.hisVoice !== true) return NOT_HIS_VOICE_TO_FORGET;
    if (origin.rehearsal === true) return restore ? "Put back." : "Forgotten.";
    const actor = ownerVoice(origin.assurance ?? 0);
    if (restore) {
      const back = yield* putBackMemory(id, actor);
      return back === null
        ? "That isn't among what I was asked to forget lately."
        : `Put back: ${back}.`;
    }
    if (!(yield* memory.forget(id, actor))) return "There is no memory by that id.";
    const days = yield* Effect.provideService(readBinDays, SqlClient.SqlClient, sql);
    return `Forgotten. It can be put back for ${days} days.`;
  });

  const understandingFact = Effect.fn("TessayaTurn.understandingFact")(function* (input: {
    readonly fact: string;
    readonly about?: "them" | "herself" | undefined;
    readonly confirmed?: boolean | undefined;
    readonly restore?: boolean | undefined;
  }) {
    const origin = yield* TurnOrigin;
    // "Put back" names a forgotten memory as often as a fact: his voice restores one by its words first.
    if (input.restore === true && origin?.hisVoice === true && origin.rehearsal !== true) {
      const back = yield* putBackMemory(input.fact, ownerVoice(origin.assurance ?? 0));
      if (back !== null) return `Put back: ${back}.`;
    }
    const understanding = yield* Effect.serviceOption(TessayaUnderstanding);
    const herself = input.about === "herself";
    // Their understanding is theirs to change, on their own voice or device; how she sees herself is his.
    const member = origin?.member ?? null;
    const assurance = origin?.assurance ?? 0;
    const allowed =
      origin !== null && (herself ? origin.hisVoice === true : member !== null && assurance >= 2);
    if (!allowed || Option.isNone(understanding))
      return "I can change that only when I know it's your voice.";
    if (origin.rehearsal === true)
      return input.restore === true
        ? "Put back."
        : input.confirmed === true
          ? "Forgotten."
          : "Forget that? Ask for a clear yes, then call again with confirmed.";
    const subject: UnderstandingSubject = herself
      ? { about: "self", persona: origin.persona ?? undefined }
      : { about: "person", id: member! };
    const actor = {
      kind: (member ?? OWNER_MEMBER_ID) === OWNER_MEMBER_ID ? "owner" : "member",
      id: member ?? OWNER_MEMBER_ID,
      certainty: assurance >= 3 ? 1 : 0.8,
    } as const;
    const answer =
      input.restore === true
        ? yield* understanding.value.restore(subject, input.fact, { actor })
        : yield* understanding.value.forget(subject, input.fact, {
            actor,
            confirmed: input.confirmed,
          });
    return answer.line;
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
    reassign,
    understandingFact,
    about,
    setPreference,
    whoIsHome,
    transcript,
    comingUp: comingUpNow,
    threads,
    setDoing,
    /** The brain's side of a worker's change to her one conversation list (BrainOp threads). */
    threadAct: Effect.fn("TessayaTurn.threadAct")(function* (act: ThreadAct) {
      switch (act.a) {
        case "keep":
          yield* keepThread(act.id, act.row as LiveThread);
          return null;
        case "drop":
          yield* dropThread(act.id);
          return null;
        case "doing":
          yield* setDoing(act.thread, act.doing);
          return null;
        case "list":
          return yield* threads(act.persona ?? undefined);
        case "said":
          yield* keepLines(act.lines);
          return null;
        case "transcript":
          return yield* transcriptHere(act.from, act.to);
      }
    }),
    handOff,
  });
});

export const layer = Layer.effect(TessayaTurn, make);
