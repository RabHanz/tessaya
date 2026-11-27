/**
 * Tessaya in a room: the R1's in-house voice loop (agro-aiot Docs/136's gateway, folded into Tessaya). It hears
 * `voice/up`, asks her server, speaks on `voice/down` and stops when he cuts in. I/O is passed in for tests.
 * @module baton-voice/room/roomVoice
 */
import { SAME_CONVERSATION_MS } from "@t3tools/tessaya-shared/agentPrompt";
import {
  eyeClipOf,
  farewellEvent,
  greetEvent,
  type LineEvent,
} from "@t3tools/tessaya-shared/expression";
import { effectFor, toneOf, VESSELS } from "@t3tools/tessaya-shared/expressionMap";
import { atSpeakerMark } from "@t3tools/tessaya-shared/groupTalk";
import { ownVoiceVerified } from "@t3tools/tessaya-shared/privateMemory";
import { speechPieces, type Nonverbal } from "@t3tools/tessaya-shared/interjections";
import { mostlyForeign } from "@t3tools/tessaya-shared/language";
import {
  fireAtMs,
  saidText,
  soundAnchors,
  type SentenceClock,
} from "@t3tools/tessaya-shared/speechEffects";
import { firstClause, isNarration, withoutSelfIntro } from "@t3tools/tessaya-shared/narration";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import { pronounce, pronounceFrom } from "@t3tools/tessaya-shared/pronounce";
import {
  classifyListen,
  listenPhrases,
  listenStep,
  listenWaitMs,
  type ListenOutput,
  type ListenState,
} from "@t3tools/tessaya-shared/listenMode";
import {
  LISTEN_MARK,
  PRIVATE_MARK,
  REST_MARK,
  stopIntent,
  stopMatch,
} from "@t3tools/tessaya-shared/stopPhrases";
import {
  repairBoundsFor,
  repairVerdict,
  type HeardWord,
} from "@t3tools/tessaya-shared/transcriptRepair";

import { createEchoGuard } from "../echoGuard.ts";
import { createTalkOver, createVoiceLevel, voiceCheckDue, type TalkOver } from "../talkOver.ts";
import { ackLines, pickAck, type Acknowledge } from "./acknowledge.ts";
import type { RoomLines } from "./lines.ts";
import {
  accumulate,
  answersStepUp,
  cueOf,
  stepUpFor,
  NOT_SURE_YET,
  stepUpLine,
  type RecognitionSession,
  type StepUp,
} from "../recognition.ts";
import { isFreshRequest } from "@t3tools/tessaya-shared/followUp";
import { addressedInRoom, beganOverHer, echoVerdict, type Playback } from "../turnRules.ts";
import {
  askedFor,
  answersHer,
  calledName,
  heldBack,
  isBackchannel,
  invitesReply,
  isDismissal,
  isOwnVoice,
  isUnfinished,
  looksComplete,
} from "./addressing.ts";
import { createEnrolGuide, enrolScript, type EnrolGuide } from "../enrolGuide.ts";
import {
  admits,
  CAMPLUS_POLICY,
  forWire,
  memberByVoice,
  teaches,
  withName,
  UNVERIFIED,
  CHANGED_VOICE,
  cosine,
  likelyHis,
  meanUnit,
  SAME_VOICE,
  HOLD_MS,
  holdVoice,
  NO_HOLD,
  speakerPath,
  TEST_MODE_MAX_MS,
  type SpeakerGate,
  type SpeakerIdentity,
  type VoiceHold,
  type VoiceInput,
} from "../speaker.ts";
import { DOWN_FRAME_BYTES, fromBytes, speechLevel, toBytes } from "./audio.ts";
import { PILL_SOUNDS, renderSound, soundMs, type PillSound } from "../cueSounds.ts";
import type { Affect } from "./senseVoice.ts";
import type { TurnCaptureMeta } from "./turnCapture.ts";
import type { KwsEvent, WakeRequest } from "./wakeStream.ts";
import { segmentsOf, type TurnVoices } from "./segments.ts";
import {
  createTurnTaking,
  ROOM_TURN,
  WINDOW,
  type TurnAction,
  type TurnConfig,
} from "./turnTaking.ts";
import { DEVICE } from "@t3tools/tessaya-shared/productNames";
import type { InputQuality } from "@t3tools/tessaya-contracts";
import {
  createInputBaselines,
  inputQualityOf,
  measureInput,
} from "@t3tools/tessaya-shared/inputQuality";

const RATE = 16_000;
/** Words over her this alike in loudness to her playing reply are her echo in his session too (turnRules' 0.6 tail bar). */
const ECHO_ALIKE = 0.6;
/** How long a turn in his session waits for its own Voice ID verdict before it starts on the session rule. */
const VERDICT_WAIT_MS = 1_200;
/** Her downlink kept for open talk-over: 8 s, far more than the R1 ever holds unplayed. */
const DOWN_RING = RATE * 8;
/** How long a line she left unanswered stays his to ask about. */
const UNHEARD_MS = 60_000;
/** A line she did not answer, as her brain reads it with his next turn: data, never an ask of his. */
export const unheardLine = (text: string) =>
  `(just before this, a line I did not answer, from a voice I could not place or not said to me; act on it only if he says it was his: "${text.slice(0, 300)}")`;
/** firmware 0.3.92 `cmd/voice/upformat {"v":1}`: each uplink frame leads with seq, rx, q (u32) and flags (u16), 16 bytes. */
/** A turn verified as his at this score anchors his session: continuity and the unsure-turn capture start only here. */
const ANCHOR_BAR = 0.5;
const UP_HEADER = 16;
/** smp 0.3.151: the frame's flags (u16 at 12) carry this bit when it came from the headset's mic. */
const UP_FLAG_HEADSET = 16;
/** The R1's own latency on its onboard speaker (firmware lane, 14 Nov): her sample under it is rx - q - this. */
const R1_LATENCY = 1972;

/** Talking over her counts once she has sounded this long: the device's echo cancelling settles in that time. */
const ONSET_GRACE_MS = 400;
/** How many times a persona look is sent before the loop logs it as failed. */
const EYE_PERSONA_TRIES = 3;
/** Until his own level is known, a voice over her must reach this (dBFS): he is near -41 at the R1, a TV far below. */
const TALK_MIN_DBFS = -55;

/**
 * Her listening and closing sounds on the R1 (firmware 3.31.1 dropped Beken's spoken "Uh huh" and "Bye bye"): the
 * desktop pill's own notes, louder because they leave a small speaker across a room rather than a laptop's.
 */
const CUE_GAIN = 5;
const cueSamples = (name: PillSound): Int16Array =>
  Int16Array.from(renderSound(PILL_SOUNDS[name], RATE), (v) =>
    Math.max(-32768, Math.min(32767, Math.round(v * CUE_GAIN * 32767))),
  );

const concatPcm = (a: Int16Array, b: Int16Array) => {
  const out = new Int16Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export interface RoomPersona {
  readonly id: string;
  /** What he calls it by. */
  readonly name: string;
  readonly voice: string;
  /** The look she gives when she first recognises him this session; "happy" when the persona has none. */
  readonly cueMood?: string;
  /** Its look on the R1's eyes (`cmd/eye/persona`); without one, the generic look. */
  readonly eyes?: string;
  /** Its saved clone on her server (a path); main.ts makes it the voice when this machine's Pocket can fetch it. */
  readonly cloneUrl?: string;
  /** That clone's recorded tones (VOXTA G1), each its own embedding (a path, then a URL as `cloneUrl` is). */
  readonly cloneTones?: Readonly<Record<string, string>>;
}

/** What a body needs of a persona record, from her server's roster or the default pack. */
export interface ServedPersona {
  readonly id: string;
  readonly name: string;
  readonly wake: string | null;
  readonly voice: string;
  readonly lead: boolean;
  readonly eyes?: string;
  /** Its saved clone's embedding on her server (a path), spoken when this loop's Pocket can fetch it. */
  readonly cloneUrl?: string;
  readonly cloneTones?: Readonly<Record<string, string>>;
}

/** The room's roster from her server's personas: the lead first, each called by its wake word or its name. */
export const roomPersonas = (personas: ReadonlyArray<ServedPersona>): RoomPersona[] =>
  [...personas]
    .sort((a, b) => Number(b.lead) - Number(a.lead))
    .map((p) => ({
      id: p.id,
      name: p.wake ?? p.name,
      voice: p.voice,
      ...(p.eyes === undefined ? {} : { eyes: p.eyes }),
      ...(p.cloneUrl === undefined ? {} : { cloneUrl: p.cloneUrl }),
      ...(p.cloneTones === undefined ? {} : { cloneTones: p.cloneTones }),
    }));

/** `GET .../personas` as her server answered it, each record checked; null when nothing usable came back. */
export const servedRoster = (body: unknown): RoomPersona[] | null => {
  const list = (body as { personas?: unknown } | null)?.personas;
  if (!Array.isArray(list)) return null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const ok = list.flatMap((p: Record<string, unknown>): ServedPersona[] => {
    const [id, name, voice] = [text(p?.["id"]), text(p?.["name"]), text(p?.["voice"])];
    if (id === undefined || name === undefined || voice === undefined) return [];
    const eyes = text(p["eyes"]);
    const cloneUrl = text(p["cloneUrl"]);
    const tones = p["cloneTones"];
    const cloneTones =
      cloneUrl !== undefined && typeof tones === "object" && tones !== null
        ? Object.fromEntries(
            Object.entries(tones).flatMap(([tone, url]) =>
              text(url) === undefined ? [] : [[tone, url as string]],
            ),
          )
        : undefined;
    return [
      {
        id,
        name,
        voice,
        wake: text(p["wake"]) ?? null,
        lead: p["lead"] === true,
        ...(eyes ? { eyes } : {}),
        ...(cloneUrl ? { cloneUrl } : {}),
        ...(cloneTones ? { cloneTones } : {}),
      },
    ];
  });
  return ok.length === 0 ? null : roomPersonas(ok);
};

/** The look a persona without its own shows on the R1. */
export const GENERIC_EYES = "generic";

export interface RecognisedBy {
  readonly host: string | null;
  readonly hedge?: "personal" | "general";
}

export interface RecogniserTurn {
  readonly feed: (pcm: Int16Array) => void;
  /** The final text once the audio has ended. */
  readonly finish: () => Promise<string>;
  /** After `finish`: each word with its confidence, and the model that heard it; null where it gave none. */
  readonly words?: () => {
    readonly words: ReadonlyArray<HeardWord>;
    readonly model: string;
  } | null;
  readonly cancel: () => void;
  /** After `finish`: the recogniser whose words were taken, and which model won a hedged turn; null when unknown. */
  readonly by?: () => RecognisedBy | null;
  /** Each partial the recogniser sends while it still works (its words so far); the room guesses ahead with them. */
  readonly onPartial?: (listener: (text: string) => void) => void;
}

/** Two transcripts that say the same words, whatever their case and punctuation. */
const sameWords = (a: string, b: string) => {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .trim()
      .split(/\s+/)
      .join(" ");
  return words(a) === words(b);
};

/** How many times one turn may start her brain on a guess before the final text: each costs a brain call. */
const MAX_GUESSES = 3;
/**
 * His personal model hears a turn only this loud or louder: below it, it wrote words where the general one heard none
 * (on 356 of his Tessel segments, 15 Nov, -28 dBFS kept every name it gained and invented none).
 */
const PERSONAL_FLOOR_DB = -28;

/** After she goes on over a voice that was not his, this long before another voice may pause her. */
const RESUME_QUIET_MS = 1_500;
/** His words must hold still this long at a pause before her brain starts early on them. */
const STABLE_MS = 300;

/** Reads `source` into a buffer at once and replays it, so a stream started early loses nothing while it waits. */
const buffered = <T>(source: AsyncIterable<T>): AsyncIterable<T> => {
  const items: T[] = [];
  let done = false;
  let failed: unknown = null;
  let wake: (() => void) | null = null;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  void (async () => {
    try {
      for await (const item of source) {
        items.push(item);
        nudge();
      }
    } catch (error) {
      failed = error;
    } finally {
      done = true;
      nudge();
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; ;) {
        if (i < items.length) yield items[i++]!;
        else if (done) {
          if (failed !== null) throw failed;
          return;
        } else await new Promise<void>((r) => (wake = r));
      }
    },
  };
};

/**
 * The turn's envelope for her server's one turn pipeline (`TessayaTurn`, MEMORY-V2-DESIGN §2.0), which every vessel
 * fills the same way; the R1 is one vessel of the one agent.
 */
export interface Tessaya {
  readonly vessel: { readonly kind: "device"; readonly id: string };
  /** A spoken turn, or a button's prompt already in words. */
  readonly origin: "voice" | "button";
  /** Who answers: the persona's pack id (the lead's too). */
  readonly persona: string;
  /** He named that persona on this turn (a switch), so only this turn may greet as it. */
  readonly switched?: true;
  /** Every turn sent is one the loop judged said to her; `via` is why (memory refuses what was not addressed). */
  readonly addressed: true;
  readonly via: "name" | "first" | "reply" | "window" | "button";
  /** It began while her own voice could still be heard in the room: some of it may be hers. */
  readonly tainted: boolean;
  /** The house's time zone (the voice host sits in it, beside the R1). */
  readonly tz: string;
  /** What he said, as answered (joined fragments included). */
  readonly words: string;
  /** What this body can do, from its own report (`state/caps`). */
  readonly capabilities: ReadonlyArray<string>;
  /** Recognised for the first time this session (the recognition cue): their name, said once. */
  readonly nameOnce?: string;
  /** The conversation the arbiter named for this R1's last win; absent, her server uses the default key. */
  readonly conversation?: string;
  readonly speaker: SpeakerIdentity;
  readonly emotion?: { readonly label: string; readonly events: ReadonlyArray<string> };
  /** A guess on his partial words: the server records and learns from it only once `played` says it was heard. */
  readonly speculative?: true;
  /** Each word with the recogniser's confidence (transcript repair, V-018), when it gave them for these words. */
  readonly heardWords?: ReadonlyArray<HeardWord>;
  /** The recogniser model that scored `heardWords`, whose calibrated bounds judge them. */
  readonly recogniser?: string;
  readonly callId?: string;
  /** Several people this turn, in speaking order: each one's words with their own voice (absent for one voice). */
  readonly segments?: ReadonlyArray<{ readonly speaker: SpeakerIdentity; readonly words: string }>;
  /** The test run playing into the room (playbackWindow.ts): she answers, and her server learns nothing from it. */
  readonly playback?: string;
  /** How his sound came in (inputQuality.ts): she mentions it when it was not good. */
  readonly input?: InputQuality;
  /** Where her voice plays now, as the device last told this loop: live, where the server's record may be old. */
  readonly plays?: "bt" | "onboard";
  /** Her volume now (0-100), as the device last told this loop: the brain's record of it may be another hub's. */
  readonly volume?: number;
}

export interface RoomDeps {
  readonly publish: (topic: string, payload: Uint8Array | string) => void;
  /** A fresh Silero scorer per session (it is recurrent). */
  readonly vad: () => { readonly score: (window: Int16Array) => Promise<number> };
  readonly smartTurn: (pcm: Int16Array) => Promise<number>;
  /** A turn's recogniser; `owner` when it is his held voice and loud enough for his personal model. */
  readonly recognise: (who?: { readonly owner: boolean }) => RecogniserTurn;
  /** A member's data was destroyed: his voice profile on this host goes too. */
  readonly forget?: (personId: string) => void;
  /** The words in a stretch of his audio on their own (a second, short recognition): for an early start at a pause. */
  readonly preview?: (pcm: Int16Array) => Promise<string>;
  /** A throwaway decode as a session opens: the first clip after a quiet spell is otherwise about 1.5 s slower. */
  readonly warm?: () => void;
  /** Opens her server's connection ahead of a turn, as a session opens and as he starts to speak. */
  readonly link?: () => void;
  readonly speaker?: (pcm: Int16Array, input?: VoiceInput) => Promise<SpeakerIdentity>;
  /** A turn on another input in a session his voice was verified in on her mic: that input's profile learns from it. */
  readonly learnInput?: (input: VoiceInput, personId: string, pcm: Int16Array) => void;
  /** A mic turn sure to be this person's (`teaches`): this R1's room profile for them learns from its embedding. */
  readonly learnRoom?: (
    personId: string,
    vector: Float32Array,
    sample: {
      readonly at: number;
      readonly how: string;
      readonly score: number;
      readonly ms: number;
    },
  ) => void;
  /** Who spoke when in the turn (`segments.ts`); "one" at once when fewer than two voices are enrolled. */
  readonly voices?: (pcm: Int16Array) => Promise<TurnVoices>;
  readonly affect?: (pcm: Int16Array) => Promise<Affect>;
  /** Tessaya's turn on her server: the reply as text deltas. */
  readonly brain: (
    input: {
      readonly deviceId: string;
      readonly messages: ReadonlyArray<{
        readonly role: "user" | "assistant";
        readonly content: string;
      }>;
      readonly tessaya: Tessaya;
    },
    signal: AbortSignal,
  ) => AsyncIterable<string>;
  /** Her voice: 16 kHz PCM for one sentence, streamed. */
  /**
   * `continuing`: a later sentence of the same reply (a short pause first, as on the desktop); `breath`: a breath
   * instead before a long one, only when his setting turns it on (`voice/breath`).
   */
  readonly speak: (
    text: string,
    signal: AbortSignal,
    voice?: string,
    continuing?: boolean,
    breath?: boolean,
  ) => AsyncIterable<Int16Array>;
  /**
   * Test mode exists on this host (an internal one with `R1_TEST_MODE=1`); `ready` says the test clone is enrolled.
   * Absent everywhere else, so no public build can turn it on.
   */
  readonly testMode?: { readonly ready: () => boolean };
  /** The test run playing into the room now, or null when what she hears is live. */
  readonly playback?: () => string | null;
  /** Optional enrolment: the owner profile from these 4 s windows of his speech, and what she says about it. */
  readonly enrolOwner?: (
    windows: ReadonlyArray<Int16Array>,
  ) => Promise<{ readonly saved: boolean; readonly said: string }>;
  /** His voice as a vector, so the enrolment card can tell another voice from his; without it that check is skipped. */
  readonly embed?: (pcm: Int16Array) => Promise<Float32Array | null>;
  /** How like the household's enrolled voices this is (best cosine over every profile); open talk-over needs it. */
  readonly member?: (pcm: Int16Array) => Promise<number>;
  /** Keeps his own turn's audio for his voice models (turnCapture.ts); only his, never another voice's. */
  readonly keepTurn?: (id: string, pcm: Int16Array, meta: TurnCaptureMeta) => void;
  /** Someone in the household has a voice profile here: without one, talking over her stays keyword. */
  readonly members?: () => boolean;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** His final words matched a guess that is now answered: the house changes it held may now be made. */
  readonly confirmed?: (callId: string) => void;
  /** Her own words for the loop's moments, from the server's brain (room/lines.ts); none: the plain lines. */
  readonly lines?: RoomLines;
  /** A guess's reply was played to him in full: the server may now record it and learn from it. */
  readonly played?: (callId: string) => void;
  /** Her voice reached a stage direction's word: the server buzzes it at his haptic settings and logs what showed. */
  readonly effect?: (deviceId: string, nonverbal: Nonverbal, face: string | null) => void;
  readonly log: (line: string) => void;
  /** 0 to 1, for her varied lines (Math.random when absent). */
  readonly random?: () => number;
  /**
   * Her server's voice arbiter (one responder per utterance across his devices): a claim before she answers a wake or
   * her name, and where her reply stands. Null from `claim` when the arbiter cannot be asked: this R1 answers.
   */
  readonly arbiter?: {
    readonly claim: (claim: {
      readonly deviceId: string;
      readonly wakeScore: number;
      readonly loudnessDb: number | null;
      /** Who Voice ID heard: a verified member continues his own conversation, the rest the household's. */
      readonly speaker?: { readonly personId: string | null; readonly verified: boolean } | null;
      readonly answerHere?: boolean;
    }) => Promise<{
      readonly answer: boolean;
      readonly winner?: string;
      readonly until?: number;
      /** The conversation the winner continues (one per person, or the household's). */
      readonly conversation?: string;
    } | null>;
    readonly report: (op: "speaking" | "ended", deviceId: string, untilMs?: number) => void;
  };
  /** Raw aligned uplink frames and her downlink, for replaying the echo path offline (`R1_SESSION_TAP_DIR`). */
  readonly tap?: {
    readonly up: (deviceId: string, frame: Uint8Array, atMs: number) => void;
    readonly down: (deviceId: string, frame: Uint8Array, sample: number, atMs: number) => void;
  };
  /** A bench turn kept for a regression case (`cmd/voice/no-reply` with `keep`): never his, only while the bench asks. */
  readonly keep?: (turn: BenchTurn) => void;
  /** Her name with no session open (`voice/wake`): voiced segments only, never recognised beyond the wake check. */
  readonly wake?: {
    readonly frame: (deviceId: string, pcm: Uint8Array) => void;
    readonly end: (deviceId: string, seg?: number, sent?: number) => void;
    readonly kws?: (deviceId: string, event: KwsEvent) => void;
  };
}

export interface RoomConfig {
  readonly turn: TurnConfig;
  /** How far ahead of the R1's playback the downlink may run (its ring holds 1 s). */
  readonly leadMs: number;
  /** Audio held before a reply's first frame, so a slow first chunk from the voice cannot starve the R1's buffer. */
  readonly prerollMs: number;
  /** Downlink plus the R1's 150 ms prime: when a published frame is heard. */
  readonly downDelayMs: number;
  /** When a mic frame we receive was spoken. */
  readonly upDelayMs: number;
  /** After her reply (or S2), he may go on without her name for this long; after that only her name wakes her. */
  readonly followMs: number;
  /** The window after a reply that asks him something or tells him what to do next: his answer takes longer. */
  readonly replyHoldMs: number;
  /** After S2, a wake or her name, his first turn is hers if he starts within this, however slow he is to begin. */
  readonly firstTurnMs: number;
  /** A turn begun this soon after the window closed gets a glance, so a dropped turn is never met with nothing. */
  readonly lateCueMs: number;
  /** How long after her last frame her voice can still come back through the R1's mic (its 1 s ring, then the room). */
  readonly echoTailMs: number;
  /** A line he left unfinished ("Is it possible to") waits this long for the rest before it is answered alone. */
  readonly joinMs: number;
  /** His own stop phrases (voice settings), beside the shared ones; over her voice only these and her name count. */
  readonly stopPhrases: ReadonlyArray<string>;
  /** Her name alone and then nothing: a short spoken "I'm here" (voice), a sound (tone), or only her look (off). */
  readonly acknowledge: Acknowledge;
  /** After this long with nothing said to her, the session ends (the R1 plays its exit chime); S2 starts it again. */
  readonly idleStopMs: number;
  /** The same for a session only its audio opened (no S2, name or start seen here): the R1 is in one nobody here asked for. */
  readonly strayStopMs: number;
  /** Who answers by name, the lead first; each speaks in its own voice. */
  readonly personas: ReadonlyArray<RoomPersona>;
  /** The speaker and mood readers may hold the reply this long at most. */
  readonly sideMs: number;
  readonly gate: SpeakerGate;
  readonly historyTurns: number;
  /**
   * The R1s switched to this loop (the per-device `voice_transport`). Their firmware forgets the choice on every reboot
   * (it starts on the Agora path, which crashes on BT-free builds), so each reconnect is re-armed, three times across
   * the window in which the R1 is still subscribing (as Freya's proxy did, Tier-3.29.4).
   */
  readonly inhouse: ReadonlySet<string>;
  /** The house's time zone, sent with every turn. */
  readonly tz: string;
  /** The machine this loop runs on, in every turn's metrics: whichever host served a conversation is findable. */
  readonly host: string;
  /**
   * The languages the household speaks to her (BCP 47, "en", "ur"): until a speaker can be told apart, a line in
   * another language is the room only when this is English alone. Changed per R1 by `voice/languages` (retained).
   */
  readonly languages: ReadonlyArray<string>;
  /**
   * Over her voice: only a stop, a dismissal or her name (keyword), or anything he says (open: his voice heard over her
   * playback, from firmware 0.3.92's aligned uplink). Changed per R1 by `cmd/voice/talkover` (retained).
   */
  readonly talkOver: "keyword" | "open";
  /**
   * A recognised member's session opens on the persona they last talked to on any vessel (her server's
   * `voice/current/<member>`, within 10 minutes), before their own default. Off until the manager's yes (P5).
   */
  readonly personaFollows: boolean;
}

export const ROOM_CONFIG: RoomConfig = {
  turn: ROOM_TURN,
  leadMs: 700,
  prerollMs: 240,
  downDelayMs: 300,
  upDelayMs: 150,
  // Long enough for him to think or walk to the fan mid-conversation (13 Nov: lines lost after 8-15 s); "dismissed" ends it.
  followMs: 45_000,
  replyHoldMs: 60_000,
  firstTurnMs: 30_000,
  lateCueMs: 4_000,
  echoTailMs: 1_500,
  joinMs: 2_000,
  stopPhrases: [],
  acknowledge: "voice",
  // shortcut: her name only wakes her while the R1 streams; with the firmware's own wake word off, S2 after this.
  idleStopMs: 15 * 60_000,
  // 27 Nov 11:55: a stray session held her mic open and her name unheard for 12 min (its own idle end needs 120 s of no sound).
  strayStopMs: 90_000,
  // Until her server's roster arrives (main.ts reads it, and `personas` swaps it in for the next session).
  personas: roomPersonas(DEFAULT_OS_PACK.personas),
  sideMs: 250,
  // His room: guests are heard only when he lets them; until he enrols through the R1 every voice is unverified.
  gate: {
    respondToOthers: false,
    offSilencesSaved: false,
    savedBarge: false,
    strictWhenUnavailable: false,
  },
  historyTurns: 8,
  inhouse: new Set(),
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  host: "",
  languages: ["en"],
  talkOver: "open",
  personaFollows: false,
};

const REARM_AT_MS = [2_000, 8_000, 18_000];

/** `voice/gate`'s four switches, or null for anything else (the loop's own gate then holds). */
export const gateFrom = (payload: Uint8Array | string): SpeakerGate | null => {
  try {
    const v = JSON.parse(
      typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"),
    ) as Record<string, unknown>;
    const keys = [
      "respondToOthers",
      "offSilencesSaved",
      "savedBarge",
      "strictWhenUnavailable",
    ] as const;
    if (typeof v !== "object" || v === null || !keys.every((k) => typeof v[k] === "boolean"))
      return null;
    return {
      respondToOthers: v["respondToOthers"] as boolean,
      offSilencesSaved: v["offSilencesSaved"] as boolean,
      savedBarge: v["savedBarge"] as boolean,
      strictWhenUnavailable: v["strictWhenUnavailable"] as boolean,
    };
  } catch {
    return null;
  }
};
/** As long as her server holds a conversation (TessayaTurn's idle boundary). */
const CURRENT_HELD_MS = 10 * 60_000;
/** How long after her stop the R1's mic tail is dropped unless a new session starts (it ran 6 s on 20 Nov). */
const STOP_TAIL_MS = 10_000;
const onlyEnglish = (languages: ReadonlyArray<string>) =>
  languages.length > 0 && languages.every((l) => l.toLowerCase().split("-")[0] === "en");
/** A voice this much quieter than his name reached the R1 is the room, not him. */
const FAR_DB = 18;
/** A session that has had no mic audio for this long while wake audio arrives is one the R1 has already left. */
const STALE_SESSION_MS = 3_000;
/** A session asked for here with no mic audio yet is the R1 still starting it (27 Nov: 11 s), not one it has left. */
const START_GRACE_MS = 15_000;
/** Her server's acts for a Tessel that open a session or move the eyes: only the loop on the Tessel's hub may run them. */
const DEVICE_ACTS = /^(voice\/(intent\/eye|stepup|say|ask|persona|enrol)|cmd\/voice\/start)$/;

/**
 * One loop drives a Tessel (18 Nov: a standby loop ran her eye moods and a step-up while she was on another hub).
 * `tail` is the topic after `freya/r1/<id>/`; `here` is whether the Tessel is online on this loop's bus.
 */
export const routeForDevice = (tail: string, here: boolean): "room" | "drop" =>
  !here && DEVICE_ACTS.test(tail) ? "drop" : "room";

/**
 * The loop's one bus: the hub of the server whose brain it calls, so its acts and the device's events meet on one bus
 * with one loop election (18 Nov: a loop on one server's hub called another's brain, whose acts went to its own hub).
 */
export const busOfBrain = (brainUrl: string): string => {
  const url = new URL("/api/tessel/mqtt", brainUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};
/**
 * `R1_HUB_URL` unset: one bus, the brain's hub (slice 1). Set: her own hub, and the brain's hub as well (`brain`), so turns run
 * on the brain while room audio stays on her LAN (18 Nov: first word 1.3 s on the brain host, 3.0 s on a busy hub host).
 */
export const loopBuses = (brainUrl: string, hubUrl: string | undefined) => {
  const brain = busOfBrain(brainUrl);
  const hub = hubUrl?.trim() || brain;
  return { hub, brain: hub === brain ? null : brain };
};

/** A brain's turn acts for a Tessel, which it publishes on its own hub; device commands go by the peer route (HomeDevices). */
const BRAIN_ACTS = /^voice\/(intent\/(eye|rest)|stepup|say|ask|persona)$/;
/** From the brain's hub: what the loop on her hub takes, only for a Tessel online here (one loop drives her). */
export const fromBrainHub = (tail: string, here: boolean) => here && BRAIN_ACTS.test(tail);
/**
 * What a Tessel reports on her hub that the brain's own records read (online, readings, the loop's turn metrics): copied
 * to the brain's hub, states retained as she retains them. Without it the brain thought her offline and her readings old.
 */
export const relayToBrain = (tail: string): "retain" | "once" | null =>
  tail.startsWith("state/") ? "retain" : tail.startsWith("event/") ? "once" : null;
/** The loop's answers the brain waits on: a step-up's ack (StepUps settles on it). */
export const toBrainHub = (tail: string) => tail === "voice/stepup/done";

/**
 * The turn on the brain, or on her own hub's server when the brain cannot be reached or refuses, so she never goes
 * silent. Never because it is slow or its stream broke: it may already be acting, and a second turn would act twice
 * (lights, messages).
 */
/** The brain never took the turn (refused the connection or answered an error status), so nothing of it can be running. */
export const brainNotReached = (why: string) => Object.assign(new Error(why), { notReached: true });

export const brainOrLocal = (
  brain: RoomDeps["brain"],
  local: RoomDeps["brain"],
  log: (line: string) => void,
): RoomDeps["brain"] =>
  async function* (input, signal) {
    let said = false;
    try {
      for await (const words of brain(input, signal)) {
        said = true;
        yield words;
      }
      return;
    } catch (e) {
      if (said || signal.aborted || (e as { notReached?: unknown }).notReached !== true) throw e;
      log(
        `[${input.deviceId}] brain unreachable (${String(e).slice(0, 120)}); this hub's server answers`,
      );
    }
    yield* local(input, signal);
  };

/** His headset's mic sent nothing this long while she was quiet: the radio is starved, so her own mic hears him. */
const HEADSET_STARVED_MS = 2_000;
/** Or it sent only near-silence this quiet (no real room is) this long: the SCO link carries no audio. */
const HEADSET_DEAD_PEAK = 8;
const HEADSET_DEAD_MS = 3_000;
/** After a flush the firmware drops a reply's frames until none has come for 400 ms: a sentence sent again waits this. */
const REFLUSH_GAP_MS = 600;
/** How long his pieces are joined while he keeps talking: his pauses mid-sentence run 0.4-0.9 s (18 Nov). */
const GONE_ON_MS = 12_000;
/** The same face is sent again only after this long: a lost command on his weak Wi-Fi heals without a burst. */
const EYE_RESEND_MS = 10_000;
/** One of each gesture in this long: his pauses ended a piece of his sentence four times in 9 s (18 Nov, 00:15:55). */
const GESTURE_GAP_MS = 2_000;
/** The mood in an eye payload this loop wrote itself (always JSON). */
const eyeMood = (payload: string | undefined) =>
  payload === undefined ? undefined : (JSON.parse(payload) as { mood?: unknown }).mood;

/** What a bench turn heard and what she was playing around it, to replay the echo guard's decision in a test. */
export interface BenchTurn {
  readonly device: string;
  readonly turn: number;
  readonly startedAt: number;
  readonly lastVoice: number;
  readonly text: string;
  readonly herLines: ReadonlyArray<string>;
  readonly echoed: boolean;
  readonly likeness: number;
  readonly mic: Int16Array;
  /** Her downlink frames with the time each was sent (it sounds `downDelayMs` later). */
  readonly played: ReadonlyArray<{ readonly at: number; readonly pcm: Int16Array }>;
}

export interface TurnMetrics {
  /** When the turn ended, ISO UTC: an old line is never read as a new turn. */
  readonly at: string;
  readonly device: string;
  readonly turn: number;
  readonly reason: string;
  /** From his last voiced window to the decision that he had finished. */
  readonly endpointMs: number;
  /** From that decision to the recogniser's final text. */
  readonly asrMs: number;
  /** From the text to the server's first words. */
  readonly brainFirstMs: number | null;
  /** From the first sentence to its first audio. */
  readonly ttsFirstMs: number | null;
  /** From his last voiced window to the first frame sent to the R1. */
  readonly firstSoundMs: number | null;
  readonly text: string;
  readonly speaker: string;
  /** The verdict her brain acted on: verified as him on this turn (own clips or his held session), or not. */
  readonly verified: boolean;
  /** The machine whose loop served the turn (absent when unknown). */
  readonly host?: string;
  /** Cosine to his profile (null with no profile): how Voice ID is measured on his real room turns. */
  readonly speakerScore: number | null;
  readonly emotion: string;
  readonly bargedIn: boolean;
  /** Her brain started on the recogniser's partial words, and the final text matched them. */
  readonly speculative?: boolean;
  /** From his last voiced window to Voice ID's verdict (negative: ready before he finished); null before metrics. */
  readonly voiceIdMs?: number | null;
  /** Her brain started before the verdict, closed to his path. */
  readonly voiceIdLate?: boolean;
  /** His verdict came before her first words, so her brain was asked again as his. */
  readonly reasked?: boolean;
  /** Answered as him because test mode trusted the test clone. */
  readonly test?: boolean;
  /** His by his session's evidence, not this turn's own score. */
  readonly lifted?: boolean;
  /** Voice ID's last verdict when it differs from the `speaker` the turn was answered as (it came late). */
  readonly verdict?: string;
  /** Cosine to his own earlier pieces in his verified session (continuity), when he has one. */
  readonly same?: number;
  /** The replay check on the room mic: its verdict and logit (null when it could not run). */
  readonly replay?: {
    readonly verdict: "pass" | "heard" | "unchecked";
    readonly score: number | null;
  };
  /** The recogniser whose words were taken, and which model a hedged turn took. */
  readonly recogniser?: RecognisedBy;
  /** How his sound came in on this turn, for her health model. */
  readonly input?: InputQuality;
}

/** "Test mode on", "turn off test mode", "Tessaya, test mode off": which, or null. */
export const testModeAsked = (text: string): "on" | "off" | null => {
  const m =
    /\btest mode\s+(on|off)\b/i.exec(text) ??
    /\bturn\s+(on|off)\s+(?:the\s+)?test mode\b/i.exec(text);
  return m === null ? null : (m[1]!.toLowerCase() as "on" | "off");
};

/** The silence put between a held sentence's pieces when they are recognised again as one. */
const PIECE_GAP = new Int16Array(RATE / 5);

/**
 * A sentence he paused in, recognised again from all its pieces' audio: each piece alone loses the words cut at a pause
 * ("about how I speak" came out "about" + "Or" + "Speak.", 15 Nov 09:10). The joined pieces' words stand when the second
 * pass fails or hears clearly fewer words, so nothing he said is dropped.
 */
const joinedAudio = (pieces: ReadonlyArray<Int16Array>) => {
  const all = new Int16Array(pieces.reduce((n, p) => n + p.length + PIECE_GAP.length, 0));
  let at = 0;
  for (const p of pieces) {
    all.set(p, at);
    at += p.length + PIECE_GAP.length;
  }
  return all;
};

export const wholeSentence = async (
  joined: string,
  pieces: ReadonlyArray<Int16Array>,
  recognise: ((pcm: Int16Array) => Promise<string>) | undefined,
): Promise<string> => {
  if (recognise === undefined || pieces.length < 2) return joined;
  const again = (await recognise(joinedAudio(pieces)).catch(() => "")).trim();
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  return again !== "" && words(again) >= 0.8 * words(joined) ? again : joined;
};

/** Whole sentences out of a growing reply, keeping the unfinished tail. */
export const splitSentences = (
  text: string,
): { readonly done: string[]; readonly rest: string } => {
  const done: string[] = [];
  let rest = text;
  for (;;) {
    const m = /^(.+?[.!?…])(\s+|$)(?=\S|$)/s.exec(rest);
    // A full stop at the very end may be a decimal or an abbreviation still being written; wait for what follows.
    if (m === null || (m[2] === "" && m.index + m[0].length === rest.length)) break;
    done.push(m[1]!.trim());
    rest = rest.slice(m[0].length);
  }
  return { done, rest };
};

const SPEECH_RMS = 330;
const speechWindows = (pcm: Int16Array, n = 4 * RATE): Int16Array[] => {
  const out: Int16Array[] = [];
  for (let s = 0; s + n <= pcm.length; s += n) {
    const w = pcm.subarray(s, s + n);
    let sum = 0;
    for (const v of w) sum += v * v;
    if (Math.sqrt(sum / n) >= SPEECH_RMS) out.push(w);
  }
  return out;
};

const ENROL_INTRO = "Let's learn your voice. Read the sentences on your screen, one at a time.";
/** The card's level meter is sent this often at most; a change in the words goes at once. */
const CARD_MS = 250;

export const createRoomVoice = (deps: RoomDeps, config: RoomConfig = ROOM_CONFIG) => {
  /** Her server's roster; a session keeps the one it opened with. */
  let roster = config.personas;
  const topic = (id: string, tail: string) => `freya/r1/${id}/${tail}`;

  /** Test mode: until when the test clone is trusted as him (0: off). In memory only, so a restart ends it. */
  let testUntil = 0;
  /** The Tessels showing it: amber light, and the app's `voice.test_mode` item. */
  const testShown = new Set<string>();
  const clockOf = (at: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: config.tz,
      hour: "2-digit",
      minute: "2-digit",
    }).format(at);
  const showTest = (id: string) => {
    const on = deps.now() < testUntil;
    deps.publish(
      topic(id, "cmd/led/set"),
      JSON.stringify(
        on ? { r: 255, g: 110, b: 0, mode: "solid" } : { r: 0, g: 0, b: 0, mode: "solid" },
      ),
    );
    deps.publish(
      topic(id, "state/item/voice.test_mode"),
      JSON.stringify({ value: on ? `on until ${clockOf(testUntil)}` : "off" }),
    );
  };
  /** On for `minutes` (at most 2 h) or off (null); what she says about it. */
  const setTestMode = (id: string, minutes: number | null, why: string): string => {
    if (deps.testMode === undefined) return "There's no test mode here.";
    if (minutes === null || !(minutes > 0)) {
      const was = deps.now() < testUntil;
      testUntil = 0;
      for (const d of testShown) showTest(d);
      testShown.clear();
      deps.log(`[${id}] TEST MODE OFF (${why})${was ? "" : ", it was not on"}`);
      return "Test mode is off.";
    }
    if (!deps.testMode.ready()) {
      deps.log(`[${id}] TEST MODE refused: no test speaker enrolled`);
      return "There's no test voice enrolled, so test mode stays off.";
    }
    const ms = Math.min(minutes * 60_000, TEST_MODE_MAX_MS);
    const until = deps.now() + ms;
    testUntil = until;
    testShown.add(id);
    for (const d of testShown) showTest(d);
    deps.log(
      `[${id}] TEST MODE ON until ${clockOf(until)} (${why}): the test speaker is trusted as him`,
    );
    // A real timer: the light and the item go off with no turn to notice; the verdict itself reads the clock.
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(() => {
      if (testUntil !== until) return;
      deps.log(`[${id}] TEST MODE OFF (expired)`);
      for (const d of testShown) showTest(d);
      testShown.clear();
      testUntil = 0;
    }, ms + 1_000);
    (timer as { unref?: () => void }).unref?.();
    return `Test mode is on until ${clockOf(until)}.`;
  };

  /** Each speaker's usual sound, across sessions and Tessels: a muffled turn is judged against his own voice. */
  const baselines = createInputBaselines();
  const openSession = (id: string, stray: boolean) => {
    const vad = deps.vad();
    const turns = createTurnTaking(config.turn);
    const echo = createEchoGuard();
    /** Open talk-over: her downlink as the R1 received it, by sample, to line up with each mic frame's header. */
    // One per R1: the room it learned from her last replies holds for the next session.
    const talk = talkOf(id);
    const down = new Int16Array(DOWN_RING);
    let downSamples = 0;
    /** The R1's downlink count minus ours, read off the first aligned frame (its session may have begun before ours). */
    let downBase: number | null = null;
    let lastDownAt = Number.NEGATIVE_INFINITY;
    /** When her voice began after silence: the R1's echo cancelling lets a burst through as it starts (14 Nov captures). */
    let soundingFrom = Number.NEGATIVE_INFINITY;
    const voiceLevel = createVoiceLevel();
    /** He was heard over her and she stopped for it: his turn begun then is answered, not held to a stop phrase. */
    let cutByVoiceAt = Number.NEGATIVE_INFINITY;
    let lastProb = 0;
    if (open(id)) deps.publish(topic(id, "cmd/voice/upformat"), JSON.stringify({ v: 1 }));
    let pending = new Int16Array(0);
    let chain: Promise<void> = Promise.resolve();
    /** The turn being answered now, so a push-to-talk release can wait for its reply before ending the session. */
    let answering: Promise<void> = Promise.resolve();
    let rec: RecogniserTurn | null = null;
    let reply: AbortController | null = null;
    let playUntil = Number.NEGATIVE_INFINITY;
    /** When the arbiter was last told where her reply stands. */
    let spokeAt = Number.NEGATIVE_INFINITY;
    /** Where her speech (not a listening sound) ends on the R1's timeline. */
    let speechUntil = Number.NEGATIVE_INFINITY;
    let lastVoiceAt = deps.now();
    let lastActivity = deps.now();
    let turnNo = 0;
    /** Mic turns begun so far: words that arrive after a newer turn of his began are not answered on their own. */
    let starts = 0;
    /** His words held for his next turn: a sentence he paused in, or one his next turn overtook (13 Nov, 07:39). */
    let carry: {
      readonly text: string;
      readonly at: number;
      readonly since: number;
      /** Each piece's audio, in order: the joined sentence is recognised again as one. */
      readonly pieces: ReadonlyArray<Int16Array>;
    } | null = null;
    /** The turn being answered; a fragment of his that starts before she is heard is joined to it, not answered apart. */
    let current_: {
      readonly text: string;
      readonly endedAt: number;
      firstAt: number | null;
      readonly entry: { role: "user"; content: string };
      merged: boolean;
      readonly pieces: ReadonlyArray<Int16Array>;
    } | null = null;
    /** Her recent downlink, kept only while a bench asks for its turns (`cmd/voice/no-reply` with `keep`). */
    const played: Array<{ at: number; pcm: Int16Array }> = [];
    /** How loud his voice reaches this R1 (dBFS), from her name or a turn that named her: far quieter is the room. */
    let hisLevel = Number.NEGATIVE_INFINITY;
    /** He sent her away by voice this turn already (on its partial words): its final text changes nothing. */
    let dismissedAt = Number.NEGATIVE_INFINITY;
    /** When the R1 last sent a frame marked as heard over her voice, and whether this turn began among them. */
    let lastTaintedAt = Number.NEGATIVE_INFINITY;
    let turnTainted = false;
    /** His turn so far, for the echo check on a cut-in. */
    let turnPcm: Int16Array[] = [];
    let lastGlance = Number.NEGATIVE_INFINITY;
    /** He sent her away: the lines after it are his own, so they get no glance. */
    let sentAway = false;
    let lastWakeCue = Number.NEGATIVE_INFINITY;
    let bargedIn = false;
    let closed = false;
    /** The guided enrolment while he reads, and its summary until the card is closed. */
    let guide: EnrolGuide | null = null;
    /** The recogniser's words for the sentence being read, across the turns it spans. */
    let cardWords = { take: 0, prefix: "", turn: "", skip: 0, seen: 0 };
    let cardAt = Number.NEGATIVE_INFINITY;
    /** A session opened to enrol stays one: nothing he says in it is answered, and it ends with the guide. */
    let forEnrol = false;
    const enrolling = () => forEnrol;
    /** Her last line in the room, finished or not, so the enrolment can end once its summary has played. */
    let lastSaid: Promise<void> = Promise.resolve();
    const stopAfterSaid = () =>
      void lastSaid
        .then(() => deps.sleep(Math.max(0, playUntil + config.downDelayMs - deps.now())))
        .then(() => deps.publish(topic(id, "cmd/voice/stop"), "{}"));
    /** Turns until then need no name: S2 or her name opens it, a reply to him reopens it; audio alone never does. */
    let openUntil = 0;
    /** Listen mode (M-135): his thought so far while she only listens, and the last line's audio for his voice. */
    let listen: ListenState | null = null;
    let listenPcm: Int16Array = new Int16Array(0);
    /** Her last reply asked him something: a bare "yes" or "okay" is his answer, not the room's chatter. */
    let invited = false;
    /** S2, a wake or her name: his first turn after it is for her, however long he takes to start (00:20, 13 Nov). */
    let firstUntil = 0;
    /** Woken on the name model alone (M-144): until a turn reads as a fresh request to her, or is his, none is hers. */
    let tentative = false;
    /** When its mic last sent anything (or it opened): a session with nothing for a while is one the R1 has left. */
    let lastUpAt = deps.now();
    let heardUp = false;
    /** Mic samples the uplink never delivered (gaps in its frame numbers), and the count when this turn began. */
    let missedSamples = 0;
    let lastSeq: number | null = null;
    let turnMissedFrom = 0;
    /** Her last few sentences, to tell her own voice coming back through the mic from his. */
    let herLines: string[] = [];
    /** Her line now asks him something (a question, or her answer to her name): what he says over it is his reply. */
    let asking = false;
    const saying = (text: string) => {
      herLines = [...herLines, text].slice(-6);
      asking = invitesReply(text);
    };
    let asleep = false;
    /** He opened this session himself (her name or S2), not audio alone: a voice over hers is presumed his. */
    let opened = false;
    /** The last line she left unanswered for whose voice or whom it was to: his next turn may be about it. */
    let unheard: { readonly text: string; readonly at: number } | null = null;
    /** A turn here verified him at 0.5 or more: an unplaced voice in this session may be his. */
    let verifiedHere = false;
    /** Her brain said this turn is a private moment (PRIVATE_MARK): none of it is kept. */
    let privateTurn = false;
    const personas = roster;
    // The persona this R1 wears (Settings → Cast), else the roster's lead.
    const lead = personas.find((p) => p.id === castOf.get(id)?.persona) ?? personas[0];
    // The one he last talked to here goes on into the next session while her server holds that conversation: a lift,
    // a touch or stray audio never hands him back to the lead (20 Nov 13:27: Freya became Tessaya on a false lift).
    const held = lastWore.get(id);
    /** Who answers: the one he last called, until the window lapses. */
    let persona =
      held !== undefined && held.lead === lead?.id && deps.now() - held.at <= CURRENT_HELD_MS
        ? (personas.find((p) => p.id === held.persona) ?? lead)
        : lead;
    let voiceHold = NO_HOLD;
    /** Her name's clip when he called her without a request in the same breath: scored with his first turn. */
    let nameClip: Int16Array | null = null;
    /** The mic his frames come through now. */
    let input: VoiceInput = "mic";
    /** Since when the headset's mic has sent only silence; its fallback is said once a session. */
    let headsetDeadSince: number | null = null;
    let headsetPoorSaid = false;
    const hisSession = () => voiceHold.evidence.some((e) => deps.now() - e.at <= HOLD_MS);
    /** A turn here verified him at the anchor bar: his next turns are his unless Voice ID is sure of another voice. */
    let continuing = false;
    const presumedHis = () => hisSession() || continuing;
    /** For keeping unsure turns as data only: she was called by name, no other enrolled voice here, one voice throughout. */
    let namedWake = false;
    let otherHere = false;
    const cluster: Array<Float32Array> = [];
    let clusterSplit = false;
    const heldVoice = (heard: SpeakerIdentity) => {
      const out = holdVoice(voiceHold, heard, deps.now());
      voiceHold = out.hold;
      return out.identity;
    };
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    const speaking = () => reply !== null || deps.now() < playUntil + config.downDelayMs;
    /** What the voice reads: his own pronunciations for this R1 (and the built-in ones), never the text kept. */
    const spoken = (text: string) => pronounce(text, pronunciations.get(id) ?? {});
    /** Voice ID's switches as her brain holds them (`voice/gate`), else this loop's own. */
    const gateNow = () => voiceIdGates.get(id) ?? config.gate;
    const names = personas.map((p) => p.name);

    /**
     * Her own voice coming back through the mic, not his. While she is still playing (firmware that keeps the mic open,
     * its echo only partly cancelled), her words or a fair match in sound are enough, and a name inside her own words
     * ("Freya here") is not him calling. In the tail after she stopped, only a near match in sound is (13 Nov, 07:40).
     */
    let echoLike = 0;
    const playback = (): Playback => ({
      playUntil,
      downDelayMs: config.downDelayMs,
      echoTailMs: config.echoTailMs,
      upDelayMs: config.upDelayMs,
    });
    const herEcho = (
      pcm: Int16Array,
      text: string,
      startedAt: number,
      lastVoice: number,
      called: string | null,
    ) => {
      const verdict = echoVerdict(
        {
          startedAt,
          lastVoice,
          called: called !== null,
          own: isOwnVoice(text, herLines),
          likeness: () => echo.likeness?.(pcm, startedAt - config.upDelayMs) ?? 0,
        },
        playback(),
      );
      echoLike = verdict.likeness;
      if (verdict.compared && !verdict.hers)
        deps.log(
          `[${id}] heard over her voice${verdict.during ? "" : "'s tail"}, not her echo (echo likeness ${verdict.likeness.toFixed(2)}; Voice ID decides whose)`,
        );
      return verdict.hers;
    };

    /** Who she is talking to across this session (recognition.ts): built up turn by turn, reset by a mismatch. */
    let recog: RecognitionSession | null = null;
    /** Their name, for the next request only: the turn the session is first recognised (the cue). */
    let nameOnce: string | null = null;
    /** An act her server holds until it knows who is speaking (`voice/stepup`), and how she asked. */
    let heldAct: { readonly act: string; readonly step: StepUp; readonly at: number } | null = null;
    /** Her step-up question, asked once her reply ends: asked over it, it cut the reply off unheard (15 Nov, 08:19). */
    let askAfter: string | null = null;
    /** The member's own voice for her (their preference), once they are recognised, while the lead answers. */
    let memberVoice: string | null = null;
    let prefsFor: string | null = null;
    /** In a group turn, the member whose words are being queued now (its voice); null is the session's persona. */
    let groupVoice: RoomPersona | null = null;
    /** Her reply's tone (`[tone:x]` from her brain), said in that recorded tone of the speaking persona's clone. */
    let toneNow: string | null = null;
    const plainVoice = () =>
      groupVoice !== null
        ? groupVoice.voice
        : persona === lead && memberVoice !== null
          ? memberVoice
          : persona?.voice;
    const voiceNow = () => {
      const speaking = groupVoice ?? persona;
      const toned = toneNow === null ? undefined : speaking?.cloneTones?.[toneNow];
      // Only the persona's own clone has tones: his chosen voice for her, or a library voice, says it plainly.
      return toned !== undefined && plainVoice() === speaking?.voice ? toned : plainVoice();
    };
    /** A recognised member's own defaults: their persona unless he named another, and their voice for her. */
    const applyPrefs = () => {
      const member = recog?.verified === true ? recog.member : null;
      if (member === null || member === prefsFor) return;
      prefsFor = member;
      const prefs = prefsOf.get(member);
      memberVoice = prefs?.voice ?? null;
      const now = currentOf.get(member);
      const chosen =
        (castOf.get(id)?.follows ?? config.personaFollows) &&
        now !== undefined &&
        deps.now() - now.at <= CURRENT_HELD_MS
          ? now.persona
          : prefs?.persona;
      const wanted = personas.find(
        (p) =>
          chosen !== undefined &&
          (p.id === chosen || p.name.toLowerCase() === chosen.toLowerCase()),
      );
      if (wanted !== undefined && persona === lead && wanted !== persona) {
        persona = wanted;
        look();
      }
    };
    const hear = (identity: SpeakerIdentity, ms: number) => {
      if (identity.test !== true) recog = accumulate(recog, identity, ms, deps.now());
    };
    /** The act her server held runs (or is let go), on `voice/stepup/done`. */
    const settleStepUp = (ok: boolean, how: string) => {
      if (heldAct === null) return;
      deps.publish(
        topic(id, "voice/stepup/done"),
        JSON.stringify({ act: heldAct.act, ok, how, member: recog?.member ?? null }),
      );
      deps.log(`[${id}] step-up for ${heldAct.act}: ${ok ? "verified" : "not verified"} (${how})`);
      heldAct = null;
    };

    const playbackNow = () => {
      const run = deps.playback?.() ?? null;
      return run === null ? {} : { playback: run };
    };
    /** The turn as her server's one pipeline takes it (MEMORY-V2-DESIGN §2.0). */
    const envelopeOf = (
      given: string | undefined,
      tainted: boolean,
      words: string,
      who: RoomPersona | undefined,
      switched: boolean,
      via: Tessaya["via"],
      speaker: SpeakerIdentity,
      affect: Affect | undefined,
      segments?: Tessaya["segments"],
      scored?: { readonly words: ReadonlyArray<HeardWord>; readonly model: string } | null,
    ): Tessaya => ({
      vessel: { kind: "device", id },
      origin: given === undefined ? "voice" : "button",
      persona: (who ?? lead)?.id ?? "",
      ...(switched ? { switched: true as const } : {}),
      addressed: true,
      via,
      tainted,
      tz: config.tz,
      words,
      capabilities: capabilities.get(id) ?? [],
      ...(conversationOf.has(id) ? { conversation: conversationOf.get(id)! } : {}),
      ...(nameOnce === null ? {} : { nameOnce }),
      speaker: forWire(speaker),
      ...(affect === undefined
        ? {}
        : { emotion: { label: affect.emotion, events: affect.events } }),
      ...(segments === undefined ? {} : { segments }),
      ...(scored == null ? {} : { heardWords: scored.words, recogniser: scored.model }),
      ...playbackNow(),
      ...(playsOn.has(id) ? { plays: playsOn.get(id) === "bt" ? "bt" : "onboard" } : {}),
      ...(volumeOn.has(id) ? { volume: volumeOn.get(id)! } : {}),
    });

    /**
     * An early start (B6): at his first pause, when the recogniser's words have held still for `STABLE_MS` and end a
     * sentence, her brain starts on them before the turn ends. The final text keeps it only if it says the same words.
     */
    let early: {
      readonly seq: number;
      readonly words: string;
      readonly control: AbortController;
      readonly callId: string;
      /** Started on his held voice before this turn was judged: nothing of it is heard or done until it is. */
      readonly unjudged?: boolean;
      stream: AsyncIterable<string> | null;
    } | null = null;
    let partialNow = { words: "", changedAt: 0 };
    const earlyNow = () => early;
    /** The turn the recogniser was last given a preview of (one a turn), and the last turn that has ended. */
    let previewed = 0;
    /** The last turn whose final words are in (too late for an early start). */
    let answeredSeq = 0;
    const startEarly = () => {
      if (early !== null || enrolling() || bench.has(id) || speaking() || turnTainted) return;
      const words = partialNow.words.trim();
      if (words !== "") {
        if (deps.now() - partialNow.changedAt >= STABLE_MS) beginEarly(words, "partial");
        return;
      }
      // Short lines bring no partial words at all (13 Nov: 1 of 18 started early): at his first pause the audio so
      // far is recognised on its own, once a turn, and her brain starts on it if it reads as whole.
      if (previewed === starts || deps.preview === undefined) return;
      previewed = starts;
      const seq = starts;
      const pcm = new Int16Array(turnPcm.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of turnPcm) {
        pcm.set(p, at);
        at += p.length;
      }
      if (deps.preview === undefined) return;
      void deps
        .preview(pcm)
        .catch(() => "")
        .then((text) => {
          // Still worth it after his turn ended: her brain then starts while his final words are still being read.
          if (starts === seq && answeredSeq !== seq) beginEarly(text.trim(), "preview", seq);
        });
    };
    const beginEarly = (words: string, from: "partial" | "preview", seq = starts) => {
      if (early !== null || words === "" || !looksComplete(words)) return;
      // Listening, or about to: nothing is thought out ahead.
      if (listen !== null || classifyListen(words, { listening: false, names }).kind === "start")
        return;
      if (stopIntent(words, config.stopPhrases) !== null) return;
      const called = calledName(words, names);
      if (!addressed(words, called, turnStartedAt)) return;
      const who = personas.find((p) => p.name === called) ?? persona;
      const via: Tessaya["via"] =
        called !== null
          ? "name"
          : turnStartedAt <= firstUntil
            ? "first"
            : invited
              ? "reply"
              : "window";
      // His voice held from earlier in this session, or nobody yet: the guess starts before this turn is scored.
      const heldNow = heldVoice(UNVERIFIED(deps.now()));
      const tessaya = envelopeOf(
        undefined,
        beganOverHer(turnStartedAt, playback()),
        words,
        who,
        who !== persona,
        via,
        heldNow,
        undefined,
      );
      const control = new AbortController();
      const callId = `early-${id}-${starts}`;
      const messages = [...history, { role: "user" as const, content: words }].slice(
        -config.historyTurns * 2,
      );
      early = {
        seq,
        words,
        control,
        callId,
        unjudged: speakerPath(heldNow) === "his",
        stream: buffered(
          deps.brain(
            { deviceId: id, messages, tessaya: { ...tessaya, speculative: true, callId } },
            control.signal,
          ),
        ),
      };
      deps.log(`[${id}] early start (${from}) on his words so far (${heldBack(words)})`);
    };

    /** A line that was not answered: a glance so he sees she heard something, and a log line without his words. */
    const dropped = (turn: number, why: string, text: string) => {
      const cue = !sentAway && deps.now() - lastGlance >= 5_000;
      if (cue) {
        lastGlance = deps.now();
        gesture("glance");
      }
      deps.log(
        `[${id}] turn ${turn}: ${why}; not answered${cue ? " (a glance)" : ""} (${heldBack(text)})`,
      );
    };

    /** The session ends softly: sleepy eyes and her closing sound once her last words have played, then the mic closes. */
    const restGently = (at: number) => {
      listen = null;
      openUntil = 0;
      firstUntil = 0;
      invited = false;
      asleep = true;
      sentAway = true;
      lastActivity = deps.now();
      const closing = silent(id)
        ? Promise.resolve()
        : lastSaid
            .then(() => deps.sleep(Math.max(0, playUntil + config.downDelayMs - deps.now())))
            .then(() =>
              dismissedAt === at
                ? send(cueSamples("end"), new AbortController().signal, () => undefined)
                : undefined,
            )
            .catch(() => undefined);
      // Sent away ends the session: the R1 closes its mic and listens for her name again (14 Nov, mic stayed on).
      void closing
        .then(() => deps.sleep(Math.max(0, playUntil + config.downDelayMs - deps.now())))
        .then(() => {
          if (dismissedAt !== at) return;
          // Her "okay" reopened the window as any line of hers does: sent away, it stays shut.
          openUntil = 0;
          invited = false;
          face("sleepy");
          if (!closed) deps.publish(topic(id, "cmd/voice/stop"), "{}");
        });
    };
    /**
     * Sent away by voice: a turn on its way is cancelled and she says a brief "okay" before the soft close, never an
     * instant sleep (15 Nov). Said over her, it stops her sentence first, as any barge-in does.
     */
    /** His listen-mode settings (silence, own end words), by who is talking, else the owner's. */
    const listenConfig = () => {
      const prefs = prefsOf.get(recog?.member ?? OWNER_MEMBER_ID) ?? prefsOf.get(OWNER_MEMBER_ID);
      return {
        waitMs: listenWaitMs(prefs?.listenWait),
        ends: listenPhrases(prefs?.listenEnds),
        names,
      };
    };
    const listenCue = (name: PillSound) =>
      void send(cueSamples(name), new AbortController().signal, () => undefined).catch(
        () => undefined,
      );
    /** Listen mode on the room: a soft cue and her eyes, never words, until the thought is whole. */
    const onListen = (out: ListenOutput, turn: number) => {
      if (out.kind === "started") {
        openUntil = Number.POSITIVE_INFINITY;
        face("attentive");
        listenCue("start");
      } else if (out.kind === "ack") openUntil = Number.POSITIVE_INFINITY;
      else if (out.kind === "cancelled") {
        openUntil = deps.now() + config.followMs;
        listenCue("end");
      }
      deps.log(
        `[${id}] turn ${turn}: listen mode ${out.kind}${out.kind === "cancelled" ? ` (${out.lines.length} lines dropped)` : ""}`,
      );
    };
    const dismissNow = (why: string, words = "") => {
      const at = deps.now();
      // The same dismissal heard again (early, then final): a second pass would flush her closing tone (14 Nov, 19:40).
      if (sentAway && at - dismissedAt < 3_000) return;
      dismissedAt = at;
      stops += 1;
      if (speaking() || hold !== null) interrupt("he sent her away");
      carry = null;
      if (!silent(id)) speakNow(own(farewellEvent(words) ?? "end.ack", "Okay."));
      restGently(at);
      deps.log(`${why}; she rests`);
    };
    /** Each stop of hers (his "stop", or the R1's S2 or tap): a turn heard before it is not answered after it. */
    let stops = 0;
    /** She stops now and listens: her reply flushed, any turn on its way cancelled, the window open for his next words. */
    const stopHer = (why: string) => {
      stops += 1;
      // Her whole reply may already be on the R1 (sent up to 0.7 s ahead): still audible is still flushed. Paused,
      // the hold goes too, or its voice check stops her again every 0.3 s (09:28:22-24, 15 Nov).
      if (speaking() || hold !== null) interrupt(why.replace(/^\[[^\]]*\] /, ""));
      openUntil = deps.now() + config.followMs;
      invited = false;
      face("neutral");
      deps.log(`${why}; she stopped`);
    };
    /** `why` reaches the turn's "cut off" line: a cut-off always says why (R-070). */
    const interrupt = (why: string) => {
      releaseHold();
      reply?.abort(why);
      reply = null;
      playUntil = deps.now();
      // The R1 drops what it holds on a flush; only a Bluetooth speaker's own buffer still sounds after it.
      speechUntil = Math.min(speechUntil, playUntil - config.downDelayMs);
      deps.publish(topic(id, "voice/ctl"), JSON.stringify({ ev: "flush" }));
      echo.reset(deps.now() + config.downDelayMs);
    };

    /**
     * She paused because a voice rose over hers (open talk-over): her feed waits while the R1 plays what it holds, and
     * the voice is checked against the household's. `from` is her next sample to send.
     */
    let hold: {
      readonly since: number;
      readonly from: number;
      readonly fromSeq: number;
      readonly release: () => void;
      readonly released: Promise<void>;
      checking: boolean;
      checkedSeconds: number;
      quietSince: number | null;
      resuming: boolean;
    } | null = null;
    /** A voice over hers that was not the household's: a turn begun then is theirs, not answered. */
    let otherVoice = { from: Number.POSITIVE_INFINITY, until: Number.NEGATIVE_INFINITY };
    /** When she last went on after a voice over hers was judged not his: her own echo then paused her every 0.2 s. */
    let resumedAt = Number.NEGATIVE_INFINITY;
    /** The last 3.6 s of aligned mic frames, for the voice check while she is paused. */
    let heardLately: Array<{ readonly seq: number; readonly pcm: Int16Array }> = [];
    const releaseHold = () => {
      const h = hold;
      hold = null;
      h?.release();
    };
    /** Where each of her sentences began in the downlink: a long pause resumes from the start of the one it cut. */
    let phraseStarts: number[] = [];

    /** Paced 60 ms publishes, at most `leadMs` ahead of what the R1 is playing. */
    const send = async (pcm: Int16Array, signal: AbortSignal, onFirst: () => void) => {
      const bytes = toBytes(pcm);
      for (let at = 0; at < bytes.length && !signal.aborted; at += DOWN_FRAME_BYTES) {
        for (let h = hold; h !== null && !signal.aborted; h = hold) await h.released;
        // Awaits only when ahead: a frame that may go now goes in this same tick.
        const wait = playUntil - deps.now() - config.leadMs;
        if (wait > 0) await deps.sleep(wait);
        if (signal.aborted) return;
        // The R1 ran out by this loop's clock mid-reply: a frame in hand is this loop late, a new chunk the voice late.
        const late = deps.now() - playUntil;
        if (late > 20 && deps.now() - lastDownAt < 2_000)
          deps.log(`[${id}] downlink late ${Math.round(late)} ms (${at === 0 ? "voice" : "loop"})`);
        emit(bytes.subarray(at, at + DOWN_FRAME_BYTES));
        onFirst();
      }
    };
    const emit = (frame: Uint8Array) => {
      const start = Math.max(deps.now(), playUntil);
      if (start > playUntil) soundingFrom = start + config.downDelayMs;
      deps.publish(topic(id, "voice/down"), frame);
      deps.tap?.down(id, frame, downSamples, deps.now());
      herVoice.set(id, deps.now());
      const samples = fromBytes(frame);
      echo.reference(samples, start + config.downDelayMs);
      for (let i = 0; i < samples.length; i += 1) down[(downSamples + i) % DOWN_RING] = samples[i]!;
      downSamples += samples.length;
      lastDownAt = deps.now();
      if (bench.get(id)?.keep === true) {
        played.push({ at: start, pcm: fromBytes(frame) });
        while (played.length > 0 && played[0]!.at < start - 20_000) played.shift();
      }
      playUntil = start + (frame.length / 2 / RATE) * 1000;
      if (deps.now() - spokeAt >= 1_000) {
        spokeAt = deps.now();
        deps.arbiter?.report("speaking", id, playUntil + config.downDelayMs);
      }
    };

    const play = async (
      audio: AsyncIterable<Int16Array>,
      signal: AbortSignal,
      onFirstAudio?: () => void,
      prerollMs = 0,
      /** When its first sample will sound under the R1's speaker, on this loop's clock. */
      onStart?: (soundsAtMs: number) => void,
    ) => {
      let first = false;
      let held: Int16Array[] = [];
      let heldMs = 0;
      let marked = false;
      const out = async (pcm: Int16Array) => {
        if (!marked) {
          marked = true;
          phraseStarts = [...phraseStarts, downSamples].slice(-12);
          onStart?.(Math.max(deps.now(), playUntil) + config.downDelayMs);
        }
        await send(pcm, signal, () => {
          if (!first) onFirstAudio?.();
          first = true;
        });
        speechUntil = playUntil;
      };
      for await (const pcm of audio) {
        if (signal.aborted) return;
        if (heldMs < prerollMs) {
          held.push(pcm);
          heldMs += (pcm.length / RATE) * 1000;
          if (heldMs < prerollMs) continue;
          for (const h of held) await out(h);
          held = [];
          continue;
        }
        await out(pcm);
      }
      for (const h of held) await out(h);
    };
    // Live speech renders first: on the 2-thread TTS her pre-rendered acks queued a live reply 9.5 s (15 Nov, 09:26).
    let liveRenders = 0;
    const liveDone: Array<() => void> = [];
    const aheadRenders = new Set<AbortController>();
    async function* speakLive(
      text: string,
      signal: AbortSignal,
      voice: string | undefined,
      continuing = false,
    ) {
      liveRenders += 1;
      for (const c of aheadRenders) c.abort();
      try {
        yield* deps.speak(text, signal, voice, continuing, breathing.get(id) === true);
      } finally {
        liveRenders -= 1;
        if (liveRenders === 0) for (const go of liveDone.splice(0)) go();
      }
    }
    /** A line rendered ahead of need: it waits for live speech, and is cut by it and redone after. */
    const renderAhead = async (line: string, voice: string) => {
      for (let tries = 0; tries < 3; tries += 1) {
        if (liveRenders > 0) await new Promise<void>((go) => liveDone.push(go));
        const control = new AbortController();
        aheadRenders.add(control);
        const chunks: Int16Array[] = [];
        try {
          for await (const pcm of deps.speak(spoken(line), control.signal, voice)) {
            if (control.signal.aborted) break;
            chunks.push(pcm);
          }
          if (!control.signal.aborted) {
            ackAudio.set(`${voice}|${line}`, chunks);
            return;
          }
        } catch {
          // Not rendered: said live instead when it comes up.
          if (!control.signal.aborted) return;
        } finally {
          aheadRenders.delete(control);
        }
      }
    };
    const say = (text: string, signal: AbortSignal, onFirstAudio?: () => void) =>
      play(speakLive(spoken(text), signal, voiceNow()), signal, onFirstAudio, config.prerollMs);

    /** Starts her voice on `text` at once (after the sentence before it), buffering what it says for `play`. */
    let synthesis: Promise<void> = Promise.resolve();
    const ahead = (
      text: string,
      signal: AbortSignal,
      /** Its whole length in ms, once it is all made. */
      onMade?: (ms: number) => void,
      continuing = false,
    ): AsyncIterable<Int16Array> => {
      const voice = voiceNow();
      const chunks: Int16Array[] = [];
      let done = false;
      let failed: unknown = null;
      let wake: (() => void) | null = null;
      const nudge = () => {
        wake?.();
        wake = null;
      };
      synthesis = synthesis.then(async () => {
        try {
          let samples = 0;
          for await (const pcm of speakLive(spoken(text), signal, voice, continuing)) {
            if (signal.aborted) break;
            chunks.push(pcm);
            samples += pcm.length;
            nudge();
          }
          if (!signal.aborted) onMade?.((samples / RATE) * 1000);
        } catch (error) {
          failed = error;
        } finally {
          done = true;
          nudge();
        }
      });
      return {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; ;) {
            if (i < chunks.length) yield chunks[i++]!;
            else if (done) {
              if (failed !== null) throw failed;
              return;
            } else await new Promise<void>((r) => (wake = r));
          }
        },
      };
    };

    /** The eyes and gestures (firmware 3.30.x `cmd/eye/set` and `cmd/eye/gesture`); unknown names are ignored there. */
    /** Every eye command the loop sends is logged, and a persona look waits for the R1's acknowledgement. */
    const eye = (tail: string, body: Record<string, string>) => {
      const payload = JSON.stringify(body);
      // Changes only: his Tessel's Wi-Fi is weak, and every pause sent "attentive" and a nod again (18 Nov, 00:15:55).
      const shown = eyeShown.get(id);
      if (
        tail === "cmd/eye/set" &&
        shown?.payload === payload &&
        deps.now() - shown.at < EYE_RESEND_MS
      )
        return;
      const gestureKey = `${id}|${body["name"]}`;
      if (
        tail === "cmd/eye/gesture" &&
        deps.now() - (gestureAt.get(gestureKey) ?? -Infinity) < GESTURE_GAP_MS
      )
        return;
      if (tail === "cmd/eye/set") eyeShown.set(id, { payload, at: deps.now() });
      if (tail === "cmd/eye/gesture") gestureAt.set(gestureKey, deps.now());
      deps.log(`[${id}] eye sent ${tail} ${payload}`);
      if (tail === "cmd/eye/persona") {
        eyeAsked.set(id, { name: body["name"] ?? "", at: deps.now() });
        worn.set(id, body["name"] ?? "");
      }
      deps.publish(topic(id, tail), payload);
    };
    // Sent away always shows at once; otherwise a mood of her server's that still holds is not overwritten.
    const face = (mood: string) => {
      if (mood !== "sleepy" && deps.now() < (eyeHold.get(id) ?? 0)) return false;
      // At rest the eyes return to her mood (`voice/intent/rest`), not a blank neutral.
      eye("cmd/eye/set", (mood === "neutral" ? restFace.get(id) : undefined) ?? { mood });
      return true;
    };
    const gesture = (name: string) => eye("cmd/eye/gesture", { name });
    /** He talked over her: her server tells the persona layers, so anything timed to her words stops (VOXTA I4). */
    const bargeIn = () => deps.publish(topic(id, "event/voice/barge"), "{}");
    /**
     * A sentence's stage directions on the words they sit before (VOXTA-STUDY G7), timed on this loop's playback
     * clock: by letters across the sentence's measured length, as the R1 has no aligner. Null when it has none.
     */
    const wordEffects = (text: string, signal: AbortSignal) => {
      const pieces = speechPieces(spoken(text), voiceNow() ?? "");
      const sounds = soundAnchors(pieces).filter((s) => {
        const e = effectFor(VESSELS.tessel, s.nonverbal);
        return e.face !== null || e.haptic !== null;
      });
      if (sounds.length === 0) return null;
      let clock: SentenceClock = { startMs: null, durationMs: null, text: saidText(pieces) };
      const schedule = (next: Partial<SentenceClock>) => {
        clock = { ...clock, ...next };
        const timeline = { nowMs: deps.now(), sentences: [clock], endMs: null };
        const at = sounds.map((s) =>
          fireAtMs({ at: "speech", sentence: 0, word: s.word }, timeline),
        );
        if (at.includes(null)) return;
        for (const [i, s] of sounds.entries())
          void deps.sleep(Math.max(0, at[i]! - deps.now())).then(() => {
            if (signal.aborted) return;
            const look = effectFor(VESSELS.tessel, s.nonverbal).face;
            deps.effect?.(id, s.nonverbal, look !== null && face(look) ? look : null);
          });
      };
      return {
        onMade: (durationMs: number) => schedule({ durationMs }),
        onStart: (startMs: number) => schedule({ startMs }),
      };
    };
    /** The persona's own eyes (the eye lane's looks; firmware without them ignores the topic). */
    const look = () => eye("cmd/eye/persona", { name: persona?.eyes ?? GENERIC_EYES });
    /** A session opens on the lead whatever the last one wore: the eyes follow (17 Nov, 23:29). */
    const wear = () => {
      if (worn.get(id) !== (persona?.eyes ?? GENERIC_EYES)) look();
    };
    /** Who her server put on this body mid-session (a hand-off, "bring Alfred here"), worn once her reply ends. */
    let recastTo: string | null = null;
    const wearCast = () => {
      const named = personas.find((p) => p.id === recastTo);
      recastTo = null;
      if (named === undefined || named === persona) return;
      persona = named;
      wear();
    };
    /** Her own words for one of the loop's moments, her eyes showing its mood; `plain` while they are off. */
    const own = (event: LineEvent, plain: string, facts?: Readonly<Record<string, string>>) => {
      const said = deps.lines?.take(
        event,
        persona?.id ?? "",
        recog?.member ?? undefined,
        plain,
        facts,
      );
      const mood = said?.mood == null ? null : eyeClipOf(said.mood);
      if (mood !== null) face(mood);
      return said?.text ?? plain;
    };
    /** Her step-up ask in her own words; the phrase and his name exact. */
    const stepUpWords = (step: Parameters<typeof stepUpLine>[0]): string | null => {
      if (stepUpLine(step) === null || step.kind === "none") return null;
      const ask =
        step.kind === "phrase"
          ? own("id.phrase", `Say "${step.phrase}" for me.`, { phrase: step.phrase })
          : step.kind === "confirm"
            ? own("id.confirm", `Is that you, ${step.name}?`, { name: step.name })
            : own("id.phone", "Tap yes on your phone if that's you.");
      return step.explain ? `${own("id.unsure", NOT_SURE_YET)} ${ask}` : ask;
    };

    /** Her last "I'm here", so it is never the same twice running, and when it was. */
    // Kept per R1 across sessions: every S2 or wake opens a new one (17:23 replay: "Yes?" twice running).
    const acked = ackState.get(id) ?? { line: null, at: Number.NEGATIVE_INFINITY };
    ackState.set(id, acked);
    let ackScheduledAt = Number.NEGATIVE_INFINITY;
    /** Her "I'm here" lines in this persona's voice, rendered once so they play at once. */
    const prerenderAcks = () => {
      const voice = voiceNow();
      if (config.acknowledge !== "voice" || voice === undefined || ackRendered.has(voice)) return;
      ackRendered.add(voice);
      void (async () => {
        for (const line of ackLines(persona?.id ?? "")) await renderAhead(line, voice);
      })();
    };
    /** Her own next acknowledgements, rendered ahead like the plain ones so they play at once. */
    const prerenderOwn = () => {
      const voice = voiceNow();
      const lines = deps.lines;
      if (config.acknowledge !== "voice" || voice === undefined || lines === undefined) return;
      const next = (["ack.name", "ack.again"] as const).flatMap((event) =>
        lines.upcoming(persona?.id ?? "", recog?.member ?? undefined, event),
      );
      void (async () => {
        for (const line of next)
          if (!ackAudio.has(`${voice}|${line}`)) await renderAhead(line, voice);
      })();
    };
    let lastExchangeAt = Number.NEGATIVE_INFINITY;
    /** He said her name (or pressed S2) and then nothing: she shows she is listening, varied and in context. */
    const acknowledge = () => {
      if (config.acknowledge === "off") return;
      face("attentive");
      if (bench.has(id)) return deps.log(`[${id}] her name alone: bench, not said`);
      if (config.acknowledge === "tone") {
        if (!silent(id))
          void send(cueSamples("wake"), new AbortController().signal, () => undefined).catch(
            () => undefined,
          );
        return;
      }
      const name = recog?.verified === true && !recog.named ? recog.name : null;
      const line = pickAck(
        {
          personaId: persona?.id ?? "",
          hour: Number(
            new Intl.DateTimeFormat("en-GB", {
              hour: "numeric",
              hourCycle: "h23",
              timeZone: config.tz,
            }).format(deps.now()),
          ),
          sinceExchangeMs: deps.now() - lastExchangeAt,
          sinceAckMs: deps.now() - acked.at,
          name,
          last: acked.line,
        },
        deps.random ?? Math.random,
      );
      acked.at = deps.now();
      if (line === null) {
        deps.log(`[${id}] her name alone: her look, no words`);
        return;
      }
      acked.line = line;
      if (name !== null && line.includes(name) && recog !== null) recog = { ...recog, named: true };
      const words = own(
        line === "Still here."
          ? "ack.again"
          : name !== null && line.includes(name)
            ? "ack.named"
            : "ack.name",
        line,
        name === null ? {} : { name },
      );
      deps.log(`[${id}] her name alone: "${words}"`);
      speakNow(words, ackAudio.get(`${voiceNow() ?? ""}|${words}`));
      asking = true;
      prerenderOwn();
    };

    const speakNow = (text: string, audio?: ReadonlyArray<Int16Array>) => {
      saying(text);
      const control = new AbortController();
      reply = control;
      lastActivity = deps.now();
      lastSaid = (
        audio === undefined
          ? say(text, control.signal)
          : play(
              (async function* () {
                yield* audio;
              })(),
              control.signal,
            )
      )
        .catch(() => undefined)
        .finally(() => {
          if (reply !== control) return;
          reply = null;
          if (askAfter !== null) askNow();
          // Whatever she said, he may answer it: the window follows her voice, not only her replies to him.
          if (control.signal.aborted) return;
          invited = invitesReply(text);
          openUntil = Math.max(
            openUntil,
            Math.max(deps.now(), playUntil + config.downDelayMs) +
              (invited ? config.replyHoldMs : config.followMs),
          );
        });
    };

    const askNow = () => {
      const line = askAfter;
      askAfter = null;
      if (line !== null && heldAct !== null) speakNow(line);
    };

    /** Said to her: she was named, or it began inside the window and is more than a stray "yeah" she did not ask for. */
    const addressed = (words: string, called: string | null, startedAt: number) => {
      if (tentative && called === null && !hisSession() && !isFreshRequest(words)) {
        deps.log(
          `[${id}] woken on her name's score alone, and this was not a request to her; not answered (${heldBack(words)})`,
        );
        return false;
      }
      tentative = false;
      return addressedInRoom(words, called !== null, startedAt, {
        firstUntil,
        openUntil,
        invited,
        hisAlone: hisSession() && otherVoice.until < startedAt - config.followMs,
      });
    };

    /** When the turn being heard began: the window is about when he started, not when recognition finished. */
    let turnStartedAt = 0;
    /** His sound on this turn against his usual; a good turn of a verified voice teaches that usual. */
    const soundOf = (
      pcm: Int16Array,
      startedAt: number,
      lastVoice: number,
      speaker: SpeakerIdentity,
      scores: ReadonlyArray<HeardWord> | undefined,
    ): InputQuality => {
      const herUntil = speechUntil + config.downDelayMs;
      const m = measureInput(pcm, {
        missingMs: ((missedSamples - turnMissedFrom) * 1000) / RATE,
        herOverlap:
          lastVoice > startedAt
            ? Math.max(0, Math.min(lastVoice, herUntil) - startedAt) / (lastVoice - startedAt)
            : 0,
        ...(scores === undefined ? {} : { confidences: scores.map((w) => w.p) }),
      });
      const who = speaker.verified ? speaker.personId : null;
      const quality = inputQualityOf(m, baselines.of(who));
      if (who !== null && quality.verdict === "good") baselines.learn(who, m);
      return quality;
    };
    /**
     * `given` is a turn already in words (an R1 button's prompt): addressed to her, with no voice to read. `heard` is
     * his voice already in words (a request in the same breath as her name): his turn, with `pcm` its voice.
     */
    const answer = async (
      pcm: Int16Array,
      reason: string,
      lastVoice: number,
      startedAt: number,
      given?: string,
      heard?: string,
      /** Voice ID already begun on this very audio (her name's segment, from its end). */
      voice?: Promise<SpeakerIdentity | undefined>,
    ) => {
      const turn = (turnNo += 1);
      const decidedAt = deps.now();
      // Begun while her voice was still in the room (before a cut-in or her reply's end moves that on).
      const tainted = given === undefined && beganOverHer(startedAt, playback());
      // Begun while she was still playing (the mic open over her): only a stop, a dismissal or her name counts.
      const over =
        given === undefined &&
        // His voice stopped her (open talk-over): this turn is what he said over her, and it is answered.
        !(cutByVoiceAt >= startedAt && cutByVoiceAt - startedAt < 3_000) &&
        (turnTainted || startedAt <= speechUntil + config.downDelayMs + 300) &&
        // Still talking once her voice and its tail are gone: normal speech again (10:36, 13 Nov).
        lastVoice - config.upDelayMs <= speechUntil + config.downDelayMs + config.echoTailMs;
      const stopsAt = stops;
      let sound: InputQuality | undefined;
      const envelope = (
        words: string,
        who: RoomPersona | undefined,
        switched: boolean,
        via: Tessaya["via"],
        speaker: SpeakerIdentity,
        affect: Affect | undefined,
        segments?: Tessaya["segments"],
      ): Tessaya => {
        // Scores only for the very words they scored (not a joined or corrected turn).
        const scores =
          heardScores !== null && sameWords(heardScores.words.map((w) => w.text).join(" "), words)
            ? heardScores
            : null;
        if (given === undefined && pcm.length > 0)
          sound ??= soundOf(pcm, startedAt, lastVoice, speaker, scores?.words);
        const t = envelopeOf(
          given,
          tainted,
          words,
          who,
          switched,
          via,
          speaker,
          affect,
          segments,
          scores,
        );
        return sound === undefined ? t : { ...t, input: sound };
      };
      let heardScores: ReturnType<NonNullable<RecogniserTurn["words"]>> = null;
      const current = given === undefined && heard === undefined ? rec : null;
      if (current !== null) rec = null;
      // The whole sentence re-scored replaces its first piece's verdict in his session, never adds to it.
      let holdBefore: VoiceHold | null = null;
      let holdSet: VoiceHold | null = null;
      let notAVoice = false;
      let scorings = 0;
      const nameFirst = given === undefined ? nameClip : null;
      if (given === undefined) nameClip = null;
      const scored = (audio: Int16Array, begun = audio === pcm ? voice : undefined) => {
        const n = (scorings += 1);
        const via = input;
        const held = (heard: SpeakerIdentity) => {
          holdBefore ??= voiceHold;
          const out = holdVoice(holdBefore, heard, deps.now());
          if (n === scorings && !notAVoice) voiceHold = holdSet = out.hold;
          // Begun over her voice, his session alone never makes it his: it needs a voice score of its own (18 Nov, 00:16).
          const who =
            tainted && out.identity.lifted === true && heard.own === undefined
              ? heard
              : out.identity;
          // Our own test playback in the room never teaches, whatever it scored.
          const how = via === "mic" && (deps.playback?.() ?? null) === null ? teaches(who) : null;
          if (how !== null && n === scorings)
            deps.learnRoom?.(who.personId!, who.own!.vector!, {
              at: deps.now(),
              how,
              score: who.own!.score,
              ms: who.own!.ms,
            });
          if (via === "mic" && who.verified) micVerifiedAt.set(id, deps.now());
          else if (
            via !== "mic" &&
            who.personId === "owner" &&
            deps.now() - (micVerifiedAt.get(id) ?? -Infinity) <= HOLD_MS &&
            (deps.playback?.() ?? null) === null
          )
            deps.learnInput?.(via, who.personId, audio);
          return who;
        };
        const own = begun ?? deps.speaker?.(audio, via);
        const joined =
          nameFirst === null || via !== "mic" || own === undefined
            ? undefined
            : deps.speaker?.(concatPcm(nameFirst, audio), via).catch(() => undefined);
        return own?.then(
          (heard) => {
            const alone = heard ?? UNVERIFIED(deps.now());
            return joined === undefined
              ? held(alone)
              : joined.then((both) => held(both === undefined ? alone : withName(alone, both)));
          },
          () => held(UNVERIFIED(deps.now())),
        );
      };
      /** Her own voice back or noise: what it scored never moves his session (26 Nov 20:13, her echo ended it). */
      const notHisVoice = () => {
        notAVoice = true;
        if (holdSet !== null && voiceHold === holdSet && holdBefore !== null)
          voiceHold = holdBefore;
      };
      let speakerP = given === undefined ? scored(pcm) : undefined;
      const affectP = given === undefined ? deps.affect?.(pcm).catch(() => undefined) : undefined;
      const voicesP = given === undefined ? deps.voices?.(pcm).catch(() => undefined) : undefined;
      let affectNow: Awaited<typeof affectP>;
      void affectP?.then((a) => (affectNow = a));
      // Who spoke never waits on how they sounded: tied to the mood reader, a ready Voice ID was dropped (15 Nov).
      let speakerNow: { readonly identity: Awaited<typeof speakerP> } | null =
        speakerP === undefined ? { identity: undefined } : null;
      let verdictAt: number | null = null;
      const settle = (p: typeof speakerP) =>
        void p?.then((identity) => {
          if (speakerP !== p) return;
          speakerNow = { identity };
          verdictAt = deps.now();
        });
      settle(speakerP);
      let sides = Promise.all([speakerP, affectP]);
      // What she would send her brain for these words, or null when this turn would not be answered.
      const seq = starts;
      const viaOf = (called: string | null, at: number): Tessaya["via"] =>
        given !== undefined
          ? "button"
          : called !== null
            ? "name"
            : at <= firstUntil
              ? "first"
              : invited
                ? "reply"
                : "window";
      const ask = async (words: string) => {
        const called = calledName(
          words,
          personas.map((p) => p.name),
        );
        if (!addressed(words, called, startedAt) || bench.has(id)) return null;
        // A guess waits for who is speaking (it may only answer whom the final turn would answer), not for the mood.
        const speaker = await speakerP;
        const affect = affectNow;
        const identity = speaker ?? UNVERIFIED(deps.now());
        if (!admits(identity, gateNow(), "turn")) return null;
        const who = personas.find((p) => p.name === called) ?? persona;
        const tessaya = envelope(
          words,
          who,
          who !== persona,
          viaOf(called, startedAt),
          identity,
          affect,
        );
        const messages = [...history, { role: "user" as const, content: words }].slice(
          -config.historyTurns * 2,
        );
        return { deviceId: id, messages, tessaya };
      };
      // A guess: her brain starts on the recogniser's latest words while it finishes; the final text decides.
      type Guess = {
        words: string;
        control: AbortController;
        stream: AsyncIterable<string> | null;
        callId: string;
        unjudged?: boolean;
      };
      // His pause already started her brain on these words (an early start): it is this turn's first guess.
      let guess: Guess | null =
        given === undefined && early !== null && early.seq === seq ? early : null;
      let guesses = guess === null ? 0 : 1;
      early = null;
      let settled = false;
      const tryGuess = (words: string) => {
        if (settled || enrolling() || words.trim() === "") return;
        if (guess !== null && sameWords(guess.words, words)) return;
        if (guesses >= MAX_GUESSES) return;
        guesses += 1;
        guess?.control.abort();
        const control = new AbortController();
        const mine: Guess = {
          words,
          control,
          stream: null,
          callId: `guess-${id}-${turn}-${guesses}`,
        };
        guess = mine;
        void ask(words).then((request) => {
          // Too late once the final text is in: that path calls the brain itself.
          if (request === null || settled || control.signal.aborted || guess !== mine) return;
          mine.stream = buffered(
            deps.brain(
              {
                ...request,
                tessaya: { ...request.tessaya, speculative: true, callId: mine.callId },
              },
              control.signal,
            ),
          );
        });
      };
      let latest = "";
      current?.onPartial?.((words) => {
        // "Dismissed" heard while the recogniser still works on it (10:36:40: 4.9 s): she rests now.
        if (!settled && stopIntent(words, config.stopPhrases) === "dismiss")
          dismissNow(`[${id}] turn ${turn}: dismissed (heard early)`, words);
        latest = words;
        tryGuess(words);
      });
      if (latest !== "") tryGuess(latest);
      const raw = (given ?? heard ?? (await current?.finish().catch(() => "")) ?? "").trim();
      settled = true;
      if (given === undefined) {
        answeredSeq = seq;
        // A preview that started her brain after his turn had ended, while these final words were read.
        const late = earlyNow();
        if (guess === null && late !== null && late.seq === seq) {
          guess = late;
          guesses = 1;
        }
        if (late?.seq === seq) early = null;
      }
      const textAt = deps.now();
      // The guess is kept only when it heard the same words; otherwise it never speaks.
      const last = guess as Guess | null;
      let kept = last !== null && sameWords(last.words, raw) ? last : null;
      if (last !== null && kept === null) last.control.abort();
      if (last?.callId.startsWith("early-") === true)
        deps.log(
          `[${id}] turn ${turn}: early start ${kept === null ? "dropped (his final words differ)" : "kept"}`,
        );
      // A read for the enrolment card is not said to her; a button's prompt still is.
      if (enrolling() && given === undefined) return;
      // Muted or stopped while it was being recognised (13 Nov, 08:39 to 08:50: the R1 muted, the turn was still answered).
      if (closed) {
        kept?.control.abort();
        if (raw !== "")
          deps.log(
            `[${id}] turn ${turn}: the ${DEVICE} was muted or stopped; not answered (${heldBack(raw)})`,
          );
        return;
      }
      heardScores = current?.words?.() ?? null;
      const recognisedBy = current?.by?.() ?? null;
      // Pure noise, or words the recogniser never really heard (V-018): no turn, and nothing said about it.
      if (
        given === undefined &&
        raw !== "" &&
        heardScores !== null &&
        sameWords(heardScores.words.map((w) => w.text).join(" "), raw) &&
        repairVerdict(heardScores.words, repairBoundsFor(heardScores.model)).kind === "drop"
      ) {
        kept?.control.abort();
        notHisVoice();
        deps.log(`[${id}] turn ${turn}: noise, not words; not answered (${heldBack(raw)})`);
        return;
      }
      // Words he paused in, held for this turn: joined to it, or answered alone when this one is not his to her.
      const held =
        given === undefined && carry !== null && deps.now() - carry.at <= 15_000 ? carry : null;
      const rawCalled = raw === "" ? null : calledName(raw, names);
      // Her own voice through the R1's mic: timing and how it sounds, never her words alone (13 Nov, 07:40 and 07:41).
      const echoed =
        given === undefined && raw !== "" && herEcho(pcm, raw, startedAt, lastVoice, rawCalled);
      // A bench sweep (`cmd/voice/no-reply`): heard, judged and logged, never answered or kept in the conversation.
      const sweep = bench.get(id);
      if (given === undefined && sweep !== undefined && raw !== "") {
        kept?.control.abort();
        deps.log(
          `[${id}] turn ${turn}: bench, not answered; ${echoed ? "her own voice" : "his"} (likeness ${echoLike.toFixed(2)}, ${heldBack(raw)})`,
        );
        if (sweep.keep)
          deps.keep?.({
            device: id,
            turn,
            startedAt,
            lastVoice,
            text: raw,
            herLines,
            echoed,
            likeness: echoLike,
            mic: pcm,
            played: played.filter((p) => p.at >= startedAt - 8_000 && p.at <= lastVoice + 1_000),
          });
        return;
      }
      const matched = raw === "" ? null : stopMatch(raw, config.stopPhrases);
      const intent = matched?.intent ?? null;
      // Sent away: the session rests here and now, with no brain call and nothing joined to it (10:36-10:37, 13 Nov).
      if (given === undefined && !echoed && intent === "dismiss") {
        kept?.control.abort();
        dismissNow(`[${id}] turn ${turn}: dismissed`, raw);
        return;
      }
      if (dismissedAt >= startedAt) {
        kept?.control.abort();
        return;
      }
      if (
        given === undefined &&
        !presumedHis() &&
        startedAt >= otherVoice.from &&
        startedAt <= otherVoice.until
      ) {
        kept?.control.abort();
        dropped(turn, "not a household voice over hers", raw);
        return;
      }
      if (over && raw !== "" && !echoed && intent === null && rawCalled === null) {
        // Her own words back or an "oh" over her is not a new request ("yes" may answer her, so it is not dropped).
        if (isOwnVoice(raw, herLines) || /^(?:oh|ah|um|uh|hm+|mm+)[.!?,]*$/i.test(raw.trim())) {
          kept?.control.abort();
          if (isOwnVoice(raw, herLines)) notHisVoice();
          dropped(turn, "over her voice and not a stop", raw);
          return;
        }
        // With a household enrolled, the whole turn's voice decides: his own words over her are answered, the TV's and
        // a visitor's are not (14 Nov, 21:39: his, dropped; keyword mode never ran the check while she played).
        // A reply to her question or her name is judged on what came after her voice: mixed with hers, his own reply
        // scored 0.02-0.30 (17 Nov, 19:22). With under a second of it alone it is answered; Voice ID still picks the path.
        const herEnd = speechUntil + config.downDelayMs + config.echoTailMs;
        const judged = asking
          ? pcm.subarray(
              Math.min(pcm.length, Math.max(0, Math.round(((herEnd - startedAt) * RATE) / 1000))),
            )
          : pcm;
        if (deps.members?.() === true && (!asking || judged.length >= RATE)) {
          const best = await (
            deps.member?.(judged) ?? Promise.resolve(Number.NEGATIVE_INFINITY)
          ).catch(() => Number.NEGATIVE_INFINITY);
          const verdict = memberByVoice(best, judged.length / RATE, presumedHis() || asking);
          // In his session words over her that are not her own are his (his mixed scores -0.09 to 0.20), unless they move
          // like her playing reply: her misheard echo cut her off as his (20 Nov, 03:19 GMT+5, likeness 0.77).
          // shortcut: his own words over a loud echo can read as alike; they wait for AEC on the barge-in audio.
          if (verdict !== "member" && presumedHis() && echoLike >= ECHO_ALIKE) {
            kept?.control.abort();
            notHisVoice();
            dropped(
              turn,
              `over her voice and moving like her own reply (likeness ${echoLike.toFixed(2)}, Voice ID ${best.toFixed(2)})`,
              raw,
            );
            return;
          } else if (verdict !== "member" && presumedHis())
            deps.log(
              `[${id}] turn ${turn}: over her voice, Voice ID ${best.toFixed(2)} in the mix; his session, so answered`,
            );
          else if (verdict !== "member") {
            kept?.control.abort();
            dropped(turn, `over her voice and not a household voice (${best.toFixed(2)})`, raw);
            unheard = { text: raw, at: deps.now() };
            return;
          }
        }
        // The person who woke her is answered over her voice, never a glance (14 Nov, 18:57).
        if (speaking()) interrupt("the person who woke her spoke over her");
        bargedIn = true;
        deps.log(`[${id}] turn ${turn}: over her voice; she stopped to answer`);
      }
      // He (or the R1's S2 or a tap) stopped her while this turn was on its way: it is not answered.
      if (stopsAt !== stops) {
        kept?.control.abort();
        return;
      }
      // "Stop" (not her name): she stops and listens for what he says next; nothing to answer.
      if (
        given === undefined &&
        !echoed &&
        intent === "stop" &&
        rawCalled === null &&
        listen === null
      ) {
        kept?.control.abort();
        // Nothing of hers to stop: his "stop" sends her away like a dismissal.
        if (!tainted && !speaking() && reply === null && cutByVoiceAt < startedAt)
          return dismissNow(
            `[${id}] turn ${turn}: he said stop ("${matched?.phrase}") with nothing to stop`,
          );
        stopHer(`[${id}] turn ${turn}: he said stop ("${matched?.phrase}")`);
        return;
      }
      const mine =
        raw !== "" && !echoed && (given !== undefined || addressed(raw, rawCalled, startedAt));
      if (echoed) notHisVoice();
      if (raw !== "" && !mine)
        dropped(
          turn,
          echoed ? `her own voice (likeness ${echoLike.toFixed(2)})` : "not said to her",
          raw,
        );
      if (raw !== "" && !mine && !echoed) unheard = { text: raw, at: deps.now() };
      if (!mine && held === null) {
        kept?.control.abort();
        return;
      }
      const prev = current_;
      // "Oh." or "okay" trailing his last line is part of it, not a new question (10:36:11: asked twice).
      if (
        mine &&
        given === undefined &&
        held === null &&
        prev !== null &&
        rawCalled === null &&
        startedAt - prev.endedAt <= config.joinMs &&
        isBackchannel(raw.replace(/^(?:oh|ah|um|uh|hm+)[.!?,]*$/i, "ok"))
      ) {
        kept?.control.abort();
        deps.log(
          `[${id}] turn ${turn}: the tail of his last line; not answered (${heldBack(raw)})`,
        );
        return;
      }
      let text = mine ? raw : "";
      let pieces: ReadonlyArray<Int16Array> = mine ? [pcm] : [];
      if (held !== null && carry === held) {
        carry = null;
        text = `${held.text} ${text}`.trim();
        pieces = [...held.pieces, ...pieces];
      }
      // The rest of a turn of his still being answered and not yet heard: one sentence, answered once. Once she has
      // started answering it, it is answered as it was, never asked again.
      if (
        mine &&
        given === undefined &&
        prev !== null &&
        !prev.merged &&
        startedAt - prev.endedAt <= config.joinMs &&
        prev.firstAt === null
      ) {
        prev.merged = true;
        const at = history.indexOf(prev.entry);
        if (at >= 0) history.splice(at, 1);
        text = `${prev.text} ${text}`;
        pieces = [...prev.pieces, ...pieces];
      }
      if (text !== raw) {
        kept?.control.abort();
        kept = null;
      }
      // He stopped mid-sentence, or has already gone on: hold it for his next words.
      // Held at most 2.5 s from the first piece, or `GONE_ON_MS` while he is already talking again (18 Nov, 00:15:55: his
      // one question in six pieces over 10 s was cut at 2.8 s); a room that keeps talking is never one endless sentence.
      const since = held?.since ?? deps.now();
      const goneOn = starts > seq;
      if (
        given === undefined &&
        (isUnfinished(text) || goneOn) &&
        deps.now() - since < (goneOn ? GONE_ON_MS : config.joinMs + 500)
      ) {
        const hold = { text, at: deps.now(), since, pieces };
        carry = hold;
        kept?.control.abort();
        if (starts === seq) await deps.sleep(config.joinMs);
        if (carry !== hold || starts > seq) {
          deps.log(`[${id}] turn ${turn}: held for the rest of his sentence (${heldBack(text)})`);
          return;
        }
        carry = null;
      }
      if (pieces.length > 1) {
        // Voice ID on the whole sentence, not its last piece: "And" alone scored him as unverified (15 Nov).
        if (given === undefined && deps.speaker !== undefined) {
          speakerP = scored(joinedAudio(pieces));
          speakerNow = null;
          settle(speakerP);
          sides = Promise.all([speakerP, affectP]);
        }
        text = await wholeSentence(text, pieces, deps.preview);
      }
      text = askedFor(text, names)?.text ?? text;
      const heardName = calledName(text, names);
      const called = answersHer(
        text,
        heardName,
        history.findLast((h) => h.role === "assistant")?.content,
      )
        ? null
        : heardName;
      // Another device of his is answering: what this one hears now is her voice from there, or his to that one.
      if (given === undefined && deps.now() < (quietUntil.get(id) ?? 0)) {
        kept?.control.abort();
        dropped(turn, "another device is answering", text);
        return;
      }
      // Her name with no window open: the arbiter picks the one device that answers (R1-P7).
      if (
        given === undefined &&
        called !== null &&
        deps.arbiter !== undefined &&
        !addressed(text, null, startedAt)
      ) {
        const level = speechLevel(pcm);
        const arbiter = deps.arbiter;
        gates.set(
          id,
          (speakerP ?? Promise.resolve(undefined)).then((heardBy) =>
            claimFor(
              arbiter,
              {
                deviceId: id,
                wakeScore: 1,
                loudnessDb: Number.isFinite(level) ? level : null,
                ...(heardBy === undefined
                  ? {}
                  : { speaker: { personId: heardBy.personId, verified: heardBy.verified } }),
              },
              `[${id}] turn ${turn}`,
            ),
          ),
        );
      }
      if (given === undefined && called === null) {
        // A voice far quieter than his name was is the room, not him. A language only counts against a line when the
        // household speaks English alone: an English recogniser writes Urdu as half-words of other languages (13 Nov).
        const level = speechLevel(pcm);
        const far = Number.isFinite(hisLevel) && level < hisLevel - FAR_DB;
        const spoken = languagesOf.get(id) ?? config.languages;
        if ((onlyEnglish(spoken) && mostlyForeign(text)) || far) {
          kept?.control.abort();
          dropped(
            turn,
            far
              ? `far quieter than his voice (${(level - hisLevel).toFixed(0)} dB)`
              : "another language",
            text,
          );
          return;
        }
      } else if (given === undefined) {
        const level = speechLevel(pcm);
        if (Number.isFinite(level)) hisLevel = level;
      }
      const via = viaOf(called, startedAt);
      const named = personas.find((p) => p.name === called);
      const switched = named !== undefined && named !== persona;
      if (switched) {
        persona = named;
        look();
      }
      if (asleep) face("attentive");
      asleep = false;
      sentAway = false;
      lastActivity = deps.now();
      stray = false;
      // Listen mode (M-135): his lines are kept, not answered, until the thought is whole; then it is one turn.
      const heardListen = listenStep(
        listen,
        { type: "utterance", text, at: deps.now() },
        listenConfig(),
      );
      if (heardListen.out.kind !== "pass") {
        listen = heardListen.state;
        kept?.control.abort();
        if (heardListen.out.kind !== "done") {
          listenPcm = pcm;
          return onListen(heardListen.out, turn);
        }
        deps.log(`[${id}] turn ${turn}: listen mode done (${heardListen.out.why})`);
        text = heardListen.out.text;
        openUntil = deps.now() + config.followMs;
      }
      let dismissed = isDismissal(text) || stopIntent(text, config.stopPhrases) === "dismiss";
      let listensAfter = false;
      // Her brain starts now with what the speaker reader already knows; in his own session it first waits a moment
      // for this turn's verdict (started without one, his pump asked for a yes: 20 Nov, 06:03 GMT+5).
      const session = presumedHis();
      await Promise.race([speakerP, deps.sleep(session ? VERDICT_WAIT_MS : 0)]);
      const known = speakerNow === null ? null : ([speakerNow.identity, affectNow] as const);
      const [speaker, affect] = known ?? [undefined, affectNow];
      // Still none in his session: the session rule, his voice held (inherited: his path and his own house commands,
      // nothing learned). A verdict that keeps the voice out still stops her when it lands.
      const sessionVoice =
        known === null && session
          ? {
              ...UNVERIFIED(deps.now()),
              kind: "owner" as const,
              personId: "owner",
              inherited: true,
            }
          : null;
      // Ignoring him is the worst failure: a voice just under the bar in his own session is answered as likely him.
      const identity =
        sessionVoice ?? likelyHis(speaker ?? UNVERIFIED(deps.now()), session, continuing);
      const voicesAt = deps.now();
      const voices = (await voicesP) ?? { kind: "one" };
      if (voices.kind === "one-at-a-time") {
        kept?.control.abort();
        deps.log(
          `[${id}] turn ${turn}: several voices at once (${voices.why}); one at a time (${heldBack(text)})`,
        );
        speakNow(own("err.overlap", "One at a time, please."));
        return;
      }
      // Several people: the turn is heard when any one of them would be on their own.
      const someoneAdmitted =
        voices.kind === "many" && voices.spans.some((s) => admits(s.identity, gateNow(), "turn"));
      // Speculate, don't trust (Director, 16 Nov): with no verdict yet her brain starts closed to his path (a guest's
      // reach), and his verdict before its first words asks again as his. A guess begun on his held voice is heard
      // only once this turn's verdict is his. A verdict that keeps the voice out stops her, whenever it lands.
      const unjudged = known === null && kept?.unjudged === true;
      let refused = false;
      const judged = sides.then(([late]) => {
        if (late === undefined || known !== null || someoneAdmitted) return true;
        const ok = admits(late, gateNow(), "turn") && (!unjudged || speakerPath(late) === "his");
        if (ok) return true;
        refused = true;
        // Logged apart from a stop or a lost claim, which all read "cut off" (09:28:06, 15 Nov).
        deps.log(`[${id}] turn ${turn}: Voice ID heard a ${late.kind} voice; not answered`);
        return false;
      });
      let admittedP: Promise<boolean> | null = null;
      // Asked when her first sentence is ready, so Voice ID has her brain's whole wait; a closed start waits `sideMs`.
      const admitted = () =>
        (admittedP ??=
          known !== null || someoneAdmitted
            ? Promise.resolve(true)
            : unjudged
              ? judged
              : Promise.race([judged, deps.sleep(config.sideMs).then(() => !refused)]));
      // Only his turn verified at the anchor bar starts it, and his soft voice carries it on; anyone else ends it.
      // (21 Nov 06:04 GMT+5: a guest woke her and scored 0.32; an unverified opener never becomes him.)
      const sureOther =
        identity.kind === "saved" || (identity.same !== undefined && identity.same < CHANGED_VOICE);
      continuing =
        !sureOther &&
        ((identity.kind === "owner" &&
          identity.verified &&
          identity.inherited !== true &&
          (identity.confidence ?? 0) >= ANCHOR_BAR) ||
          (continuing && (identity.kind === "owner" || identity.kind === "unverified")));
      if (!admits(identity, gateNow(), "turn") && !someoneAdmitted) {
        kept?.control.abort();
        dropped(turn, `a ${identity.kind} voice`, text);
        unheard = { text, at: deps.now() };
        return;
      }
      // Each person's words recognised from their own span alone: no one's words carry another's voice.
      const segments =
        voices.kind === "many" && deps.preview !== undefined
          ? await segmentsOf(voices.spans, pcm, deps.preview)
          : undefined;
      if (segments !== undefined) {
        // A guess heard the room as one voice.
        kept?.control.abort();
        kept = null;
        deps.log(
          `[${id}] turn ${turn}: ${segments.length} people (${Math.round(deps.now() - voicesAt)} ms)`,
        );
      }
      if (closed) {
        kept?.control.abort();
        return;
      }
      // Recognition across the session: this turn's voice adds to it (or, heard late, to the next turn's).
      const speechMs = (pcm.length / RATE) * 1000;
      if (given === undefined) {
        if (known !== null) hear(identity, speechMs);
        else void sides.then(([late]) => late !== undefined && hear(late, speechMs));
      }
      // "Test mode on/off": his verified voice only (the clone may only turn it off); this step waits for the verdict.
      const testAsk =
        given === undefined && deps.testMode !== undefined ? testModeAsked(text) : null;
      if (testAsk !== null) {
        kept?.control.abort();
        const who = (await speakerP) ?? UNVERIFIED(deps.now());
        // This turn's own score: a verdict his session carries never turns test mode on (REQ-13-089).
        const his = who.kind === "owner" && ownVoiceVerified(who);
        speakNow(
          testAsk === "off" && (his || who.test === true)
            ? setTestMode(id, null, `by voice, ${who.test === true ? "the test speaker" : "his"}`)
            : testAsk === "on" && his
              ? setTestMode(id, TEST_MODE_MAX_MS / 60_000, "by his voice")
              : "Only he can turn test mode on, in his own voice.",
        );
        return;
      }
      if (identity.test === true)
        deps.log(
          `[${id}] turn ${turn}: TEST SPEAKER answered as him (test mode, until ${clockOf(testUntil)})`,
        );
      // He went on while these words were on their way (the recogniser took 1.5-2 s): joined to the rest of his sentence
      // in the order he said them, never answered apart and then talked over (18 Nov, 00:16:01).
      if (given === undefined && starts > seq && deps.now() - since < GONE_ON_MS) {
        kept?.control.abort();
        if (prev !== null && prev.merged && current_ === prev)
          interrupt("he went on: joined to the rest of his sentence");
        const mineHeld = { text, at: deps.now(), since, pieces };
        const other = carry !== null && deps.now() - carry.at <= 15_000 ? carry : null;
        const [first, then] =
          other === null
            ? [mineHeld, null]
            : other.since <= since
              ? [other, mineHeld]
              : [mineHeld, other];
        carry =
          then === null
            ? first
            : {
                text: `${first.text} ${then.text}`,
                at: deps.now(),
                since: first.since,
                pieces: [...first.pieces, ...then.pieces],
              };
        deps.log(`[${id}] turn ${turn}: held for the rest of his sentence (${heldBack(text)})`);
        return;
      }
      // Her answer to a step-up ("say amber river", "is that you?"): scored, and the held act runs once verified.
      if (given === undefined && heldAct !== null && answersStepUp(heldAct.step, text)) {
        kept?.control.abort();
        if (recog?.verified === true) {
          settleStepUp(true, "voice");
          speakNow(own("id.ok", "Thanks, that's you."));
        } else {
          settleStepUp(false, "voice");
          speakNow(own("id.failed", "I still can't tell it's you, so I've left that."));
        }
        return;
      }
      if (recog !== null && called === null) applyPrefs();
      if (recog !== null) {
        const cue = cueOf(recog);
        recog = cue.session;
        // "I know you": a brief warm look (the persona's own, if it has one), then back.
        if (cue.glance) {
          eye("cmd/eye/set", { mood: persona?.cueMood ?? "happy" });
          void deps.sleep(900).then(() => face("attentive"));
        }
        nameOnce = cue.name;
      }
      firstUntil = 0;
      openUntil = Number.POSITIVE_INFINITY;
      // What she left unanswered just before is his to ask about ("Did you hear what I said?", 26 Nov 21:26 GMT+5):
      // her brain sees it marked as unplaced, never as his words, and a guess begun without it is not used.
      if (
        unheard !== null &&
        deps.now() - unheard.at <= UNHEARD_MS &&
        speakerPath(identity) === "his" &&
        given === undefined
      ) {
        history.push({ role: "user", content: unheardLine(unheard.text) });
        kept?.control.abort();
        kept = null;
      }
      unheard = null;
      const entry = { role: "user" as const, content: text };
      history.push(entry);
      const me = {
        text,
        endedAt: lastVoice,
        firstAt: null as number | null,
        entry,
        merged: false,
        pieces,
      };
      current_ = me;
      // One reply at a time: two playing at once interleave their frames on the downlink, which sounds chopped.
      // Still audible counts too: her last reply may already be on the R1.
      if (speaking()) bargeIn();
      if (reply !== null || speaking()) interrupt(`turn ${turn} took over`);
      const control = kept?.control ?? new AbortController();
      reply = control;
      let brainFirst: number | null = null;
      let reasked = false;
      let ttsFirst: number | null = null;
      let firstSound: number | null = null;
      /** What she actually says: her reasoning, when the brain writes it out, is never spoken or kept (13 Nov). */
      let said = "";
      /** A group member's eyes were shown this turn: the session persona's come back after. */
      let groupEyes = false;
      // The Tessel ends a session after 120 s with no speech, reply audio or voice/ctl: a long brain turn is not idle.
      // @effect-diagnostics-next-line globalTimers:off
      const turnAlive = setInterval(
        () => deps.publish(topic(id, "voice/ctl"), JSON.stringify({ ev: "turn" })),
        30_000,
      );
      try {
        let buffer = "";
        toneNow = null;
        let firstSentenceAt: number | null = null;
        let speakingChain = Promise.resolve();
        let lost = false;
        const won = async () => {
          const ok = await gateOf(id);
          if (!ok && !lost) deps.log(`[${id}] turn ${turn}: another R1 answers`);
          lost ||= !ok;
          return ok;
        };
        const enqueue = (whole: string) => {
          // Never "Alfred here." on every turn (10:36:57, 13 Nov): his persona is already known.
          const sentence = withoutSelfIntro(whole, names);
          if (sentence !== whole.trim())
            deps.log(`[${id}] turn ${turn}: her self-introduction, not said`);
          if (sentence === "") return;
          if (isNarration(sentence)) {
            deps.log(`[${id}] turn ${turn}: her reasoning, not said (${heldBack(sentence)})`);
            return;
          }
          said = `${said} ${sentence}`.trim();
          saying(sentence);
          const continuing = firstSentenceAt !== null;
          const preroll = continuing ? 0 : config.prerollMs;
          firstSentenceAt ??= deps.now();
          const effects = wordEffects(sentence, control.signal);
          const audio = ahead(sentence, control.signal, effects?.onMade, continuing);
          speakingChain = speakingChain.then(async () =>
            // The arbiter is asked alongside, never before (13 Nov: a 1.3-1.7 s claim round in front of every wake);
            // only her voice waits for its answer, and a lost claim is never heard.
            !(await won()) || !(await admitted()) || refused || control.signal.aborted
              ? control.abort(
                  control.signal.aborted
                    ? control.signal.reason
                    : refused
                      ? "Voice ID kept the voice out"
                      : "another vessel or Voice ID took the turn",
                )
              : play(
                  audio,
                  control.signal,
                  () => {
                    if (firstSound === null) {
                      me.firstAt = deps.now();
                      firstSound = deps.now() - lastVoice;
                      ttsFirst = deps.now() - (firstSentenceAt ?? deps.now());
                    }
                  },
                  preroll,
                  effects?.onStart,
                ),
          );
          // If the brain's stream fails first, the catch below skips `await speakingChain`: an abort must not crash us.
          speakingChain.catch(() => undefined);
        };
        const tessaya = envelope(text, persona, switched, via, identity, affect, segments);
        nameOnce = null;
        // His final words matched the guess and it is the one answered: the changes it held may now be made, once
        // a guess begun on his held voice has his verdict too.
        if (kept !== null) {
          const callId = kept.callId;
          void (unjudged ? judged : Promise.resolve(true)).then(
            (ok) => ok && deps.confirmed?.(callId),
          );
        }
        const brainOn = (t: Tessaya, signal: AbortSignal) =>
          deps.brain(
            { deviceId: id, messages: history.slice(-config.historyTurns * 2), tessaya: t },
            signal,
          );
        const pending =
          known === null && sessionVoice === null && speakerP !== undefined ? speakerP : undefined;
        const reopened = async function* (verdict: NonNullable<typeof pending>) {
          const closedStart = new AbortController();
          const stop = () => closedStart.abort();
          control.signal.addEventListener("abort", stop, { once: true });
          const it = brainOn(tessaya, closedStart.signal)[Symbol.asyncIterator]();
          const first = it.next();
          first.catch(() => undefined);
          const won = await Promise.race([first.then(() => null), verdict.then((v) => v ?? null)]);
          if (won !== null && speakerPath(won) === "his" && admits(won, gateNow(), "turn")) {
            closedStart.abort();
            control.signal.removeEventListener("abort", stop);
            reasked = true;
            deps.log(
              `[${id}] turn ${turn}: Voice ID said ${won.kind} before her first words; asked again as his`,
            );
            yield* brainOn({ ...tessaya, speaker: won }, control.signal);
            return;
          }
          for (let r = await first; r.done !== true; r = await it.next()) yield r.value;
        };
        const source =
          kept?.stream ??
          (pending === undefined ? brainOn(tessaya, control.signal) : reopened(pending));
        for await (const delta of source) {
          brainFirst ??= deps.now() - textAt;
          buffer += delta;
          const toned = toneOf(buffer);
          if (toned.tone !== null && said === "") toneNow = toned.tone;
          buffer = toned.text;
          // Her brain heard him close the conversation: her sign-off plays, then the session rests by itself.
          // A private moment (her private self answered): nothing of this turn is kept.
          if (buffer.includes(PRIVATE_MARK)) {
            buffer = buffer.replaceAll(PRIVATE_MARK, "");
            privateTurn = true;
          }
          if (buffer.includes(REST_MARK)) {
            buffer = buffer.replaceAll(REST_MARK, "");
            dismissed = true;
          }
          if (buffer.includes(LISTEN_MARK)) {
            buffer = buffer.replaceAll(LISTEN_MARK, "");
            listensAfter = true;
          }
          // A group turn (M-021): the last speaker's words go out whole in its voice; the next voice starts after them,
          // and its eyes show when its first words play.
          for (let m = atSpeakerMark(buffer); m !== null; m = atSpeakerMark(buffer)) {
            const before = splitSentences(m.before);
            before.done.forEach(enqueue);
            if (before.rest.trim() !== "") enqueue(before.rest.trim());
            buffer = m.after;
            const next = personas.find((p) => p.id === m!.id) ?? persona;
            groupVoice = next === persona ? null : (next ?? null);
            const eyes = next?.eyes ?? GENERIC_EYES;
            speakingChain = speakingChain.then(() => {
              if (!control.signal.aborted) eye("cmd/eye/persona", { name: eyes });
            });
            groupEyes = true;
          }
          const { done, rest } = splitSentences(buffer);
          buffer = rest;
          done.forEach(enqueue);
          // Her first words go to her voice at the first clause, not the first full stop: the brain sends a word, then
          // the rest about half a second later (13 Nov, Sonnet).
          if (firstSentenceAt === null) {
            const clause = firstClause(buffer);
            // A clause of her reasoning waits for its whole sentence, judged and dropped as one.
            if (clause !== null && !isNarration(clause.head)) {
              enqueue(clause.head);
              buffer = clause.rest;
            }
          }
        }
        if (buffer.trim() !== "") enqueue(buffer.trim());
        // Sent away, she always says so before she rests, even when her brain had nothing to add.
        if (dismissed && said === "") enqueue("Okay.");
        await speakingChain;
        // A kept guess was only a guess until he heard it: now the server records it and learns from it.
        if (kept !== null && !control.signal.aborted) deps.played?.(kept.callId);
        // Back to rest once the R1 has played the last of it (the server's own mood may still hold until then).
        if (!control.signal.aborted)
          void deps.sleep(Math.max(0, playUntil + config.downDelayMs - deps.now())).then(() => {
            if (reply === null || reply === control) face(dismissed ? "sleepy" : "neutral");
          });
        if (dismissed && !control.signal.aborted) {
          dismissedAt = deps.now();
          restGently(dismissedAt);
        }
      } catch (error) {
        if (control.signal.aborted)
          deps.log(
            `[${id}] turn ${turn}: cut off (${typeof control.signal.reason === "string" ? control.signal.reason : "no reason recorded"})`,
          );
        else {
          deps.log(
            `[${id}] turn ${turn} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          const sorry = "Sorry, I couldn't reach my brain just then.";
          const greet = greetEvent(me.text, deps.now() - lastExchangeAt < SAME_CONVERSATION_MS);
          await say(own(greet ?? "err.brain", sorry), control.signal).catch(() => undefined);
        }
      } finally {
        clearInterval(turnAlive);
        groupVoice = null;
        if (groupEyes) void deps.sleep(Math.max(0, playUntil - deps.now())).then(look);
        if (reply === control || reply === null) {
          invited = !dismissed && invitesReply(said);
          openUntil = dismissed
            ? 0
            : Math.max(deps.now(), playUntil + config.downDelayMs) +
              (invited ? config.replyHoldMs : config.followMs);
          // Her brain heard him ask her to only listen: listen mode starts as her line ends.
          if (listensAfter && !dismissed) {
            const begun = listenStep(null, { type: "start", at: deps.now() }, listenConfig());
            listen = begun.state;
            onListen(begun.out, turn);
          }
        }
        if (reply === control) reply = null;
        if (reply === null && recastTo !== null) wearCast();
        if (current_ === me) current_ = null;
        if (reply === null) {
          spokeAt = Number.NEGATIVE_INFINITY;
          deps.arbiter?.report("ended", id);
        }
        if (reply === null && askAfter !== null) {
          if (dismissed) askAfter = null;
          else askNow();
        }
        if (said !== "" && !me.merged) history.push({ role: "assistant", content: said });
        if (said !== "") lastExchangeAt = deps.now();
        lastActivity = deps.now();
      }
      // Voice ID's own figures come from its last verdict, even one that came after her answer began.
      const verdict = speakerNow?.identity ?? identity;
      const score = verdict.own?.score ?? verdict.confidence;
      const r3 = (n: number) => Math.round(n * 1000) / 1000;
      const metrics: TurnMetrics = {
        // @effect-diagnostics-next-line globalDate:off - the loop has no Effect; a plain ISO stamp.
        at: new Date(deps.now()).toISOString(),
        device: id,
        turn,
        reason,
        endpointMs: Math.round(decidedAt - lastVoice),
        asrMs: Math.round(textAt - decidedAt),
        brainFirstMs: brainFirst === null ? null : Math.round(brainFirst),
        ttsFirstMs: ttsFirst === null ? null : Math.round(ttsFirst),
        firstSoundMs: firstSound === null ? null : Math.round(firstSound),
        text,
        speaker: identity.kind,
        verified: identity.verified,
        ...(config.host === "" ? {} : { host: config.host }),
        ...(verdict.kind === identity.kind ? {} : { verdict: verdict.kind }),
        speakerScore: score === null ? null : r3(score),
        lifted: verdict.lifted === true,
        ...(verdict.same === undefined ? {} : { same: r3(verdict.same) }),
        ...(verdict.replay === undefined && verdict.replayScore === undefined
          ? {}
          : {
              replay: {
                verdict: verdict.replay ?? "pass",
                score: verdict.replayScore === undefined ? null : r3(verdict.replayScore),
              },
            }),
        ...(recognisedBy === null ? {} : { recogniser: recognisedBy }),
        ...(sound === undefined ? {} : { input: sound }),
        emotion: (affect ?? affectNow)?.emotion ?? "unknown",
        bargedIn,
        speculative: kept !== null,
        voiceIdMs: verdictAt === null ? null : Math.round(verdictAt - lastVoice),
        voiceIdLate: known === null && given === undefined,
        ...(identity.test === true ? { test: true } : {}),
        ...(reasked ? { reasked: true } : {}),
      };
      // His own voice only: a turn Voice ID verified as him, or his words over her in his session (never a member's or a
      // guest's), and only while his setting keeps it on (voice/capture).
      const his =
        identity.kind === "owner" &&
        identity.verified &&
        identity.test !== true &&
        identity.carried !== true;
      const overHis =
        bargedIn && hisSession() && identity.kind !== "saved" && identity.kind !== "guest";
      if (his && (score ?? 0) >= ANCHOR_BAR) verifiedHere = true;
      // A turn Voice ID could not place, in a session where another turn verified him at 0.5 or more: his far and soft
      // turns are the ones it misses (20 Nov 13:26, 17:44). Kept apart, 14 days, never to shape his voice.
      // Or, as data only, in a session she was called into by name where no other enrolled voice matched and every
      // turn is one voice (his soft voice never verifies, so nothing else ever keeps it: 21 Nov, 06:03 GMT+5).
      const vector = identity.replay === undefined ? identity.own?.vector : undefined;
      if (identity.kind === "saved") otherHere = true;
      if (vector !== undefined) {
        if (cluster.length > 0 && cosine(vector, meanUnit(cluster)) < SAME_VOICE)
          clusterSplit = true;
        cluster.push(vector);
      }
      const oneVoice = namedWake && !otherHere && !clusterSplit && vector !== undefined;
      const doubtful =
        !his &&
        !overHis &&
        (verifiedHere || oneVoice) &&
        (identity.kind === "unverified" || identity.carried === true) &&
        !bargedIn;
      // Never a private moment's audio, whoever spoke (the condition he set).
      if (
        given === undefined &&
        text !== "" &&
        capturing.get(id) !== false &&
        !muted.has(id) &&
        !privateTurn &&
        (his || overHis || doubtful)
      )
        deps.keepTurn?.(id, pcm, {
          turn,
          text,
          speaker: identity.kind,
          score: score === null ? null : r3(score),
          overHer: bargedIn,
          ...(doubtful ? { verified: false } : {}),
        });
      privateTurn = false;
      bargedIn = false;
      deps.publish(topic(id, "event/voice/metrics"), JSON.stringify(metrics));
      deps.log(`[${id}] metrics ${JSON.stringify(metrics)}`);
    };

    /**
     * His words while she is still speaking (firmware that sends the mic during playback): once they are said to her and
     * are not her own voice coming back, she stops at once and his new turn is the one answered.
     */
    const cutIn = (words: string) => {
      if ((!speaking() && !turnTainted) || enrolling() || bench.has(id) || words.trim() === "")
        return;
      const called = calledName(words, names);
      // Over her voice only a stop, a dismissal or her name counts (13 Nov): never what else the room or her echo says.
      const intent = stopIntent(words, config.stopPhrases);
      if (called === null && intent === null) return;
      const pcm = new Int16Array(turnPcm.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of turnPcm) {
        pcm.set(p, at);
        at += p.length;
      }
      if (herEcho(pcm, words, turnStartedAt, deps.now(), called)) return;
      bargedIn = true;
      deps.log(`[${id}] he cut in; her reply stopped`);
      interrupt("he cut in");
      bargeIn();
    };

    const act = (actions: ReadonlyArray<TurnAction>) => {
      for (const a of actions) {
        switch (a.kind) {
          case "barge":
            // Not cut off on sound alone: it is often her own voice. His words, once they are his to her, stop her.
            bargedIn = true;
            break;
          case "start":
            rec?.cancel();
            rec = deps.recognise({
              owner:
                voiceHold.verifiedAt !== null &&
                deps.now() - voiceHold.verifiedAt <= HOLD_MS &&
                speechLevel(a.pcm) >= PERSONAL_FLOOR_DB,
            });
            deps.link?.();
            starts += 1;
            turnPcm = [a.pcm];
            rec.onPartial?.(cutIn);
            early?.control.abort();
            early = null;
            partialNow = { words: "", changedAt: deps.now() };
            rec.onPartial?.((words) => {
              if (!sameWords(words, partialNow.words))
                partialNow = { words, changedAt: deps.now() };
            });
            if (enrolling()) {
              cardWords.prefix = `${cardWords.prefix} ${cardWords.turn}`.trim();
              cardWords.turn = "";
              cardWords.skip = 0;
              cardWords.seen = 0;
              rec.onPartial?.(heardForCard);
            }
            rec.feed(a.pcm);
            // The preroll is already in `a.pcm`, so his first word came that long before now.
            turnStartedAt = deps.now() - (a.pcm.length / RATE) * 1000;
            turnTainted = deps.now() - lastTaintedAt < 500;
            turnMissedFrom = missedSamples;
            if (!asleep) face("attentive");
            break;
          case "audio":
            rec?.feed(a.pcm);
            turnPcm.push(a.pcm);
            break;
          case "check": {
            startEarly();
            const { id: checkId, pcm } = a;
            void deps.smartTurn(pcm).then(
              (p) => act(turns.verdict(checkId, p)),
              () => undefined,
            );
            break;
          }
          case "end": {
            if (!asleep) gesture("nodSmall");
            answering = answer(a.pcm, a.reason, lastVoiceAt, turnStartedAt);
            break;
          }
        }
      }
    };

    const card = (now: boolean) => {
      if (guide === null || (!now && deps.now() - cardAt < CARD_MS)) return;
      cardAt = deps.now();
      deps.publish(topic(id, "event/enrol"), JSON.stringify(guide.view()));
    };
    /** A partial for the card: the words since this sentence began, though a turn may hold the end of the last one. */
    const heardForCard = (text: string) => {
      const g = guide;
      if (g === null || g.phase() !== "reading") return;
      const said = text.split(/\s+/).filter((w) => w !== "");
      const no = g.take().no;
      if (no !== cardWords.take)
        cardWords = { take: no, prefix: "", turn: "", skip: cardWords.seen, seen: 0 };
      cardWords.seen = said.length;
      cardWords.turn = said.slice(cardWords.skip).join(" ");
      if (g.heard(`${cardWords.prefix} ${cardWords.turn}`.trim(), no)) card(true);
    };
    const enrolled = async (g: EnrolGuide) => {
      const clips = g.clips();
      const all = new Int16Array(clips.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of clips) {
        all.set(c, at);
        at += c.length;
      }
      const result = await (
        deps.enrolOwner?.(speechWindows(all)) ??
        Promise.resolve({ saved: false, said: "I can't keep a voice print here." })
      ).catch(() => ({
        saved: false,
        said: "The voice profile could not be made. Nothing was saved.",
      }));
      if (guide !== g) return;
      g.finish({
        saved: result.saved,
        headline: result.saved ? "Your voice profile is ready" : "Nothing was saved",
        rows: result.saved ? [] : [{ label: "What happened", value: result.said }],
      });
      card(true);
      speakNow(result.said);
      stopAfterSaid();
    };
    /** His sentence passed its checks: its voice is compared with the others', and the profile is made once all are in. */
    const accepted = (g: EnrolGuide, index: number, pcm: Int16Array) =>
      void (deps.embed?.(pcm).catch(() => null) ?? Promise.resolve(null)).then((vector) => {
        if (guide !== g) return;
        const step = g.voice(index, vector);
        card(step.changed);
        if (step.ready) void enrolled(g);
      });

    /**
     * Open talk-over: the frame's own header says which of her samples were under the speaker as it was heard
     * (rx - q, firmware 0.3.92), so her playback lines up with the mic to the sample, and his voice rising over what
     * is left of hers stops her at once. The words then go through the same echo and addressing checks as any turn.
     */
    let benchOverAt = Number.NEGATIVE_INFINITY;
    let benchOver = 0;
    const heardOver = (pcm: Int16Array, seq: number, rx: number, q: number) => {
      voiceLevel.push(pcm);
      heardLately = [...heardLately, { seq, pcm }].slice(-60);
      // Nothing in flight and nothing queued: the R1 has every byte sent, so its count and ours differ by a constant.
      if (q === 0 && deps.now() - lastDownAt > 1_000) downBase = rx - downSamples * 2;
      if (downBase === null) return;
      const at = seq * pcm.length;
      // From 32 ms before the device's latency: the detector finds the rest (it only looks later, never earlier).
      const from = (rx - q - downBase) / 2 - R1_LATENCY + 512;
      const ref = new Int16Array(pcm.length);
      for (let i = 0; i < ref.length; i += 1) {
        const n = from + i;
        if (n >= 0 && n < downSamples && n > downSamples - DOWN_RING) ref[i] = down[n % DOWN_RING]!;
      }
      talk.reference(ref, at);
      const heard = talk.process(pcm, at).some((v) => v.ready && v.speech);
      if (hold !== null) {
        followHold(hold, heard);
        return;
      }
      // Only her sound can be talked over: a reply still thinking is his own voice going on (09:26:47, 15 Nov).
      if (
        !heard ||
        deps.now() >= playUntil + config.downDelayMs ||
        enrolling() ||
        lastProb < config.turn.stopProb
      )
        return;
      if (deps.now() - cutByVoiceAt < 1_000 || deps.now() - soundingFrom < ONSET_GRACE_MS) return;
      // Just went on after a voice judged not his: no new pause for a moment (19 Nov 05:01:13-15: 24 pauses in 3 s on her
      // own echo). His words still reach the turn path and are answered there.
      if (deps.now() - resumedAt < RESUME_QUIET_MS) return;
      // Someone across the room is far quieter than he is; whose voice it is decides the rest.
      if (!voiceLevel.reaches(Number.isFinite(hisLevel) ? hisLevel - FAR_DB : TALK_MIN_DBFS))
        return;
      // Only a household voice may stop her, so with nobody enrolled it stays keyword.
      if (deps.member === undefined || deps.members?.() !== true) return;
      // A bench never pauses her, but says when it would have, so an echo fix can be counted on her own playback.
      if (bench.has(id)) {
        benchOver += 1;
        if (deps.now() - benchOverAt < 1_000) return;
        deps.log(`[${id}] bench: a voice over hers (would pause; ${benchOver} frames)`);
        benchOverAt = deps.now();
        benchOver = 0;
        return;
      }
      let release = () => undefined as void;
      const released = new Promise<void>((r) => (release = r));
      // Only the feed pauses, no flush: her echo in a case passes the detector, and a flush drops what the R1 holds
      // and refuses frames sent again within 400 ms, so each false pause skipped her speech (18 Nov, 03:23 GMT+5).
      // A household voice flushes in stopHer; any other lets the feed go on from its next sample.
      hold = {
        since: deps.now(),
        from: downSamples,
        // His first words began about the detector's 256 ms before it was sure, plus a frame.
        fromSeq: seq - 5,
        release,
        released,
        checking: false,
        checkedSeconds: 0,
        quietSince: null,
        resuming: false,
      };
      deps.log(`[${id}] a voice over hers; she paused`);
    };

    /** While she is paused: once enough of the voice is in, a household voice stops her, any other lets her go on. */
    const followHold = (h: NonNullable<typeof hold>, heard: boolean) => {
      if (h.resuming || h.checking) return;
      h.quietSince = heard ? null : (h.quietSince ?? deps.now());
      const quiet = h.quietSince !== null && deps.now() - h.quietSince >= 600;
      const frames = heardLately.filter((f) => f.seq >= h.fromSeq);
      const seconds = frames.reduce((n, f) => n + f.pcm.length, 0) / RATE;
      if (!voiceCheckDue(seconds, h.checkedSeconds, quiet)) return;
      h.checking = true;
      h.checkedSeconds = seconds;
      const clip = new Int16Array(seconds * RATE);
      let at = 0;
      for (const f of frames) {
        clip.set(f.pcm, at);
        at += f.pcm.length;
      }
      void (deps.member?.(clip) ?? Promise.resolve(Number.NEGATIVE_INFINITY))
        .catch(() => Number.NEGATIVE_INFINITY)
        .then((best) => {
          if (hold !== h) return;
          h.checking = false;
          // A voice that has stopped is judged on what there is.
          const verdict = memberByVoice(
            best,
            quiet || seconds >= 2.5 ? Math.max(seconds, 2) : seconds,
            presumedHis(),
            opened,
          );
          deps.log(
            `[${id}] the voice over hers: ${verdict} (${best.toFixed(2)} at ${seconds.toFixed(1)} s)`,
          );
          if (verdict === "member") {
            cutByVoiceAt = deps.now();
            bargedIn = true;
            stopHer(`[${id}] talked over`);
          } else if (verdict === "other") resume(h);
        });
    };

    /** Not the household's voice: she goes on from where she paused (Voice ID's ~2 s makes any restart a repeat). */
    const resume = (h: NonNullable<typeof hold>) => {
      h.resuming = true;
      deps.log(`[${id}] not a household voice; she goes on from where she paused`);
      resumedAt = deps.now();
      if (!presumedHis()) otherVoice = { from: h.since - 1_000, until: deps.now() };
      goOn(h, false, 0);
    };

    /**
     * Where her replies play changed while she spoke (his route, or headphones that stopped taking audio): what the
     * device held is dropped and the sentence starts again on the new output, so no sentence is split between two
     * outputs and none plays on both (18 Nov, 00:38 GMT+5).
     */
    const rerouted = (out: string) => {
      // Only audio sent and not yet over: a reply still thinking has nothing on the old output.
      if (deps.now() >= playUntil + config.downDelayMs || hold !== null) return;
      let release = () => undefined as void;
      const released = new Promise<void>((r) => (release = r));
      // Her sample sounding now, by this loop's clock: the uplink that would say it is the one a busy radio starves.
      const sounding = downSamples - ((playUntil + config.downDelayMs - deps.now()) * RATE) / 1000;
      const h: Parameters<typeof resume>[0] = {
        since: deps.now(),
        from: Math.max(0, sounding),
        fromSeq: Number.MAX_SAFE_INTEGER,
        release,
        released,
        checking: false,
        checkedSeconds: 0,
        quietSince: null,
        resuming: true,
      };
      hold = h;
      playUntil = deps.now();
      deps.publish(topic(id, "voice/ctl"), JSON.stringify({ ev: "flush" }));
      deps.log(`[${id}] replies now play on ${out}; her sentence starts again there`);
      // The device refuses a flushed reply's frames until none has come for 400 ms.
      goOn(h, true, REFLUSH_GAP_MS);
    };

    /** Her downlink again from `h.from` (its sentence's start when `fromSentence`), then the reply goes on. */
    const goOn = (h: NonNullable<typeof hold>, fromSentence: boolean, afterMs: number) => {
      const back = fromSentence
        ? (phraseStarts.filter((p) => p <= h.from).at(-1) ?? h.from)
        : h.from;
      const from = Math.max(Math.floor(back), downSamples - DOWN_RING + 1);
      const again = new Int16Array(Math.max(0, downSamples - from));
      for (let i = 0; i < again.length; i += 1) again[i] = down[(from + i) % DOWN_RING]!;
      const signal = reply?.signal ?? new AbortController().signal;
      void (async () => {
        if (afterMs > 0) await deps.sleep(afterMs);
        const bytes = toBytes(again);
        for (let at = 0; at < bytes.length; at += DOWN_FRAME_BYTES) {
          // He or S2 may stop her mid-resume: the hold is gone or the reply cancelled.
          if (hold !== h || signal.aborted) break;
          const wait = playUntil - deps.now() - config.leadMs;
          if (wait > 0) await deps.sleep(wait);
          emit(bytes.subarray(at, at + DOWN_FRAME_BYTES));
        }
        if (hold === h) releaseHold();
      })();
    };

    const onWindow = async (window: Int16Array, arrivedAt: number) => {
      const prob = await vad.score(window);
      lastProb = prob;
      let heard = prob;
      if (speaking()) {
        // While she talks, a window the echo guard reads as only her own voice cannot cut her off.
        const v = echo.process(window, arrivedAt - config.upDelayMs);
        if (v.ready && !v.nearEnd) heard = 0;
      }
      if (heard >= config.turn.stopProb) lastVoiceAt = arrivedAt;
      act(turns.feed(window, heard, speaking()));
    };

    return {
      /** A mic frame; `tainted` when the R1 sent it while playing her voice (`voice/up/tainted`, firmware 0.3.45). */
      frame: (bytes: Uint8Array, tainted = false) => {
        if (closed) return;
        const arrivedAt = deps.now();
        if (tainted) lastTaintedAt = arrivedAt;
        lastUpAt = arrivedAt;
        heardUp = true;
        const aligned =
          bytes.length > UP_HEADER && (bytes.length - UP_HEADER) % DOWN_FRAME_BYTES === 0;
        if (aligned) deps.tap?.up(id, bytes, arrivedAt);
        const pcm = fromBytes(aligned ? bytes.subarray(UP_HEADER) : bytes);
        const head = aligned ? new DataView(bytes.buffer, bytes.byteOffset, UP_HEADER) : null;
        if (head !== null)
          input = (head.getUint16(12, true) & UP_FLAG_HEADSET) !== 0 ? "headset" : "mic";
        if (input === "headset" && pcm.every((v) => Math.abs(v) < HEADSET_DEAD_PEAK))
          headsetDeadSince ??= arrivedAt;
        else headsetDeadSince = null;
        // Her own voice (the intro) is not his read.
        if (guide !== null && guide.phase() === "reading" && !speaking()) {
          const g = guide;
          const step = g.frame(pcm);
          if (step.accepted !== null) accepted(g, step.accepted.index, step.accepted.pcm);
          card(step.changed);
        }
        const all = new Int16Array(pending.length + pcm.length);
        all.set(pending);
        all.set(pcm, pending.length);
        let at = 0;
        for (; at + WINDOW <= all.length; at += WINDOW) {
          const window = all.slice(at, at + WINDOW);
          chain = chain.then(() => onWindow(window, arrivedAt));
        }
        pending = all.slice(at);
        if (head !== null) {
          const seq = head.getUint32(0, true);
          // A jump in frame numbers is mic audio Wi-Fi lost; a big one is the R1 restarting its count.
          if (lastSeq !== null && seq > lastSeq + 1 && seq - lastSeq < 500)
            missedSamples += (seq - lastSeq - 1) * pcm.length;
          lastSeq = seq;
        }
        if (head !== null && open(id)) {
          const seq = head.getUint32(0, true);
          const rx = head.getUint32(4, true);
          const q = head.getUint32(8, true);
          chain = chain.then(() => heardOver(pcm, seq, rx, q));
        }
      },
      /** He let go of push-to-talk (firmware 3.32 `ptt_end`): answer what he said, then end the session once it has played. */
      released: () => {
        return (chain = chain.then(async () => {
          act(turns.release());
          await answering.catch(() => undefined);
          await deps.sleep(Math.max(0, playUntil + config.downDelayMs - deps.now()));
          deps.publish(topic(id, "cmd/voice/stop"), "{}");
        }));
      },
      enrol: () => {
        guide = createEnrolGuide({
          // No name: the voice host's login is a machine account, and Tessaya keeps no display name for him.
          sentences: enrolScript(null),
          title: "Read these aloud",
          lead: `Stand where you usually talk to the ${DEVICE}, and use your normal voice. One sentence at a time, with a short pause between them.`,
          mic: `${DEVICE} (room mic)`,
          tip: "Enrol on the computer too, in Tessaya's Voice ID settings, for your desk mic.",
          otherVoiceBelow: CAMPLUS_POLICY.single.listen,
          strongFrom: CAMPLUS_POLICY.single.act + 0.15,
          // Its speech arrives at block RMS 30-600 over a room at about 3 (13 Nov); the SNR check still applies.
          floors: { speech: 30, quiet: 60 },
        });
        forEnrol = true;
        cardWords = { take: 0, prefix: "", turn: "", skip: 0, seen: 0 };
        card(true);
        speakNow(own("enrol.start", ENROL_INTRO));
      },
      cancelEnrol: () => {
        guide = null;
        if (forEnrol) stopAfterSaid();
      },
      /** Tessaya says this in the room now (an agent, a reminder or the Devices page), cutting off whatever she was saying. */
      /** A line in a session the R1 opened only for it: said, then that session ends. */
      sayOnly: (text: string, mood?: string | null, tone?: string | null) => {
        if (mood) face(mood);
        toneNow = tone ?? null;
        speakNow(text);
        stopAfterSaid();
      },
      /** What a reopened session goes on with: the conversation so far and the persona he was talking to. */
      kept: () => ({ history: [...history], persona: persona?.id ?? null }),
      carry: (k: { readonly history: typeof history; readonly persona: string | null }) => {
        history.push(...k.history.slice(-config.historyTurns * 2));
        const was = personas.find((p) => p.id === k.persona);
        if (was !== undefined) persona = was;
      },
      /** Back after the R1 rebooted mid-conversation: one short line, and the session stays open for him to go on. */
      restarted: () => speakNow(own("err.restart", "Sorry, I just restarted. Go on.")),
      /** `mood` is the eyes' look for her own words (the brain's expression); none keeps the eyes as they are. */
      say: (text: string, mood?: string | null, tone?: string | null) => {
        if (reply !== null) interrupt("a line of hers from the server");
        if (mood) face(mood);
        // Her server's tone for a line of her own (the pulse's welcome back): that tone of the clone, else plain.
        toneNow = tone ?? null;
        speakNow(text);
      },
      /** One of her cues on the downlink, paced like speech so the echo guard knows it; a second wake cue within 1.5 s is dropped. */
      cue: (name: PillSound) => {
        if (name === "wake" && deps.now() - lastWakeCue < 1_500) return;
        if (name === "wake") lastWakeCue = deps.now();
        void send(cueSamples(name), new AbortController().signal, () => undefined).catch(
          () => undefined,
        );
      },
      /** An R1 button: this persona (by name or id), else the next one, announced in the new voice. */
      switchTo: (name?: string) => {
        const wanted = name?.toLowerCase();
        const next =
          wanted === undefined
            ? personas[(personas.indexOf(persona!) + 1) % personas.length]
            : personas.find(
                (p) => p.name.toLowerCase() === wanted || p.id.toLowerCase() === wanted,
              );
        if (next === undefined) return;
        persona = next;
        look();
        openUntil = deps.now() + config.followMs;
        if (reply !== null) interrupt("the persona changed");
        speakNow(own("persona.switch", `${next.name} here.`, { persona: next.name }));
      },
      /** An R1 button's prompt: answered as if he had said it to her. */
      ask: (text: string) => void answer(new Int16Array(0), "button", deps.now(), deps.now(), text),
      /** What he asked in the same breath as her name, heard in her name's own segment: his first turn. */
      asked: (
        pcm: Int16Array,
        request: WakeRequest,
        voice?: Promise<SpeakerIdentity | undefined>,
      ) =>
        void answer(
          pcm,
          "wake",
          request.endedAt,
          request.startedAt,
          undefined,
          request.text,
          voice,
        ),
      /** He called this persona by name to wake her. */
      /** Her server holds an act until it knows who is speaking: she asks once, the reply decides (or S2). */
      stepUp: (act: string, shared: boolean, random: () => number = Math.random) => {
        const asked = stepUpFor(
          recog ?? accumulate(null, UNVERIFIED(deps.now()), 0, deps.now()),
          { shared },
          random,
        );
        recog = asked.session;
        heldAct = { act, step: asked.step, at: deps.now() };
        if (asked.step.kind === "none") return settleStepUp(true, "session");
        const line = stepUpWords(asked.step);
        if (line === null) return;
        deps.log(
          `[${id}] step-up for ${act}: asked${reply === null ? "" : " once her reply ends"}`,
        );
        askAfter = line;
        if (reply === null) askNow();
      },
      /** S2 on this R1: someone is at it, which proves presence for an act waiting on who is speaking. */
      present: () => settleStepUp(true, "button"),
      /** Her name's own clip, heard by Voice ID: the first evidence of who woke her. */
      /** Her name's own clip, for scoring with his first turn. */
      named: (clip: Int16Array) => {
        nameClip = clip;
      },
      heardName: (identity: SpeakerIdentity, ms: number, evidence: boolean) => {
        // A request in the same breath is scored once, as his turn, on this same clip.
        if (evidence) heldVoice(identity);
        hear(identity, ms);
      },
      /** Her server moved `personaId` onto this body: it answers from his next turn, never mid-sentence. */
      recast: (personaId: string) => {
        recastTo = personaId;
        if (reply === null) wearCast();
      },
      tentative: () => void (tentative = true),
      call: (name: string, level = Number.NEGATIVE_INFINITY) => {
        namedWake = true;
        if (Number.isFinite(level)) hisLevel = level;
        // Her name as heard, or the persona id a trained wake word belongs to.
        const named = personas.find((p) => p.name === name || p.id === name);
        if (named !== undefined && named !== persona) {
          persona = named;
          wear();
        }
      },
      /** The R1's own stop (S2 or a tap while she speaks): she stops, and a turn on its way is not answered. */
      stopReply: (src: string) => stopHer(`[${id}] stop from the ${DEVICE} (${src})`),
      /** S2 or the R1's own wake: he is talking to her now. */
      /** `ack` false: the window only, no sound (the R1 back on the link refuses audio outside a session, 14 Nov). */
      wake: (ack = true) => {
        opened = true;
        openUntil = Math.max(openUntil, deps.now() + config.followMs);
        firstUntil = deps.now() + config.firstTurnMs;
        if (!ack) return;
        // Nothing said within 1.2 s of her name or S2: she shows she heard (13 Nov: the red light, then silence).
        const seq = starts;
        const at = deps.now();
        if (deps.now() - ackScheduledAt < 1_500) return;
        ackScheduledAt = at;
        void deps.sleep(1_200).then(() => {
          if (closed || starts !== seq || turns.inTurn() || speaking() || reply !== null) return;
          acknowledge();
        });
        prerenderAcks();
        deps.lines?.prime(persona?.id ?? "", recog?.member ?? undefined);
        prerenderOwn();
      },
      /** Once a second: past the window she rests (sleepy eyes, name only); long quiet ends the session. */
      tick: (): "stop" | null => {
        if (heldAct !== null && deps.now() - heldAct.at > 60_000) settleStepUp(false, "no answer");
        // His silence in listen mode ends the thought: the whole of it is one turn, heard as his last line's voice.
        if (listen !== null && !turns.inTurn()) {
          const ticked = listenStep(listen, { type: "tick", at: deps.now() }, listenConfig());
          if (ticked.out.kind !== "pass") {
            listen = ticked.state;
            if (ticked.out.kind !== "done") onListen(ticked.out, turnNo);
            else {
              deps.log(`[${id}] listen mode done (${ticked.out.why})`);
              openUntil = deps.now() + config.followMs;
              void answer(listenPcm, "listen", deps.now(), deps.now(), undefined, ticked.out.text);
            }
          }
        }
        // A quiet mic while she plays on Bluetooth is the radio A2DP shares, expected and never a dead output: the
        // firmware measures that itself (`event/bt/stall`). Moving her then split a reply across both (18 Nov).
        // Not while she plays: his headset's mic starved, or sending only silence, cannot hear him. Her own mic takes
        // over without a word; the server passes the headset's mic over for a while.
        const why =
          input !== "headset" || headsetPoorSaid || speaking()
            ? null
            : deps.now() - lastUpAt > HEADSET_STARVED_MS
              ? "starved"
              : headsetDeadSince !== null && deps.now() - headsetDeadSince > HEADSET_DEAD_MS
                ? "silent"
                : null;
        if (why !== null) {
          headsetPoorSaid = true;
          deps.publish(topic(id, "event/audio/input"), JSON.stringify({ poor: true, why }));
          deps.log(`[${id}] the headset's mic is ${why}; her own mic hears him`);
        }
        const quiet = !turns.inTurn() && !speaking() && reply === null;
        // The persona he called holds for the whole session (13 Nov: Sebastian fell back within 14 s), or until he names another.
        if (quiet && !asleep && deps.now() > Math.max(openUntil, firstUntil)) {
          asleep = true;
          face("sleepy");
        }
        const idle = stray ? config.strayStopMs : config.idleStopMs;
        return quiet && deps.now() - lastActivity > idle ? "stop" : null;
      },
      stale: () => deps.now() - lastUpAt >= (heardUp ? STALE_SESSION_MS : START_GRACE_MS),
      rerouted,
      wear,
      /** For the replay harness: everything heard so far has been scored. */
      drained: () => chain,
      close: () => {
        closed = true;
        // only a session he talked in: a false wake for another persona with no turn hands nothing on
        if (persona !== undefined && history.length > 0)
          lastWore.set(id, { persona: persona.id, lead: lead?.id, at: lastExchangeAt });
        early?.control.abort();
        rec?.cancel();
        reply?.abort("the session closed");
      },
    };
  };

  const sessions = new Map<string, ReturnType<typeof openSession>>();
  /** What each R1 says it can do (`state/caps`, retained): the true flags, by name. */
  const capabilities = new Map<string, ReadonlyArray<string>>();
  /** His own pronunciations per R1, from her server (`voice/pronounce`, retained). */
  const pronunciations = new Map<string, Readonly<Record<string, string>>>();
  /** Voice ID's switches per R1, from her server (`voice/gate`, retained): the one record the desktop also sets. */
  const voiceIdGates = new Map<string, SpeakerGate>();
  /** Whether his turns are kept for his voice models per R1 (`voice/capture`, retained); on unless he turns it off. */
  const capturing = new Map<string, boolean>();
  /** Her breath between sentences per R1, from her server (`voice/breath`, retained); off until he turns it on. */
  const breathing = new Map<string, boolean>();
  /** Her last "I'm here" on each R1 and when, across its sessions. */
  const ackState = new Map<string, { line: string | null; at: number }>();
  /** Her "I'm here" lines, rendered per voice once for the loop's life (voice|line to audio). */
  const ackAudio = new Map<string, ReadonlyArray<Int16Array>>();
  const ackRendered = new Set<string>();
  /** Each R1's claim to the arbiter on its way: her voice waits for it, nothing else does. */
  const gates = new Map<string, Promise<boolean>>();
  const gateOf = (id: string) => gates.get(id) ?? Promise.resolve(true);
  /** One claim: true when this R1 answers (or the arbiter cannot be asked), false when another device does. */
  const claimFor = (
    arbiter: NonNullable<RoomDeps["arbiter"]>,
    claim: Parameters<NonNullable<RoomDeps["arbiter"]>["claim"]>[0],
    who: string,
  ): Promise<boolean> =>
    arbiter
      .claim(claim)
      .catch(() => null)
      .then((verdict) => {
        if (verdict?.conversation !== undefined)
          conversationOf.set(claim.deviceId, verdict.conversation);
        if (verdict === null || verdict.answer) return true;
        quietUntil.set(claim.deviceId, verdict.until ?? deps.now() + 20_000);
        deps.log(`${who}: ${verdict.winner ?? "another device"} answers; this R1 stays quiet`);
        return false;
      });
  /** Each member's own defaults from her server (`voice/prefs/<member>`, retained): persona and voice. */
  const prefsOf = new Map<
    string,
    {
      readonly persona?: string;
      readonly voice?: string;
      readonly listenWait?: string;
      readonly listenEnds?: string;
    }
  >();
  /** Who each member last talked to on any vessel, from her server (`voice/current/<member>`), and when it said so. */
  const currentOf = new Map<string, { readonly persona: string; readonly at: number }>();
  /**
   * Who each R1 wears, from her server's Cast (`voice/cast`, retained): its sessions open on that persona, and `follows`
   * (null: no rule, so config.personaFollows) says whether a member's session moves to whom they last talked to.
   */
  const castOf = new Map<
    string,
    { readonly persona: string | null; readonly follows: boolean | null }
  >();
  /** The household's languages per R1, from her server (`voice/languages`, retained). */
  const languagesOf = new Map<string, ReadonlyArray<string>>();
  /** The conversation the arbiter last named for each R1 (sent on its turns). */
  const conversationOf = new Map<string, string>();
  /** Until when another device of his answers (the arbiter's `until`, epoch ms): this R1 stays quiet. */
  const quietUntil = new Map<string, number>();
  /** Per R1, when his voice was last verified on her own mic: a headset turn soon after is taken as his to learn from. */
  const micVerifiedAt = new Map<string, number>();
  /** Until when her server's last eye mood holds on each R1 (`voice/intent/eye`): the loop's own moods wait. */
  const eyeHold = new Map<string, number>();
  /** The last `cmd/eye/set` each R1 was sent, and when: the same again is not sent until `EYE_RESEND_MS`. */
  const eyeShown = new Map<string, { readonly payload: string; readonly at: number }>();
  /** When each R1 last made each gesture: one nod per `GESTURE_GAP_MS`. */
  const gestureAt = new Map<string, number>();
  /** Her mood at rest on each R1 (`voice/intent/rest`, retained): the eyes and the prop over them between turns. */
  const restFace = new Map<string, { readonly mood: string; readonly accessory: string }>();
  /** The persona look each R1's eyes last showed or were asked for; unknown after a restart. */
  const worn = new Map<string, string>();
  /** Who each R1's last session ended on, under which lead (a changed cast starts over), and when. */
  const lastWore = new Map<
    string,
    { readonly persona: string; readonly lead: string | undefined; readonly at: number }
  >();
  /** When her loop last stopped each R1's session: the mic's tail after it opens nothing. */
  const stoppedAt = new Map<string, number>();
  /** A persona look sent to an R1 and not yet acknowledged on `state/eye/persona`. */
  const eyeAsked = new Map<
    string,
    { readonly name: string; readonly at: number; readonly tries?: number }
  >();
  /** R1s muted from Tessaya: their audio is dropped unheard until unmuted, across sessions. */
  const muted = new Set<string>();
  /** When her voice last went to each R1: a wake segment starting soon after can be her own words ringing. */
  const herVoice = new Map<string, number>();
  /** Where each R1's replies play now ("bt" or "onboard"): a change while she speaks restarts her sentence there. */
  const playsOn = new Map<string, string>();
  const playsNow = (id: string, out: string, why: string) => {
    const was = playsOn.get(id);
    playsOn.set(id, out);
    if (was !== undefined && was !== out) sessions.get(id)?.rerouted(why);
  };
  /** Each Tessel's volume as it last reported it (`state/volume`), sent with each turn. */
  const volumeOn = new Map<string, number>();
  /** R1s with her listening and closing sounds off (`cmd/voice/earcons {"on":false}`, retained); on by default. */
  const noCues = new Set<string>();
  /** R1s switched between keyword and open talk-over (`cmd/voice/talkover {"mode"}`, retained); else the config's. */
  const talkOverFor = new Map<string, RoomConfig["talkOver"]>();
  const open = (id: string) => (talkOverFor.get(id) ?? config.talkOver) === "open";
  const talks = new Map<string, TalkOver>();
  const talkOf = (id: string) => {
    const known = talks.get(id);
    if (known !== undefined) return known;
    const made = createTalkOver({ searchMs: 96 });
    talks.set(id, made);
    return made;
  };
  /** R1s on a bench (`cmd/voice/no-reply`, retained): what they hear is judged and logged, never answered. */
  const bench = new Map<string, { readonly keep: boolean }>();
  /** No sound of hers: earcons switched off, or a bench sweep, which is never answered aloud either. */
  const silent = (id: string) => noCues.has(id) || bench.has(id);
  const cue = (id: string, name: PillSound) => {
    if (!silent(id)) sessions.get(id)?.cue(name);
  };
  /** What waits on the session an R1 was asked to open (`cmd/voice/start`): his read or her question needs its mic. */
  const onStart = new Map<string, (s: ReturnType<typeof openSession>) => void>();
  // A session opened here alone hears nothing: the R1 sends mic audio only in its own session, and its wake stream closes ours as stale (13 Nov).
  const startOnR1 = (id: string, then: (s: ReturnType<typeof openSession>) => void) => {
    onStart.set(id, then);
    deps.publish(topic(id, "cmd/voice/start"), "{}");
  };
  /** Who woke an R1 by name, until its session starts. */
  const calledBy = new Map<
    string,
    {
      readonly word: string;
      readonly level: number;
      /** Voice ID on her name's own clip, and how long it was. */
      readonly heard?: Promise<SpeakerIdentity | undefined>;
      readonly ms: number;
      readonly clip?: Int16Array;
      /** What he said after her name in the same breath, still being recognised, with the segment it is in. */
      readonly request?: { readonly pcm: Int16Array; readonly words: Promise<WakeRequest | null> };
      readonly tentative?: boolean;
    }
  >();
  /** `wear` false: the caller names the persona first, then wears it, so the lead's eyes never flash between. */
  const start = (id: string, how = "audio", wear = true) => {
    stoppedAt.delete(id);
    sessions.get(id)?.close();
    const s = openSession(id, how === "audio");
    sessions.set(id, s);
    if (wear) s.wear();
    deps.warm?.();
    deps.link?.();
    deps.log(`[${id}] session open (${how})`);
    return s;
  };
  const stop = (id: string) => {
    sessions.get(id)?.close();
    sessions.delete(id);
  };

  const rearm = async (id: string) => {
    let waited = 0;
    for (const at of REARM_AT_MS) {
      await deps.sleep(at - waited);
      waited = at;
      deps.publish(topic(id, "cmd/voice/mode"), JSON.stringify({ mode: "inhouse" }));
    }
  };

  return {
    /** Her server's roster changed: every session opened from now on uses it. */
    /** When her voice last went to this R1 (ambient presence skips her own words); null when not lately. */
    herVoiceAt: (id: string): number | null => herVoice.get(id) ?? null,
    personas: (next: ReadonlyArray<RoomPersona>) => {
      if (next.length > 0) roster = next;
    },
    /** One MQTT message from the broker. */
    message: (t: string, payload: Uint8Array) => {
      const m = /^freya\/r1\/([^/]+)\/(.+)$/.exec(t);
      if (m === null) return;
      const [, id, tail] = m as unknown as [string, string, string];
      const json = () => {
        try {
          return JSON.parse(String(payload)) as Record<string, unknown>;
        } catch {
          return {};
        }
      };
      // `{"minutes": 120}` or `{"off": true}`: the test lane's switch, on this host's broker only.
      if (tail === "voice/testmode") {
        const body = json();
        const minutes = body["off"] === true ? null : Number(body["minutes"] ?? 0);
        setTestMode(id, minutes, "command");
        return;
      }
      if (tail.startsWith("cmd/eye/") || tail.startsWith("state/eye/")) {
        // Every eye command, the loop's or the server's, and every acknowledgement, so a look can be proved on his R1.
        const body = String(payload).slice(0, 120);
        // The server's own (the loop's are logged as sent; a broker that echoes them shows them here too).
        if (tail === "cmd/eye/persona" && !eyeAsked.has(id))
          eyeAsked.set(id, { name: String(json()["name"]), at: deps.now() });
        if (tail === "cmd/eye/persona" || tail === "state/eye/persona")
          worn.set(id, String(json()["name"]));
        // Another writer, or the Tessel itself, changed the face: the next mood is sent whatever it is.
        if (
          (tail === "cmd/eye/set" || tail === "state/eye/mood") &&
          json()["mood"] !== eyeMood(eyeShown.get(id)?.payload)
        )
          eyeShown.delete(id);
        if (tail === "state/eye/persona") {
          const asked = eyeAsked.get(id);
          eyeAsked.delete(id);
          deps.log(
            `[${id}] eye ack persona ${body}${asked === undefined ? "" : ` after ${Math.round(deps.now() - asked.at)} ms`}`,
          );
        } else deps.log(`[${id}] eye seen ${tail} ${body}`);
        return;
      }
      if (tail === "cmd/voice/no-reply") {
        const on = json()["on"];
        if (on === false || String(payload).trim() === "") bench.delete(id);
        else bench.set(id, { keep: json()["keep"] === true });
        deps.log(
          `[${id}] bench mark ${bench.has(id) ? `on${bench.get(id)!.keep ? ", keeping turns" : ""}` : "off"}`,
        );
        return;
      }
      if (tail === "state/caps") {
        capabilities.set(
          id,
          Object.entries(json())
            .filter(([, v]) => v === true)
            .map(([k]) => k),
        );
        return;
      }
      if (tail === "voice/intent/eye") {
        // Her server's mood for the eyes, through the loop, so the R1 has one writer (13 Nov: 40 of 155 refused while
        // the server held "thinking" over the loop's own moods). While its hold lasts, the loop's own moods wait.
        const { mood: said, holdMs, reason } = json();
        // One mood vocabulary: a clip, or a face-library mood shown as its clip; anything else never reaches the eyes.
        const mood = typeof said === "string" ? eyeClipOf(said) : null;
        if (mood !== null) {
          const hold = typeof holdMs === "number" && holdMs > 0 ? Math.min(holdMs, 30_000) : 0;
          eyeHold.set(id, deps.now() + hold);
          deps.log(
            `[${id}] eye intent ${mood} for ${hold} ms${typeof reason === "string" ? ` (${reason.slice(0, 40)})` : ""}`,
          );
          eyeShown.set(id, { payload: JSON.stringify({ mood }), at: deps.now() });
          deps.publish(topic(id, "cmd/eye/set"), JSON.stringify({ mood }));
        }
        return;
      }
      if (tail === "voice/intent/rest") {
        const { mood: said, accessory, persona: whose } = json();
        const mood = typeof said === "string" ? eyeClipOf(said) : null;
        if (mood === null || mood === "neutral") restFace.delete(id);
        else
          restFace.set(id, {
            mood,
            accessory:
              typeof accessory === "string" && /^[a-z]{2,12}$/.test(accessory) ? accessory : "auto",
          });
        deps.log(
          `[${id}] rest mood ${mood ?? "neutral"}${typeof whose === "string" ? ` (${whose.slice(0, 40)})` : ""}`,
        );
        // Shown now unless a reply's mood still holds; then the next rest moment shows it.
        if (deps.now() >= (eyeHold.get(id) ?? 0)) {
          const payload = JSON.stringify(
            restFace.get(id) ?? { mood: "neutral", accessory: "auto" },
          );
          eyeShown.set(id, { payload, at: deps.now() });
          deps.publish(topic(id, "cmd/eye/set"), payload);
        }
        return;
      }
      if (tail === "voice/languages") {
        const list = json()["languages"];
        if (
          Array.isArray(list) &&
          list.every((l) => typeof l === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(l))
        )
          languagesOf.set(id, list as ReadonlyArray<string>);
        else languagesOf.delete(id);
        deps.log(`[${id}] languages: ${(languagesOf.get(id) ?? config.languages).join(", ")}`);
        return;
      }
      if (tail === "voice/cast") {
        const { persona: p, follows: f } = json();
        const was = castOf.get(id)?.persona ?? null;
        const now = typeof p === "string" && /^[\w-]{1,40}$/.test(p) ? p : null;
        castOf.set(id, { persona: now, follows: typeof f === "boolean" ? f : null });
        // A change while he talks to it reaches the open session: "Alfred has it from here" was said and not worn (18 Nov).
        if (now !== null && now !== was) sessions.get(id)?.recast(now);
        return;
      }
      if (tail.startsWith("voice/current/")) {
        const member = tail.slice("voice/current/".length);
        const { persona: p } = json();
        if (
          member !== "" &&
          !member.includes("/") &&
          typeof p === "string" &&
          /^[\w-]{1,40}$/.test(p)
        )
          currentOf.set(member, { persona: p, at: deps.now() });
        return;
      }
      if (tail.startsWith("voice/prefs/")) {
        const member = tail.slice("voice/prefs/".length);
        const body = String(payload).trim();
        if (member === "" || member.includes("/")) return;
        if (body === "") prefsOf.delete(member);
        else {
          const { persona: p, voice: v, listenWait: w, listenEnds: e } = json();
          prefsOf.set(member, {
            ...(typeof p === "string" && /^[\w-]{1,40}$/.test(p) ? { persona: p } : {}),
            ...(typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? { voice: v } : {}),
            ...(typeof w === "string" ? { listenWait: w.slice(0, 40) } : {}),
            ...(typeof e === "string" ? { listenEnds: e.slice(0, 200) } : {}),
          });
        }
        return;
      }
      if (tail === "voice/stepup") {
        // Her server holds an act until it knows who is speaking (recognition step-up).
        const { act, shared } = json();
        if (typeof act === "string" && act !== "" && act.length <= 80)
          (sessions.get(id) ?? start(id)).stepUp(act, shared !== false);
        return;
      }
      if (tail === "voice/forget") {
        // A member's data destroyed in his household (the identity lane): their voice profile here goes with it.
        const personId = json()["personId"];
        if (typeof personId === "string" && personId !== "" && personId.length <= 80) {
          deps.forget?.(personId);
          deps.log(`[${id}] voice profile removed for a member whose data was destroyed`);
        }
        return;
      }
      if (tail === "voice/pronounce") {
        try {
          pronunciations.set(id, pronounceFrom(JSON.parse(String(payload))));
        } catch {
          pronunciations.delete(id);
        }
        deps.log(
          `[${id}] pronunciations: ${pronunciations.get(id) === undefined ? 0 : Object.keys(pronunciations.get(id)!).length}`,
        );
        return;
      }
      if (tail === "voice/capture") {
        capturing.set(id, json()["on"] !== false);
        deps.log(
          `[${id}] keeping his turns for his voice: ${capturing.get(id) === false ? "off" : "on"}`,
        );
        return;
      }
      if (tail === "voice/breath") {
        breathing.set(id, json()["on"] === true);
        deps.log(`[${id}] breath between sentences: ${breathing.get(id) === true ? "on" : "off"}`);
        return;
      }
      if (tail === "voice/gate") {
        const gate = gateFrom(payload);
        if (gate === null) voiceIdGates.delete(id);
        else voiceIdGates.set(id, gate);
        deps.log(`[${id}] voice id gate: ${gate === null ? "loop default" : JSON.stringify(gate)}`);
        return;
      }
      if (tail === "voice/up" || tail === "voice/up/tainted") {
        const stopped = stoppedAt.get(id);
        // The R1 sends for a few seconds after her stop (20 Nov 13:27: 6 s); that tail is not him opening a session.
        if (!sessions.has(id) && stopped !== undefined && deps.now() - stopped < STOP_TAIL_MS)
          return;
        if (!muted.has(id))
          (sessions.get(id) ?? start(id)).frame(payload, tail === "voice/up/tainted");
      } else if (tail === "voice/ctl") {
        // The R1 hears "flush" on the same topic; only mute and unmute are for the loop.
        const ev = json()["ev"];
        if (ev === "mute") {
          muted.add(id);
          stop(id);
        } else if (ev === "unmute") muted.delete(id);
      } else if (tail === "state/mic") {
        // His mute on the R1 (S1 long press or a command, firmware 3.32): it drops every mic frame, so nothing is heard.
        const { muted: m, src } = json();
        if (m === true) {
          muted.add(id);
          stop(id);
        } else if (m === false && src !== "boot") muted.delete(id); // a reboot must not undo a mute set from the app
      } else if (tail === "state/voice" && json()["ev"] === "ptt_end") {
        void sessions.get(id)?.released();
      } else if (tail === "state/voice" && ["start", "out"].includes(String(json()["ev"]))) {
        const out = json()["out"] === "bt" ? "bt" : "onboard";
        // A new session starts where it starts; only a move within one is a change mid-reply.
        if (json()["ev"] === "start") playsOn.set(id, out);
        else playsNow(id, out, out === "bt" ? "Bluetooth" : `the ${DEVICE}'s speaker`);
      } else if (tail === "state/volume") {
        const pct = json()["pct"];
        if (typeof pct === "number" && pct >= 0 && pct <= 100) volumeOn.set(id, Math.round(pct));
      } else if (tail === "state/audio/output" && typeof json()["out"] === "string") {
        const out = json()["out"] === "onboard" ? "onboard" : "bt";
        playsNow(id, out, out === "bt" ? "Bluetooth" : `the ${DEVICE}'s speaker`);
      } else if (tail === "event/bt/stall" && json()["lost"] === true) {
        // The firmware measured his headphones refusing her audio: it moves her to its speaker.
        playsNow(id, "onboard", `the ${DEVICE}'s speaker (the headphones stopped taking audio)`);
      } else if (tail === "event/key") {
        // Presses the device left to us (did "none"); none has a meaning yet, so they are only logged.
        const k = json();
        if (k["did"] === "none") deps.log(`[${id}] key ${String(k["key"])} ${String(k["act"])}`);
      } else if (tail === "voice/say") {
        const text = json()["text"];
        if (typeof text === "string" && text.trim() !== "") {
          const open = sessions.get(id);
          const mood = eyeClipOf(String(json()["mood"] ?? ""));
          const tone = typeof json()["tone"] === "string" ? String(json()["tone"]) : null;
          // The R1 plays her voice only inside its own session (r1bt_voice_play drops it otherwise, 13 Nov).
          if (open !== undefined) open.say(text.trim().slice(0, 500), mood, tone);
          else startOnR1(id, (s) => s.sayOnly(text.trim().slice(0, 500), mood, tone));
        }
      } else if (tail === "voice/persona") {
        const name = json()["name"];
        if (!muted.has(id)) {
          const open = sessions.get(id);
          const as = typeof name === "string" ? name : undefined;
          if (open !== undefined) open.switchTo(as);
          else startOnR1(id, (s) => s.switchTo(as));
        }
      } else if (tail === "voice/ask") {
        const text = json()["text"];
        if (typeof text === "string" && text.trim() !== "" && !muted.has(id)) {
          const open = sessions.get(id);
          if (open !== undefined) open.ask(text.trim().slice(0, 400));
          else startOnR1(id, (s) => s.ask(text.trim().slice(0, 400)));
        }
      } else if (tail === "cmd/voice/start") {
        // S2 (not her name) proves someone is at this R1, for an act already waiting on who is speaking.
        if (!calledBy.has(id)) sessions.get(id)?.present();
        const s = start(id, "S2 or wake", false);
        const called = calledBy.get(id);
        calledBy.delete(id);
        // Her name and a request in one breath: the request is his first turn, so no "I'm here" waits on it.
        const request = called?.request;
        if (request === undefined) s.wake();
        else {
          s.wake(false);
          void request.words.then((r) =>
            r === null ? s.wake() : s.asked(request.pcm, r, called?.heard),
          );
        }
        // S2 on this R1 (not her name): he chose this one, so the others yield to it.
        if (called === undefined) {
          quietUntil.delete(id);
          gates.delete(id);
          void deps.arbiter
            ?.claim({ deviceId: id, wakeScore: 1, loudnessDb: null, answerHere: true })
            .catch(() => null);
        }
        if (called !== undefined) {
          if (called.tentative === true) s.tentative();
          s.call(called.word, called.level);
          if (called.clip !== undefined && request === undefined) s.named(called.clip);
          void called.heard?.then(
            (who) => who !== undefined && s.heardName(who, called.ms, request === undefined),
          );
        } else s.present();
        cue(id, "wake");
        const then = onStart.get(id);
        onStart.delete(id);
        then?.(s);
        s.wear();
      } else if (tail === "voice/wake") {
        // The R1 sends its wake stream only between sessions (SMP 0.3.35): a session still open here is a stale one,
        // left by a reboot or a stop we missed, and must not keep her name from being heard.
        // Right after a wake the rest of that segment is still on its way, and the R1 has not yet heard the start:
        // that session is new, not stale (03:30 replay, 13 Nov: every wake closed its own session 60 ms later).
        const open = sessions.get(id);
        if (open !== undefined) {
          if (!open.stale()) return;
          deps.log(`[${id}] wake stream while a session was open here; closing it`);
          stop(id);
        }
        if (!muted.has(id)) deps.wake?.frame(id, payload);
      } else if (tail === "event/wake/boot") {
        // A reboot ends the R1's own session: one he was in reopens with a short line, never silence until he calls her
        // again (18 Nov, 00:21: her watchdog rebooted her mid-answer and the loop waited 47 s on a dead session).
        // Every boot is one line, so the dev-feed watch sees reboots and why (18 Nov 03:45: a reboot with no why).
        const b = json();
        const show = (k: string) => JSON.stringify(b[k] ?? null);
        deps.log(
          `[${id}] booted: fw_ver ${show("fw_ver")} reason ${show("reason")} why ${show("why")} uptime_s ${show("uptime_s")} kept ${show("kept")}`,
        );
        const open = sessions.get(id);
        if (open === undefined) return;
        // The conversation and who he was talking to go on: "what were we talking about?" had lost both (18 Nov, 05:51).
        const kept = open.kept();
        stop(id);
        deps.log(`[${id}] rebooted mid-session; reopening it`);
        if (!muted.has(id) && !silent(id))
          startOnR1(id, (s) => {
            s.carry(kept);
            s.restarted();
          });
      } else if (tail === "voice/wake/end") {
        const { seg, sent } = json();
        deps.wake?.end(
          id,
          typeof seg === "number" ? seg : undefined,
          typeof sent === "number" ? sent : undefined,
        );
      } else if (tail === "event/wake/kws") {
        deps.wake?.kws?.(id, json() as KwsEvent);
      } else if (tail === "cmd/voice/stop") {
        stop(id);
        stoppedAt.set(id, deps.now());
      } else if (tail === "event/voice/interrupt" || tail === "event/voice/stop") {
        const src = json()["src"];
        sessions.get(id)?.stopReply(typeof src === "string" ? src.slice(0, 20) : "button");
      } else if (tail === "event/voice/flush")
        deps.log(`[${id}] the R1 flushed: ${String(payload).slice(0, 80)}`);
      else if (tail === "event/session/start" || tail === "event/wake") {
        stoppedAt.delete(id);
        sessions.get(id)?.wake();
        cue(id, "wake");
      } else if (
        tail === "event/session/end" ||
        (tail === "state/voice" && ["stop", "end"].includes(String(json()["ev"])))
      ) {
        // The R1 closed its own session: it refuses audio now ("no session"), so no closing sound is sent (14 Nov, 20:20).
        const s = sessions.get(id);
        if (s === undefined) return;
        sessions.delete(id);
        s.close();
      } else if (tail === "cmd/voice/talkover") {
        const mode = json()["mode"];
        if (mode === "open" || mode === "keyword") talkOverFor.set(id, mode);
        else talkOverFor.delete(id);
        deps.log(`[${id}] talking over her: ${open(id) ? "open" : "keyword"}`);
      } else if (tail === "cmd/voice/earcons") {
        if (json()["on"] === false) noCues.add(id);
        else noCues.delete(id);
      } else if (tail === "voice/enrol") {
        if (json()["cancel"] === true) {
          onStart.delete(id);
          sessions.get(id)?.cancelEnrol();
        } else startOnR1(id, (s) => s.enrol());
      } else if (tail === "state/online" && String(payload).trim() === "1") {
        // Back on the link mid-session: he was talking to her, so the window opens again rather than lapsing (00:43, 13 Nov).
        sessions.get(id)?.wake(false);
        if (config.inhouse.has(id)) void rearm(id);
      }
    },
    /** Ends sessions nobody has spoken in; the R1 hears its own stop and plays the exit chime. */
    sweep: () => {
      // A persona look is confirmed: asked again until the R1 acknowledges it, then a real failure in the log.
      for (const [id, asked] of eyeAsked)
        if (deps.now() - asked.at > 3_000) {
          const tries = (asked.tries ?? 1) + 1;
          if (tries > EYE_PERSONA_TRIES) {
            eyeAsked.delete(id);
            deps.log(
              `[${id}] eye persona ${asked.name}: FAILED, no acknowledgement after ${EYE_PERSONA_TRIES} tries`,
            );
            continue;
          }
          eyeAsked.set(id, { name: asked.name, at: deps.now(), tries });
          deps.log(`[${id}] eye persona ${asked.name}: no acknowledgement in 3 s, try ${tries}`);
          deps.publish(topic(id, "cmd/eye/persona"), JSON.stringify({ name: asked.name }));
        }
      for (const [id, s] of sessions)
        if (s.tick() === "stop") {
          // Her closing sound plays out before the R1 is told to stop (it no longer says "Bye bye" itself).
          const closing = silent(id) ? 0 : soundMs("end") + config.downDelayMs;
          cue(id, "end");
          sessions.delete(id);
          void deps.sleep(closing).then(() => {
            deps.publish(topic(id, "cmd/voice/stop"), "{}");
            s.close();
          });
        }
    },
    session: (id: string) => sessions.get(id),
    /** Until when test mode trusts the test clone (0: off), for the Voice ID scorer. */
    testUntil: () => testUntil,
    /** The wake check heard `word`: the R1 starts its session (its echo opens ours) with that persona answering. */
    woken: (
      id: string,
      word: string,
      level = Number.NEGATIVE_INFINITY,
      score = 1,
      /** Her name as heard, for Voice ID on the claim. */
      clip?: Int16Array,
      /** What he said after her name in the same segment (`clip`), still being recognised. */
      request?: Promise<WakeRequest | null>,
      /** Voice ID on `clip`, begun when the segment ended (the wake stream's); else begun here. */
      voice?: Promise<SpeakerIdentity | undefined>,
      /** Woken on the name model's score alone: the first turn must be a fresh request to her (M-144). */
      tentative = false,
    ) => {
      if (sessions.has(id)) return;
      if (deps.now() < (quietUntil.get(id) ?? 0)) {
        deps.log(`[${id}] her name while another device answers: taken as her voice from there`);
        return;
      }
      // One embedding of her name's segment serves the claim, her recognition cue and the request said with it.
      const heard =
        clip === undefined || deps.speaker === undefined
          ? undefined
          : (voice ?? deps.speaker(clip)).catch(() => undefined);
      const open = () => {
        calledBy.set(id, {
          word,
          level,
          ms: clip === undefined ? 0 : (clip.length / RATE) * 1000,
          ...(clip === undefined ? {} : { clip }),
          ...(request === undefined || clip === undefined
            ? {}
            : { request: { pcm: clip, words: request } }),
          ...(heard === undefined ? {} : { heard }),
          tentative,
        });
        deps.publish(topic(id, "cmd/voice/start"), "{}");
      };
      if (deps.arbiter === undefined) return open();
      const arbiter = deps.arbiter;
      // Listening starts now; the arbiter answers alongside, and a lost claim closes this R1's session.
      const gate = (heard ?? Promise.resolve(undefined)).then((heardBy) =>
        claimFor(
          arbiter,
          {
            deviceId: id,
            wakeScore: Math.min(1, Math.max(0, score)),
            loudnessDb: Number.isFinite(level) ? level : null,
            ...(heardBy === undefined
              ? {}
              : { speaker: { personId: heardBy.personId, verified: heardBy.verified } }),
          },
          `[${id}] her name`,
        ),
      );
      open();
      gates.set(id, gate);
      void gate.then((answers) => {
        if (answers) return;
        deps.publish(topic(id, "cmd/voice/stop"), "{}");
        stop(id);
      });
    },
    close: () => {
      for (const id of Array.from(sessions.keys())) stop(id);
    },
  };
};
