/**
 * Tessaya in a room: the R1's in-house voice loop (agro-aiot Docs/136's gateway, folded into Tessaya). It hears
 * `voice/up`, asks her server, speaks on `voice/down` and stops when he cuts in. I/O is passed in for tests.
 * @module baton-voice/room/roomVoice
 */
import { r1MoodOf, type LineEvent } from "@t3tools/baton-shared/expression";
import { mostlyForeign } from "@t3tools/baton-shared/language";
import { isNarration, withoutSelfIntro } from "@t3tools/baton-shared/narration";
import { DEFAULT_OS_PACK } from "@t3tools/baton-shared/osPack";
import { pronounce, pronounceFrom } from "@t3tools/baton-shared/pronounce";
import { stopIntent } from "@t3tools/baton-shared/stopPhrases";

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
import { addressedInRoom, beganOverHer, echoVerdict, type Playback } from "../turnRules.ts";
import {
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
  memberByVoice,
  UNVERIFIED,
  type SpeakerGate,
  type SpeakerIdentity,
} from "../speaker.ts";
import { DOWN_FRAME_BYTES, fromBytes, speechLevel, toBytes } from "./audio.ts";
import { PILL_SOUNDS, renderSound, soundMs, type PillSound } from "../cueSounds.ts";
import type { Affect } from "./senseVoice.ts";
import type { KwsEvent } from "./wakeStream.ts";
import { segmentsOf, type TurnVoices } from "./segments.ts";
import {
  createTurnTaking,
  ROOM_TURN,
  WINDOW,
  type TurnAction,
  type TurnConfig,
} from "./turnTaking.ts";

const RATE = 16_000;
/** Her downlink kept for open talk-over: 8 s, far more than the R1 ever holds unplayed. */
const DOWN_RING = RATE * 8;
/** firmware 0.3.92 `cmd/voice/upformat {"v":1}`: each uplink frame leads with seq, rx, q (u32) and flags (u16), 16 bytes. */
const UP_HEADER = 16;
/** The R1's own latency on its onboard speaker (firmware lane, 14 Nov): her sample under it is rx - q - this. */
const R1_LATENCY = 1972;
/** Talking over her counts once she has sounded this long: the device's echo cancelling settles in that time. */
const ONSET_GRACE_MS = 400;
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

export interface RoomPersona {
  readonly id: string;
  /** What he calls it by. */
  readonly name: string;
  readonly voice: string;
  /** The look she gives when she first recognises him this session; "happy" when the persona has none. */
  readonly cueMood?: string;
  /** Its look on the R1's eyes (`cmd/eye/persona`); without one, the generic look. */
  readonly eyes?: string;
}

/** What a body needs of a persona record, from her server's roster or the default pack. */
export interface ServedPersona {
  readonly id: string;
  readonly name: string;
  readonly wake: string | null;
  readonly voice: string;
  readonly lead: boolean;
  readonly eyes?: string;
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
    return [
      {
        id,
        name,
        voice,
        wake: text(p["wake"]) ?? null,
        lead: p["lead"] === true,
        ...(eyes ? { eyes } : {}),
      },
    ];
  });
  return ok.length === 0 ? null : roomPersonas(ok);
};

/** The look a persona without its own shows on the R1. */
export const GENERIC_EYES = "generic";

export interface RecogniserTurn {
  readonly feed: (pcm: Int16Array) => void;
  /** The final text once the audio has ended. */
  readonly finish: () => Promise<string>;
  readonly cancel: () => void;
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
  readonly callId?: string;
  /** Several people this turn, in speaking order: each one's words with their own voice (absent for one voice). */
  readonly segments?: ReadonlyArray<{ readonly speaker: SpeakerIdentity; readonly words: string }>;
}

export interface RoomDeps {
  readonly publish: (topic: string, payload: Uint8Array | string) => void;
  /** A fresh Silero scorer per session (it is recurrent). */
  readonly vad: () => { readonly score: (window: Int16Array) => Promise<number> };
  readonly smartTurn: (pcm: Int16Array) => Promise<number>;
  readonly recognise: () => RecogniserTurn;
  /** A member's data was destroyed: his voice profile on this host goes too. */
  readonly forget?: (personId: string) => void;
  /** The words in a stretch of his audio on their own (a second, short recognition): for an early start at a pause. */
  readonly preview?: (pcm: Int16Array) => Promise<string>;
  /** A throwaway decode as a session opens: the first clip after a quiet spell is otherwise about 1.5 s slower. */
  readonly warm?: () => void;
  readonly speaker?: (pcm: Int16Array) => Promise<SpeakerIdentity>;
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
  readonly speak: (text: string, signal: AbortSignal, voice?: string) => AsyncIterable<Int16Array>;
  /** Optional enrolment: the owner profile from these 4 s windows of his speech, and what she says about it. */
  readonly enrolOwner?: (
    windows: ReadonlyArray<Int16Array>,
  ) => Promise<{ readonly saved: boolean; readonly said: string }>;
  /** His voice as a vector, so the enrolment card can tell another voice from his; without it that check is skipped. */
  readonly embed?: (pcm: Int16Array) => Promise<Float32Array | null>;
  /** How like the household's enrolled voices this is (best cosine over every profile); open talk-over needs it. */
  readonly member?: (pcm: Int16Array) => Promise<number>;
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
  /** A bench turn kept for a regression case (`cmd/voice/no-reply` with `keep`): never his, only while the bench asks. */
  readonly keep?: (turn: BenchTurn) => void;
  /** Her name with no session open (`voice/wake`): voiced segments only, never recognised beyond the wake check. */
  readonly wake?: {
    readonly frame: (deviceId: string, pcm: Uint8Array) => void;
    readonly end: (deviceId: string, seg?: number) => void;
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
  historyTurns: 6,
  inhouse: new Set(),
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  languages: ["en"],
  talkOver: "keyword",
  personaFollows: false,
};

const REARM_AT_MS = [2_000, 8_000, 18_000];
/** As long as her server holds a conversation (TessayaTurn's idle boundary). */
const CURRENT_HELD_MS = 10 * 60_000;
const onlyEnglish = (languages: ReadonlyArray<string>) =>
  languages.length > 0 && languages.every((l) => l.toLowerCase().split("-")[0] === "en");
/** A voice this much quieter than his name reached the R1 is the room, not him. */
const FAR_DB = 18;
/** A session that has had no mic audio for this long while wake audio arrives is one the R1 has already left. */
const STALE_SESSION_MS = 3_000;

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
  /** Cosine to his profile (null with no profile): how Voice ID is measured on his real room turns. */
  readonly speakerScore: number | null;
  readonly emotion: string;
  readonly bargedIn: boolean;
  /** Her brain started on the recogniser's partial words, and the final text matched them. */
  readonly speculative?: boolean;
}

/** The first clause of a reply still being written ("Yes, it's on…"): three words or more, then , ; : or a dash. */
export const firstClause = (
  text: string,
): { readonly head: string; readonly rest: string } | null => {
  const m = /^(\S+(?:\s+\S+){2,}?[,;:\u2014])\s+(?=\S)/.exec(text);
  return m === null ? null : { head: m[1]!, rest: text.slice(m[0].length) };
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

  const openSession = (id: string) => {
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
    let carry: { readonly text: string; readonly at: number; readonly since: number } | null = null;
    /** The turn being answered; a fragment of his that starts before she is heard is joined to it, not answered apart. */
    let current_: {
      readonly text: string;
      readonly endedAt: number;
      firstAt: number | null;
      readonly entry: { role: "user"; content: string };
      merged: boolean;
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
    /** Her last reply asked him something: a bare "yes" or "okay" is his answer, not the room's chatter. */
    let invited = false;
    /** S2, a wake or her name: his first turn after it is for her, however long he takes to start (00:20, 13 Nov). */
    let firstUntil = 0;
    /** When its mic last sent anything (or it opened): a session with nothing for a while is one the R1 has left. */
    let lastUpAt = deps.now();
    /** Her last few sentences, to tell her own voice coming back through the mic from his. */
    let herLines: string[] = [];
    const saying = (text: string) => {
      herLines = [...herLines, text].slice(-6);
    };
    let asleep = false;
    const personas = roster;
    const lead = personas[0];
    /** Who answers: the one he last called, until the window lapses. */
    let persona = lead;
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    const speaking = () => reply !== null || deps.now() < playUntil + config.downDelayMs;
    /** What the voice reads: his own pronunciations for this R1 (and the built-in ones), never the text kept. */
    const spoken = (text: string) => pronounce(text, pronunciations.get(id) ?? {});
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
          `[${id}] heard over her voice${verdict.during ? "" : "'s tail"}, taken as his (likeness ${verdict.likeness.toFixed(2)})`,
        );
      return verdict.hers;
    };

    /** Who she is talking to across this session (recognition.ts): built up turn by turn, reset by a mismatch. */
    let recog: RecognitionSession | null = null;
    /** Their name, for the next request only: the turn the session is first recognised (the cue). */
    let nameOnce: string | null = null;
    /** An act her server holds until it knows who is speaking (`voice/stepup`), and how she asked. */
    let heldAct: { readonly act: string; readonly step: StepUp; readonly at: number } | null = null;
    /** The member's own voice for her (their preference), once they are recognised, while the lead answers. */
    let memberVoice: string | null = null;
    let prefsFor: string | null = null;
    const voiceNow = () =>
      persona === lead && memberVoice !== null ? memberVoice : persona?.voice;
    /** A recognised member's own defaults: their persona unless he named another, and their voice for her. */
    const applyPrefs = () => {
      const member = recog?.verified === true ? recog.member : null;
      if (member === null || member === prefsFor) return;
      prefsFor = member;
      const prefs = prefsOf.get(member);
      memberVoice = prefs?.voice ?? null;
      const now = currentOf.get(member);
      const chosen =
        config.personaFollows && now !== undefined && deps.now() - now.at <= CURRENT_HELD_MS
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
      recog = accumulate(recog, identity, ms, deps.now());
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
      speaker,
      ...(affect === undefined
        ? {}
        : { emotion: { label: affect.emotion, events: affect.events } }),
      ...(segments === undefined ? {} : { segments }),
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
      const tessaya = envelopeOf(
        undefined,
        beganOverHer(turnStartedAt, playback()),
        words,
        who,
        who !== persona,
        via,
        UNVERIFIED(deps.now()),
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

    /** Sent away by voice: her reply flushed, any turn on its way cancelled, sleepy eyes and her closing sound, at once. */
    const dismissNow = (why: string) => {
      const at = deps.now();
      if (dismissedAt === at) return;
      dismissedAt = at;
      stops += 1;
      if (speaking()) interrupt();
      carry = null;
      openUntil = 0;
      firstUntil = 0;
      invited = false;
      asleep = true;
      sentAway = true;
      lastActivity = deps.now();
      face("sleepy");
      const closing = silent(id)
        ? Promise.resolve()
        : send(cueSamples("end"), new AbortController().signal, () => undefined).catch(
            () => undefined,
          );
      // Sent away ends the session: the R1 closes its mic and listens for her name again (14 Nov, mic stayed on).
      void closing
        .then(() => deps.sleep(Math.max(0, playUntil + config.downDelayMs - deps.now())))
        .then(() => {
          if (!closed && dismissedAt === at) deps.publish(topic(id, "cmd/voice/stop"), "{}");
        });
      deps.log(`${why}; she rests`);
    };
    /** Each stop of hers (his "stop", or the R1's S2 or tap): a turn heard before it is not answered after it. */
    let stops = 0;
    /** She stops now and listens: her reply flushed, any turn on its way cancelled, the window open for his next words. */
    const stopHer = (why: string) => {
      stops += 1;
      // Her whole reply may already be on the R1 (sent up to 0.7 s ahead): still audible is still flushed.
      if (speaking()) interrupt();
      openUntil = deps.now() + config.followMs;
      invited = false;
      face("neutral");
      deps.log(`${why}; she stopped`);
    };
    const interrupt = () => {
      releaseHold();
      reply?.abort();
      reply = null;
      playUntil = deps.now();
      // The R1 drops what it holds on a flush; only a Bluetooth speaker's own buffer still sounds after it.
      speechUntil = Math.min(speechUntil, playUntil - config.downDelayMs);
      deps.publish(topic(id, "voice/ctl"), JSON.stringify({ ev: "flush" }));
      echo.reset();
    };

    /**
     * She paused because a voice rose over hers (open talk-over): the R1's queue is flushed, her reply waits, and the
     * voice is checked against the household's. `from` is her sample under the speaker when she paused.
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
    /** The last 3.6 s of aligned mic frames, for the voice check while she is paused. */
    let heardLately: Array<{ readonly seq: number; readonly pcm: Int16Array }> = [];
    const releaseHold = () => {
      const h = hold;
      hold = null;
      h?.release();
    };
    /** Where each of her sentences began in the downlink: a long pause resumes from the start of the one it cut. */
    let phraseStarts: number[] = [];
    /** Her sample under the R1's speaker as of the latest aligned frame. */
    let underSpeaker = 0;

    /** Paced 60 ms publishes, at most `leadMs` ahead of what the R1 is playing. */
    const send = async (pcm: Int16Array, signal: AbortSignal, onFirst: () => void) => {
      const bytes = toBytes(pcm);
      for (let at = 0; at < bytes.length && !signal.aborted; at += DOWN_FRAME_BYTES) {
        for (let h = hold; h !== null && !signal.aborted; h = hold) await h.released;
        // Awaits only when ahead: a frame that may go now goes in this same tick.
        const wait = playUntil - deps.now() - config.leadMs;
        if (wait > 0) await deps.sleep(wait);
        if (signal.aborted) return;
        emit(bytes.subarray(at, at + DOWN_FRAME_BYTES));
        onFirst();
      }
    };
    const emit = (frame: Uint8Array) => {
      const start = Math.max(deps.now(), playUntil);
      if (start > playUntil) soundingFrom = start + config.downDelayMs;
      deps.publish(topic(id, "voice/down"), frame);
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
    ) => {
      let first = false;
      let held: Int16Array[] = [];
      let heldMs = 0;
      let marked = false;
      const out = async (pcm: Int16Array) => {
        if (!marked) {
          marked = true;
          phraseStarts = [...phraseStarts, downSamples].slice(-12);
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
    const say = (text: string, signal: AbortSignal, onFirstAudio?: () => void) =>
      play(deps.speak(spoken(text), signal, voiceNow()), signal, onFirstAudio, config.prerollMs);

    /** Starts her voice on `text` at once (after the sentence before it), buffering what it says for `play`. */
    let synthesis: Promise<void> = Promise.resolve();
    const ahead = (text: string, signal: AbortSignal): AsyncIterable<Int16Array> => {
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
          for await (const pcm of deps.speak(spoken(text), signal, voice)) {
            if (signal.aborted) break;
            chunks.push(pcm);
            nudge();
          }
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
      deps.log(`[${id}] eye sent ${tail} ${payload}`);
      if (tail === "cmd/eye/persona")
        eyeAsked.set(id, { name: body["name"] ?? "", at: deps.now() });
      deps.publish(topic(id, tail), payload);
    };
    // Sent away always shows at once; otherwise a mood of her server's that still holds is not overwritten.
    const face = (mood: string) => {
      if (mood !== "sleepy" && deps.now() < (eyeHold.get(id) ?? 0)) return;
      eye("cmd/eye/set", { mood });
    };
    const gesture = (name: string) => eye("cmd/eye/gesture", { name });
    /** The persona's own eyes (the eye lane's looks; firmware without them ignores the topic). */
    const look = () => eye("cmd/eye/persona", { name: persona?.eyes ?? GENERIC_EYES });
    /** Her own words for one of the loop's moments, her eyes showing its mood; `plain` while they are off. */
    const own = (event: LineEvent, plain: string, facts?: Readonly<Record<string, string>>) => {
      const said = deps.lines?.take(
        event,
        persona?.id ?? "",
        recog?.member ?? undefined,
        plain,
        facts,
      );
      const mood = said?.mood == null ? null : r1MoodOf(said.mood);
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
        for (const line of ackLines(persona?.id ?? "")) {
          const chunks: Int16Array[] = [];
          try {
            for await (const pcm of deps.speak(spoken(line), new AbortController().signal, voice))
              chunks.push(pcm);
            ackAudio.set(`${voice}|${line}`, chunks);
          } catch {
            // Not rendered: said live instead when it comes up.
          }
        }
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
        for (const line of next) {
          if (ackAudio.has(`${voice}|${line}`)) continue;
          const chunks: Int16Array[] = [];
          try {
            for await (const pcm of deps.speak(spoken(line), new AbortController().signal, voice))
              chunks.push(pcm);
            ackAudio.set(`${voice}|${line}`, chunks);
          } catch {
            // Not rendered: said live instead when it comes up.
          }
        }
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

    /** Said to her: she was named, or it began inside the window and is more than a stray "yeah" she did not ask for. */
    const addressed = (words: string, called: string | null, startedAt: number) =>
      addressedInRoom(words, called !== null, startedAt, { firstUntil, openUntil, invited });

    /** When the turn being heard began: the window is about when he started, not when recognition finished. */
    let turnStartedAt = 0;
    /** `given` is a turn already in words (an R1 button's prompt): addressed to her, with no voice to read. */
    const answer = async (
      pcm: Int16Array,
      reason: string,
      lastVoice: number,
      startedAt: number,
      given?: string,
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
      const envelope = (
        words: string,
        who: RoomPersona | undefined,
        switched: boolean,
        via: Tessaya["via"],
        speaker: SpeakerIdentity,
        affect: Affect | undefined,
        segments?: Tessaya["segments"],
      ) => envelopeOf(given, tainted, words, who, switched, via, speaker, affect, segments);
      const current = given === undefined ? rec : null;
      if (given === undefined) rec = null;
      const speakerP =
        given === undefined ? deps.speaker?.(pcm).catch(() => UNVERIFIED(deps.now())) : undefined;
      const affectP = given === undefined ? deps.affect?.(pcm).catch(() => undefined) : undefined;
      const voicesP = given === undefined ? deps.voices?.(pcm).catch(() => undefined) : undefined;
      let affectNow: Awaited<typeof affectP>;
      void affectP?.then((a) => (affectNow = a));
      const sides = Promise.all([speakerP, affectP]);
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
        if (!admits(identity, config.gate, "turn")) return null;
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
          dismissNow(`[${id}] turn ${turn}: dismissed (heard early)`);
        latest = words;
        tryGuess(words);
      });
      if (latest !== "") tryGuess(latest);
      const raw = (given ?? (await current?.finish().catch(() => "")) ?? "").trim();
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
            `[${id}] turn ${turn}: the R1 was muted or stopped; not answered (${heldBack(raw)})`,
          );
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
      const intent = raw === "" ? null : stopIntent(raw, config.stopPhrases);
      // Sent away: the session rests here and now, with no brain call and nothing joined to it (10:36-10:37, 13 Nov).
      if (given === undefined && !echoed && intent === "dismiss") {
        kept?.control.abort();
        dismissNow(`[${id}] turn ${turn}: dismissed`);
        return;
      }
      if (dismissedAt >= startedAt) {
        kept?.control.abort();
        return;
      }
      if (given === undefined && startedAt >= otherVoice.from && startedAt <= otherVoice.until) {
        kept?.control.abort();
        dropped(turn, "not a household voice over hers", raw);
        return;
      }
      if (over && raw !== "" && !echoed && intent === null && rawCalled === null) {
        kept?.control.abort();
        dropped(turn, "over her voice and not a stop", raw);
        return;
      }
      // He (or the R1's S2 or a tap) stopped her while this turn was on its way: it is not answered.
      if (stopsAt !== stops) {
        kept?.control.abort();
        return;
      }
      // "Stop" (not her name): she stops and listens for what he says next; nothing to answer.
      if (given === undefined && !echoed && intent === "stop" && rawCalled === null) {
        kept?.control.abort();
        // Nothing of hers to stop: his "stop" sends her away like a dismissal.
        if (!tainted && !speaking() && reply === null && cutByVoiceAt < startedAt)
          return dismissNow(`[${id}] turn ${turn}: he said stop with nothing to stop`);
        stopHer(`[${id}] turn ${turn}: he said stop`);
        return;
      }
      const mine =
        raw !== "" && !echoed && (given !== undefined || addressed(raw, rawCalled, startedAt));
      if (raw !== "" && !mine)
        dropped(
          turn,
          echoed ? `her own voice (likeness ${echoLike.toFixed(2)})` : "not said to her",
          raw,
        );
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
      if (held !== null && carry === held) {
        carry = null;
        text = `${held.text} ${text}`.trim();
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
      }
      if (text !== raw) {
        kept?.control.abort();
        kept = null;
      }
      // He stopped mid-sentence, or has already gone on: hold it for his next words.
      // Held at most 2.5 s from the first piece: a room that keeps talking is never one endless sentence (10:35, 13 Nov).
      const since = held?.since ?? deps.now();
      if (
        given === undefined &&
        (isUnfinished(text) || starts > seq) &&
        deps.now() - since < config.joinMs + 500
      ) {
        const hold = { text, at: deps.now(), since };
        carry = hold;
        kept?.control.abort();
        if (starts === seq) await deps.sleep(config.joinMs);
        if (carry !== hold || starts > seq) {
          deps.log(`[${id}] turn ${turn}: held for the rest of his sentence (${heldBack(text)})`);
          return;
        }
        carry = null;
      }
      const called = calledName(text, names);
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
      const dismissed = isDismissal(text) || stopIntent(text, config.stopPhrases) === "dismiss";
      // Her brain starts now, not after the speaker and mood readers: what they already know goes with it, and a voice
      // the gate keeps out is still never heard (her first sound waits for it, at most `sideMs`).
      const known = await Promise.race([sides, Promise.resolve(null)]);
      const [speaker, affect] = known ?? [undefined, affectNow];
      const identity = speaker ?? UNVERIFIED(deps.now());
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
        voices.kind === "many" && voices.spans.some((s) => admits(s.identity, config.gate, "turn"));
      const admitted: Promise<boolean> =
        known !== null || someoneAdmitted
          ? Promise.resolve(true)
          : Promise.race([
              sides.then(([late]) => late === undefined || admits(late, config.gate, "turn")),
              deps.sleep(config.sideMs).then(() => true),
            ]);
      if (!admits(identity, config.gate, "turn") && !someoneAdmitted) {
        kept?.control.abort();
        dropped(turn, `a ${identity.kind} voice`, text);
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
      const entry = { role: "user" as const, content: text };
      history.push(entry);
      const me = { text, endedAt: lastVoice, firstAt: null as number | null, entry, merged: false };
      current_ = me;
      // One reply at a time: two playing at once interleave their frames on the downlink, which sounds chopped.
      // Still audible counts too: her last reply may already be on the R1.
      if (reply !== null || speaking()) interrupt();
      const control = kept?.control ?? new AbortController();
      reply = control;
      let brainFirst: number | null = null;
      let ttsFirst: number | null = null;
      let firstSound: number | null = null;
      /** What she actually says: her reasoning, when the brain writes it out, is never spoken or kept (13 Nov). */
      let said = "";
      try {
        let buffer = "";
        let firstSentenceAt: number | null = null;
        let speakingChain = Promise.resolve();
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
          const preroll = firstSentenceAt === null ? config.prerollMs : 0;
          firstSentenceAt ??= deps.now();
          const audio = ahead(sentence, control.signal);
          speakingChain = speakingChain.then(async () =>
            // The arbiter is asked alongside, never before (13 Nov: a 1.3-1.7 s claim round in front of every wake);
            // only her voice waits for its answer, and a lost claim is never heard.
            !(await gateOf(id)) || !(await admitted) || control.signal.aborted
              ? control.abort()
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
                ),
          );
          // If the brain's stream fails first, the catch below skips `await speakingChain`: an abort must not crash us.
          speakingChain.catch(() => undefined);
        };
        const tessaya = envelope(text, persona, switched, via, identity, affect, segments);
        nameOnce = null;
        // His final words matched the guess and it is the one answered: the changes it held may now be made.
        if (kept !== null) deps.confirmed?.(kept.callId);
        const source =
          kept?.stream ??
          deps.brain(
            { deviceId: id, messages: history.slice(-config.historyTurns * 2), tessaya },
            control.signal,
          );
        for await (const delta of source) {
          brainFirst ??= deps.now() - textAt;
          buffer += delta;
          const { done, rest } = splitSentences(buffer);
          buffer = rest;
          done.forEach(enqueue);
          // Her first words go to her voice at the first clause, not the first full stop: the brain sends a word, then
          // the rest about half a second later (13 Nov, Sonnet).
          if (firstSentenceAt === null) {
            const clause = firstClause(buffer);
            if (clause !== null) {
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
        if (dismissed) {
          asleep = true;
          sentAway = true;
        }
      } catch (error) {
        if (control.signal.aborted) deps.log(`[${id}] turn ${turn}: cut off`);
        else {
          deps.log(
            `[${id}] turn ${turn} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await say(
            own("err.brain", "Sorry, I couldn't reach my brain just then."),
            control.signal,
          ).catch(() => undefined);
        }
      } finally {
        if (reply === control || reply === null) {
          invited = !dismissed && invitesReply(said);
          openUntil = dismissed
            ? 0
            : Math.max(deps.now(), playUntil + config.downDelayMs) +
              (invited ? config.replyHoldMs : config.followMs);
        }
        if (reply === control) reply = null;
        if (current_ === me) current_ = null;
        if (reply === null) {
          spokeAt = Number.NEGATIVE_INFINITY;
          deps.arbiter?.report("ended", id);
        }
        if (said !== "" && !me.merged) history.push({ role: "assistant", content: said });
        if (said !== "") lastExchangeAt = deps.now();
        lastActivity = deps.now();
      }
      const metrics: TurnMetrics = {
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
        speakerScore:
          identity.confidence === null ? null : Math.round(identity.confidence * 1000) / 1000,
        emotion: affect?.emotion ?? "unknown",
        bargedIn,
        speculative: kept !== null,
      };
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
      interrupt();
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
            rec = deps.recognise();
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
    const heardOver = (pcm: Int16Array, seq: number, rx: number, q: number) => {
      voiceLevel.push(pcm);
      heardLately = [...heardLately, { seq, pcm }].slice(-60);
      // Nothing in flight and nothing queued: the R1 has every byte sent, so its count and ours differ by a constant.
      if (q === 0 && deps.now() - lastDownAt > 1_000) downBase = rx - downSamples * 2;
      if (downBase === null) return;
      const at = seq * pcm.length;
      // From 32 ms before the device's latency: the detector finds the rest (it only looks later, never earlier).
      const from = (rx - q - downBase) / 2 - R1_LATENCY + 512;
      underSpeaker = from - 512;
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
      if (!heard || !speaking() || enrolling() || bench.has(id) || lastProb < config.turn.stopProb)
        return;
      if (deps.now() - cutByVoiceAt < 1_000 || deps.now() - soundingFrom < ONSET_GRACE_MS) return;
      // Someone across the room is far quieter than he is; whose voice it is decides the rest.
      if (!voiceLevel.reaches(Number.isFinite(hisLevel) ? hisLevel - FAR_DB : TALK_MIN_DBFS))
        return;
      // Only a household voice may stop her, so with nobody enrolled it stays keyword.
      if (deps.member === undefined || deps.members?.() !== true) return;
      let release = () => undefined as void;
      const released = new Promise<void>((r) => (release = r));
      // His first words began about the detector's 256 ms before it was sure, plus a frame.
      hold = {
        since: deps.now(),
        from: Math.max(0, underSpeaker),
        fromSeq: seq - 5,
        release,
        released,
        checking: false,
        checkedSeconds: 0,
        quietSince: null,
        resuming: false,
      };
      playUntil = deps.now();
      deps.publish(topic(id, "voice/ctl"), JSON.stringify({ ev: "flush" }));
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

    /** Not the household's voice: she goes on from where she paused, or from her sentence's start after a long pause. */
    const resume = (h: NonNullable<typeof hold>) => {
      h.resuming = true;
      const long = deps.now() - h.since > 2_000;
      const back = long ? (phraseStarts.filter((p) => p <= h.from).at(-1) ?? h.from) : h.from;
      const from = Math.max(back, downSamples - DOWN_RING + 1);
      const again = new Int16Array(Math.max(0, downSamples - from));
      for (let i = 0; i < again.length; i += 1) again[i] = down[(from + i) % DOWN_RING]!;
      const signal = reply?.signal ?? new AbortController().signal;
      deps.log(
        `[${id}] not a household voice; she goes on${long ? " from her sentence's start" : ""}`,
      );
      otherVoice = { from: h.since - 1_000, until: deps.now() };
      void (async () => {
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
        const aligned =
          bytes.length > UP_HEADER && (bytes.length - UP_HEADER) % DOWN_FRAME_BYTES === 0;
        const pcm = fromBytes(aligned ? bytes.subarray(UP_HEADER) : bytes);
        const head = aligned ? new DataView(bytes.buffer, bytes.byteOffset, UP_HEADER) : null;
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
        if (head !== null && open(id)) {
          const seq = head.getUint32(0, true);
          const rx = head.getUint32(4, true);
          const q = head.getUint32(8, true);
          chain = chain.then(() => heardOver(pcm, seq, rx, q));
        }
      },
      /** He let go of push-to-talk (firmware 3.32 `ptt_end`): answer what he said, then end the session once it has played. */
      released: () =>
        (chain = chain.then(async () => {
          act(turns.release());
          await answering.catch(() => undefined);
          await deps.sleep(Math.max(0, playUntil + config.downDelayMs - deps.now()));
          deps.publish(topic(id, "cmd/voice/stop"), "{}");
        })),
      enrol: () => {
        guide = createEnrolGuide({
          // No name: the voice host's login is a machine account, and Tessaya keeps no display name for him.
          sentences: enrolScript(null),
          title: "Read these aloud",
          lead: "Stand where you usually talk to the R1, and use your normal voice. One sentence at a time, with a short pause between them.",
          mic: "Agora R1 (room mic)",
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
      sayOnly: (text: string, mood?: string | null) => {
        if (mood) face(mood);
        speakNow(text);
        stopAfterSaid();
      },
      /** `mood` is the eyes' look for her own words (the brain's expression); none keeps the eyes as they are. */
      say: (text: string, mood?: string | null) => {
        if (reply !== null) interrupt();
        if (mood) face(mood);
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
        if (reply !== null) interrupt();
        speakNow(own("persona.switch", `${next.name} here.`, { persona: next.name }));
      },
      /** An R1 button's prompt: answered as if he had said it to her. */
      ask: (text: string) => void answer(new Int16Array(0), "button", deps.now(), deps.now(), text),
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
        if (reply !== null) interrupt();
        speakNow(line);
      },
      /** S2 on this R1: someone is at it, which proves presence for an act waiting on who is speaking. */
      present: () => settleStepUp(true, "button"),
      /** Her name's own clip, heard by Voice ID: the first evidence of who woke her. */
      heardName: (identity: SpeakerIdentity, ms: number) => hear(identity, ms),
      call: (name: string, level = Number.NEGATIVE_INFINITY) => {
        if (Number.isFinite(level)) hisLevel = level;
        // Her name as heard, or the persona id a trained wake word belongs to.
        const named = personas.find((p) => p.name === name || p.id === name);
        if (named !== undefined && named !== persona) {
          persona = named;
          look();
        }
      },
      /** The R1's own stop (S2 or a tap while she speaks): she stops, and a turn on its way is not answered. */
      stopReply: (src: string) => stopHer(`[${id}] stop from the R1 (${src})`),
      /** S2 or the R1's own wake: he is talking to her now. */
      wake: () => {
        openUntil = Math.max(openUntil, deps.now() + config.followMs);
        firstUntil = deps.now() + config.firstTurnMs;
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
        const quiet = !turns.inTurn() && !speaking() && reply === null;
        // The persona he called holds for the whole session (13 Nov: Sebastian fell back within 14 s), or until he names another.
        if (quiet && !asleep && deps.now() > Math.max(openUntil, firstUntil)) {
          asleep = true;
          face("sleepy");
        }
        return quiet && deps.now() - lastActivity > config.idleStopMs ? "stop" : null;
      },
      quietFor: () => deps.now() - lastUpAt,
      /** For the replay harness: everything heard so far has been scored. */
      drained: () => chain,
      close: () => {
        closed = true;
        early?.control.abort();
        rec?.cancel();
        reply?.abort();
      },
    };
  };

  const sessions = new Map<string, ReturnType<typeof openSession>>();
  /** What each R1 says it can do (`state/caps`, retained): the true flags, by name. */
  const capabilities = new Map<string, ReadonlyArray<string>>();
  /** His own pronunciations per R1, from her server (`voice/pronounce`, retained). */
  const pronunciations = new Map<string, Readonly<Record<string, string>>>();
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
  const prefsOf = new Map<string, { readonly persona?: string; readonly voice?: string }>();
  /** Who each member last talked to on any vessel, from her server (`voice/current/<member>`), and when it said so. */
  const currentOf = new Map<string, { readonly persona: string; readonly at: number }>();
  /** The household's languages per R1, from her server (`voice/languages`, retained). */
  const languagesOf = new Map<string, ReadonlyArray<string>>();
  /** The conversation the arbiter last named for each R1 (sent on its turns). */
  const conversationOf = new Map<string, string>();
  /** Until when another device of his answers (the arbiter's `until`, epoch ms): this R1 stays quiet. */
  const quietUntil = new Map<string, number>();
  /** Until when her server's last eye mood holds on each R1 (`voice/intent/eye`): the loop's own moods wait. */
  const eyeHold = new Map<string, number>();
  /** A persona look sent to an R1 and not yet acknowledged on `state/eye/persona`. */
  const eyeAsked = new Map<string, { readonly name: string; readonly at: number }>();
  /** R1s muted from Tessaya: their audio is dropped unheard until unmuted, across sessions. */
  const muted = new Set<string>();
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
    }
  >();
  const start = (id: string, how = "audio") => {
    sessions.get(id)?.close();
    const s = openSession(id);
    sessions.set(id, s);
    deps.warm?.();
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
      if (tail.startsWith("cmd/eye/") || tail.startsWith("state/eye/")) {
        // Every eye command, the loop's or the server's, and every acknowledgement, so a look can be proved on his R1.
        const body = String(payload).slice(0, 120);
        // The server's own (the loop's are logged as sent; a broker that echoes them shows them here too).
        if (tail === "cmd/eye/persona" && !eyeAsked.has(id))
          eyeAsked.set(id, { name: String(json()["name"]), at: deps.now() });
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
        const { mood, holdMs, reason } = json();
        if (typeof mood === "string" && /^[a-z]{2,20}$/.test(mood)) {
          const hold = typeof holdMs === "number" && holdMs > 0 ? Math.min(holdMs, 30_000) : 0;
          eyeHold.set(id, deps.now() + hold);
          deps.log(
            `[${id}] eye intent ${mood} for ${hold} ms${typeof reason === "string" ? ` (${reason.slice(0, 40)})` : ""}`,
          );
          deps.publish(topic(id, "cmd/eye/set"), JSON.stringify({ mood }));
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
          const { persona: p, voice: v } = json();
          prefsOf.set(member, {
            ...(typeof p === "string" && /^[\w-]{1,40}$/.test(p) ? { persona: p } : {}),
            ...(typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? { voice: v } : {}),
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
      if (tail === "voice/up" || tail === "voice/up/tainted") {
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
      } else if (tail === "event/key") {
        // Presses the device left to us (did "none"); none has a meaning yet, so they are only logged.
        const k = json();
        if (k["did"] === "none") deps.log(`[${id}] key ${String(k["key"])} ${String(k["act"])}`);
      } else if (tail === "voice/say") {
        const text = json()["text"];
        if (typeof text === "string" && text.trim() !== "") {
          const open = sessions.get(id);
          const mood = r1MoodOf(String(json()["mood"] ?? ""));
          // The R1 plays her voice only inside its own session (r1bt_voice_play drops it otherwise, 13 Nov).
          if (open !== undefined) open.say(text.trim().slice(0, 500), mood);
          else startOnR1(id, (s) => s.sayOnly(text.trim().slice(0, 500), mood));
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
        const s = start(id, "S2 or wake");
        s.wake();
        const called = calledBy.get(id);
        calledBy.delete(id);
        // S2 on this R1 (not her name): he chose this one, so the others yield to it.
        if (called === undefined) {
          quietUntil.delete(id);
          gates.delete(id);
          void deps.arbiter
            ?.claim({ deviceId: id, wakeScore: 1, loudnessDb: null, answerHere: true })
            .catch(() => null);
        }
        if (called !== undefined) {
          s.call(called.word, called.level);
          void called.heard?.then((who) => who !== undefined && s.heardName(who, called.ms));
        } else s.present();
        cue(id, "wake");
        const then = onStart.get(id);
        onStart.delete(id);
        then?.(s);
      } else if (tail === "voice/wake") {
        // The R1 sends its wake stream only between sessions (SMP 0.3.35): a session still open here is a stale one,
        // left by a reboot or a stop we missed, and must not keep her name from being heard.
        // Right after a wake the rest of that segment is still on its way, and the R1 has not yet heard the start:
        // that session is new, not stale (03:30 replay, 13 Nov: every wake closed its own session 60 ms later).
        const open = sessions.get(id);
        if (open !== undefined) {
          if (open.quietFor() < STALE_SESSION_MS) return;
          deps.log(`[${id}] wake stream while a session was open here; closing it`);
          stop(id);
        }
        if (!muted.has(id)) deps.wake?.frame(id, payload);
      } else if (tail === "voice/wake/end") {
        const seg = json()["seg"];
        deps.wake?.end(id, typeof seg === "number" ? seg : undefined);
      } else if (tail === "event/wake/kws") {
        deps.wake?.kws?.(id, json() as KwsEvent);
      } else if (tail === "cmd/voice/stop") stop(id);
      else if (tail === "event/voice/interrupt" || tail === "event/voice/stop") {
        const src = json()["src"];
        sessions.get(id)?.stopReply(typeof src === "string" ? src.slice(0, 20) : "button");
      } else if (tail === "event/voice/flush")
        deps.log(`[${id}] the R1 flushed: ${String(payload).slice(0, 80)}`);
      else if (tail === "event/session/start" || tail === "event/wake") {
        sessions.get(id)?.wake();
        cue(id, "wake");
      } else if (
        tail === "event/session/end" ||
        (tail === "state/voice" && ["stop", "end"].includes(String(json()["ev"])))
      ) {
        // The R1 closed its own session (it no longer says "Bye bye"): her closing sound, then the loop lets it go.
        const s = sessions.get(id);
        if (s === undefined) return;
        cue(id, "end");
        sessions.delete(id);
        void deps.sleep(silent(id) ? 0 : soundMs("end") + config.downDelayMs).then(() => s.close());
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
        sessions.get(id)?.wake();
        if (config.inhouse.has(id)) void rearm(id);
      }
    },
    /** Ends sessions nobody has spoken in; the R1 hears its own stop and plays the exit chime. */
    sweep: () => {
      for (const [id, asked] of eyeAsked)
        if (deps.now() - asked.at > 3_000) {
          eyeAsked.delete(id);
          deps.log(`[${id}] eye persona ${asked.name}: no acknowledgement in 3 s`);
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
    /** The wake check heard `word`: the R1 starts its session (its echo opens ours) with that persona answering. */
    woken: (
      id: string,
      word: string,
      level = Number.NEGATIVE_INFINITY,
      score = 1,
      /** Her name as heard, for Voice ID on the claim. */
      clip?: Int16Array,
    ) => {
      if (sessions.has(id)) return;
      if (deps.now() < (quietUntil.get(id) ?? 0)) {
        deps.log(`[${id}] her name while another device answers: taken as her voice from there`);
        return;
      }
      const open = () => {
        calledBy.set(id, {
          word,
          level,
          ms: clip === undefined ? 0 : (clip.length / RATE) * 1000,
          ...(clip === undefined || deps.speaker === undefined
            ? {}
            : { heard: deps.speaker(clip).catch(() => undefined) }),
        });
        deps.publish(topic(id, "cmd/voice/start"), "{}");
      };
      if (deps.arbiter === undefined) return open();
      const arbiter = deps.arbiter;
      // Listening starts now; the arbiter answers alongside, and a lost claim closes this R1's session.
      const gate = (
        clip === undefined || deps.speaker === undefined
          ? Promise.resolve(undefined)
          : deps.speaker(clip).catch(() => undefined)
      ).then((heardBy) =>
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
