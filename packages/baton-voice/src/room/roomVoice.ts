/**
 * Tessaya in a room: the R1's in-house voice loop (agro-aiot Docs/136's gateway, folded into Tessaya). It hears
 * `voice/up`, asks her server, speaks on `voice/down` and stops when he cuts in. I/O is passed in for tests.
 * @module baton-voice/room/roomVoice
 */
import { DEFAULT_OS_PACK } from "@t3tools/baton-shared/osPack";

import { createEchoGuard } from "../echoGuard.ts";
import { calledName, isDismissal } from "./addressing.ts";
import { admits, UNVERIFIED, type SpeakerGate, type SpeakerIdentity } from "../speaker.ts";
import { DOWN_FRAME_BYTES, fromBytes, toBytes } from "./audio.ts";
import { PILL_SOUNDS, renderSound, soundMs, type PillSound } from "../cueSounds.ts";
import type { Affect } from "./senseVoice.ts";
import {
  createTurnTaking,
  ROOM_TURN,
  WINDOW,
  type TurnAction,
  type TurnConfig,
} from "./turnTaking.ts";

const RATE = 16_000;

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
}

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

export interface Tessaya {
  /** Who he called: the persona that answers this turn, in its own voice and with its own memory. */
  readonly persona?: string;
  readonly speaker?: SpeakerIdentity;
  readonly emotion?: { readonly label: string; readonly events: ReadonlyArray<string> };
}

export interface RoomDeps {
  readonly publish: (topic: string, payload: Uint8Array | string) => void;
  /** A fresh Silero scorer per session (it is recurrent). */
  readonly vad: () => { readonly score: (window: Int16Array) => Promise<number> };
  readonly smartTurn: (pcm: Int16Array) => Promise<number>;
  readonly recognise: () => RecogniserTurn;
  readonly speaker?: (pcm: Int16Array) => Promise<SpeakerIdentity>;
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
  /** Optional enrolment: the owner profile from these 4 s windows of his speech. */
  readonly enrolOwner?: (windows: ReadonlyArray<Int16Array>) => Promise<string>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** Her name with no session open (`voice/wake`): voiced segments only, never recognised beyond the wake check. */
  readonly wake?: {
    readonly frame: (deviceId: string, pcm: Uint8Array) => void;
    readonly end: (deviceId: string) => void;
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
}

export const ROOM_CONFIG: RoomConfig = {
  turn: ROOM_TURN,
  leadMs: 700,
  prerollMs: 240,
  downDelayMs: 300,
  upDelayMs: 150,
  followMs: 8_000,
  // shortcut: her name only wakes her while the R1 streams; with the firmware's own wake word off, S2 after this.
  idleStopMs: 15 * 60_000,
  // shortcut: the default pack's personas and voices (his picks); a pack he edits on the laptop is not read here.
  personas: DEFAULT_OS_PACK.personas.map((p) => ({
    id: p.id,
    name: p.wake ?? p.name,
    voice: p.voice,
  })),
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
};

const REARM_AT_MS = [2_000, 8_000, 18_000];

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

const ENROL_INTRO =
  "Let's learn your voice. Talk to me for about twenty seconds, about anything at all, and I'll tell you when I have enough.";
const ENROL_SECONDS = 16;

export const createRoomVoice = (deps: RoomDeps, config: RoomConfig = ROOM_CONFIG) => {
  const topic = (id: string, tail: string) => `freya/r1/${id}/${tail}`;

  const openSession = (id: string) => {
    const vad = deps.vad();
    const turns = createTurnTaking(config.turn);
    const echo = createEchoGuard();
    let pending = new Int16Array(0);
    let chain: Promise<void> = Promise.resolve();
    /** The turn being answered now, so a push-to-talk release can wait for its reply before ending the session. */
    let answering: Promise<void> = Promise.resolve();
    let rec: RecogniserTurn | null = null;
    let reply: AbortController | null = null;
    let playUntil = 0;
    let lastVoiceAt = deps.now();
    let lastActivity = deps.now();
    let turnNo = 0;
    let lastWakeCue = Number.NEGATIVE_INFINITY;
    let bargedIn = false;
    let closed = false;
    let enrolling: Int16Array[] | null = null;
    /** Turns until then need no name: a session opens on S2, and each reply leaves a short window. */
    let openUntil = deps.now() + config.followMs;
    let asleep = false;
    const lead = config.personas[0];
    /** Who answers: the one he last called, until the window lapses. */
    let persona = lead;
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    const speaking = () => reply !== null || deps.now() < playUntil + config.downDelayMs;

    const interrupt = () => {
      reply?.abort();
      reply = null;
      playUntil = deps.now();
      deps.publish(topic(id, "voice/ctl"), JSON.stringify({ ev: "flush" }));
      echo.reset();
    };

    /** Paced 60 ms publishes, at most `leadMs` ahead of what the R1 is playing. */
    const send = async (pcm: Int16Array, signal: AbortSignal, onFirst: () => void) => {
      const bytes = toBytes(pcm);
      for (let at = 0; at < bytes.length && !signal.aborted; at += DOWN_FRAME_BYTES) {
        const frame = bytes.subarray(at, at + DOWN_FRAME_BYTES);
        const now = deps.now();
        const ahead = playUntil - now;
        if (ahead > config.leadMs) await deps.sleep(ahead - config.leadMs);
        if (signal.aborted) return;
        const start = Math.max(deps.now(), playUntil);
        deps.publish(topic(id, "voice/down"), frame);
        echo.reference(fromBytes(frame), start + config.downDelayMs);
        playUntil = start + (frame.length / 2 / RATE) * 1000;
        onFirst();
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
      const out = async (pcm: Int16Array) =>
        send(pcm, signal, () => {
          if (!first) onFirstAudio?.();
          first = true;
        });
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
      play(deps.speak(text, signal, persona?.voice), signal, onFirstAudio, config.prerollMs);

    /** Starts her voice on `text` at once (after the sentence before it), buffering what it says for `play`. */
    let synthesis: Promise<void> = Promise.resolve();
    const ahead = (text: string, signal: AbortSignal): AsyncIterable<Int16Array> => {
      const voice = persona?.voice;
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
          for await (const pcm of deps.speak(text, signal, voice)) {
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
    const face = (mood: string) => deps.publish(topic(id, "cmd/eye/set"), JSON.stringify({ mood }));
    const gesture = (name: string) =>
      deps.publish(topic(id, "cmd/eye/gesture"), JSON.stringify({ name }));
    /** The persona's own eyes (the eye lane's looks; firmware without them ignores the topic). */
    const look = () =>
      deps.publish(
        topic(id, "cmd/eye/persona"),
        JSON.stringify({ name: (persona?.name ?? "").toLowerCase() }),
      );

    const speakNow = (text: string) => {
      const control = new AbortController();
      reply = control;
      lastActivity = deps.now();
      void say(text, control.signal)
        .catch(() => undefined)
        .finally(() => {
          if (reply === control) reply = null;
        });
    };

    /** When the turn being heard began: the window is about when he started, not when recognition finished. */
    let turnStartedAt = 0;
    const answer = async (
      pcm: Int16Array,
      reason: string,
      lastVoice: number,
      startedAt: number,
    ) => {
      const turn = (turnNo += 1);
      const decidedAt = deps.now();
      const current = rec;
      rec = null;
      const sides = Promise.all([
        deps.speaker?.(pcm).catch(() => UNVERIFIED(deps.now())),
        deps.affect?.(pcm).catch(() => undefined),
      ]);
      // What she would send her brain for these words, or null when this turn would not be answered.
      const ask = async (words: string) => {
        const called = calledName(
          words,
          config.personas.map((p) => p.name),
        );
        if (called === null && startedAt > openUntil) return null;
        // A guess waits for who is speaking: it may only answer whom the final turn would answer.
        const [speaker, affect] = await sides;
        const identity = speaker ?? UNVERIFIED(deps.now());
        if (!admits(identity, config.gate, "turn")) return null;
        const who = config.personas.find((p) => p.name === called) ?? persona;
        const tessaya: Tessaya = {
          ...(who === undefined || who === lead ? {} : { persona: who.id }),
          speaker: identity,
          ...(affect === undefined
            ? {}
            : { emotion: { label: affect.emotion, events: affect.events } }),
        };
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
      };
      let guess: Guess | null = null;
      let guesses = 0;
      let settled = false;
      const tryGuess = (words: string) => {
        if (settled || enrolling !== null || words.trim() === "") return;
        if (guess !== null && sameWords(guess.words, words)) return;
        if (guesses >= MAX_GUESSES) return;
        guesses += 1;
        guess?.control.abort();
        const control = new AbortController();
        const mine: Guess = { words, control, stream: null };
        guess = mine;
        void ask(words).then((request) => {
          // Too late once the final text is in: that path calls the brain itself.
          if (request === null || settled || control.signal.aborted || guess !== mine) return;
          mine.stream = buffered(deps.brain(request, control.signal));
        });
      };
      let latest = "";
      current?.onPartial?.((words) => {
        latest = words;
        tryGuess(words);
      });
      if (latest !== "") tryGuess(latest);
      const text = ((await current?.finish().catch(() => "")) ?? "").trim();
      settled = true;
      const textAt = deps.now();
      // The guess is kept only when it heard the same words; otherwise it never speaks.
      const last = guess as Guess | null;
      const kept = last !== null && sameWords(last.words, text) ? last : null;
      if (last !== null && kept === null) last.control.abort();
      if (enrolling !== null) {
        enrolling.push(...speechWindows(pcm));
        if (enrolling.length * 4 < ENROL_SECONDS) return;
        const windows = enrolling;
        enrolling = null;
        const said = await (deps.enrolOwner?.(windows) ??
          Promise.resolve("I can't keep a voice print here."));
        const control = new AbortController();
        reply = control;
        await say(said, control.signal).finally(() => {
          if (reply === control) reply = null;
        });
        return;
      }
      if (text === "") return;
      const called = calledName(
        text,
        config.personas.map((p) => p.name),
      );
      if (called === null && startedAt > openUntil) {
        deps.log(`[${id}] turn ${turn}: not said to her; not answered`);
        return;
      }
      const named = config.personas.find((p) => p.name === called);
      if (named !== undefined && named !== persona) {
        persona = named;
        look();
      }
      if (asleep) face("attentive");
      asleep = false;
      lastActivity = deps.now();
      const dismissed = isDismissal(text);
      openUntil = Number.POSITIVE_INFINITY;
      const [speaker, affect] = await Promise.race([
        sides,
        deps.sleep(config.sideMs).then(() => [undefined, undefined] as const),
      ]);
      const identity = speaker ?? UNVERIFIED(deps.now());
      if (!admits(identity, config.gate, "turn")) {
        deps.log(`[${id}] turn ${turn}: a ${identity.kind} voice; not answered`);
        return;
      }
      history.push({ role: "user", content: text });
      // One reply at a time: two playing at once interleave their frames on the downlink, which sounds chopped.
      if (reply !== null) interrupt();
      const control = kept?.control ?? new AbortController();
      reply = control;
      let brainFirst: number | null = null;
      let ttsFirst: number | null = null;
      let firstSound: number | null = null;
      let said = "";
      try {
        let buffer = "";
        let firstSentenceAt: number | null = null;
        const queue: string[] = [];
        let speakingChain = Promise.resolve();
        const enqueue = (sentence: string) => {
          queue.push(sentence);
          const preroll = firstSentenceAt === null ? config.prerollMs : 0;
          firstSentenceAt ??= deps.now();
          const audio = ahead(sentence, control.signal);
          speakingChain = speakingChain.then(() =>
            control.signal.aborted
              ? undefined
              : play(
                  audio,
                  control.signal,
                  () => {
                    if (firstSound === null) {
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
        const tessaya: Tessaya = {
          ...(persona === undefined || persona === lead ? {} : { persona: persona.id }),
          speaker: identity,
          ...(affect === undefined
            ? {}
            : { emotion: { label: affect.emotion, events: affect.events } }),
        };
        const source =
          kept?.stream ??
          deps.brain(
            { deviceId: id, messages: history.slice(-config.historyTurns * 2), tessaya },
            control.signal,
          );
        for await (const delta of source) {
          brainFirst ??= deps.now() - textAt;
          said += delta;
          buffer += delta;
          const { done, rest } = splitSentences(buffer);
          buffer = rest;
          done.forEach(enqueue);
        }
        if (buffer.trim() !== "") enqueue(buffer.trim());
        await speakingChain;
        // Back to rest once the R1 has played the last of it (the server's own mood may still hold until then).
        if (!control.signal.aborted)
          void deps.sleep(Math.max(0, playUntil + config.downDelayMs - deps.now())).then(() => {
            if (reply === null || reply === control) face("neutral");
          });
      } catch (error) {
        if (control.signal.aborted) deps.log(`[${id}] turn ${turn}: cut off`);
        else {
          deps.log(
            `[${id}] turn ${turn} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await say("Sorry, I couldn't reach my brain just then.", control.signal).catch(
            () => undefined,
          );
        }
      } finally {
        if (reply === control || reply === null)
          openUntil = dismissed
            ? 0
            : Math.max(deps.now(), playUntil + config.downDelayMs) + config.followMs;
        if (reply === control) reply = null;
        if (said.trim() !== "") history.push({ role: "assistant", content: said.trim() });
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

    const act = (actions: ReadonlyArray<TurnAction>) => {
      for (const a of actions) {
        switch (a.kind) {
          case "barge":
            bargedIn = true;
            interrupt();
            break;
          case "start":
            rec?.cancel();
            rec = deps.recognise();
            rec.feed(a.pcm);
            // The preroll is already in `a.pcm`, so his first word came that long before now.
            turnStartedAt = deps.now() - (a.pcm.length / RATE) * 1000;
            if (!asleep) face("attentive");
            break;
          case "audio":
            rec?.feed(a.pcm);
            break;
          case "check": {
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

    const onWindow = async (window: Int16Array, arrivedAt: number) => {
      const prob = await vad.score(window);
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
      frame: (bytes: Uint8Array) => {
        if (closed) return;
        const arrivedAt = deps.now();
        const pcm = fromBytes(bytes);
        const all = new Int16Array(pending.length + pcm.length);
        all.set(pending);
        all.set(pcm, pending.length);
        let at = 0;
        for (; at + WINDOW <= all.length; at += WINDOW) {
          const window = all.slice(at, at + WINDOW);
          chain = chain.then(() => onWindow(window, arrivedAt));
        }
        pending = all.slice(at);
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
        enrolling = [];
        speakNow(ENROL_INTRO);
      },
      cancelEnrol: () => {
        enrolling = null;
      },
      /** Tessaya says this in the room now (an agent, a reminder or the Devices page), cutting off whatever she was saying. */
      say: (text: string) => {
        if (reply !== null) interrupt();
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
      /** He called this persona by name to wake her. */
      call: (name: string) => {
        const named = config.personas.find((p) => p.name === name);
        if (named !== undefined && named !== persona) {
          persona = named;
          look();
        }
      },
      /** S2 or the R1's own wake: he is talking to her now. */
      wake: () => {
        openUntil = Math.max(openUntil, deps.now() + config.followMs);
      },
      /** Once a second: past the window she rests (sleepy eyes, name only); long quiet ends the session. */
      tick: (): "stop" | null => {
        const quiet = !turns.inTurn() && !speaking() && reply === null;
        if (quiet && !asleep && deps.now() > openUntil) {
          asleep = true;
          face("sleepy");
          if (persona !== lead) {
            persona = lead;
            look();
          }
        }
        return quiet && deps.now() - lastActivity > config.idleStopMs ? "stop" : null;
      },
      /** For the replay harness: everything heard so far has been scored. */
      drained: () => chain,
      close: () => {
        closed = true;
        rec?.cancel();
        reply?.abort();
      },
    };
  };

  const sessions = new Map<string, ReturnType<typeof openSession>>();
  /** R1s muted from Tessaya: their audio is dropped unheard until unmuted, across sessions. */
  const muted = new Set<string>();
  /** R1s with her listening and closing sounds off (`cmd/voice/earcons {"on":false}`, retained); on by default. */
  const noCues = new Set<string>();
  const cue = (id: string, name: PillSound) => {
    if (!noCues.has(id)) sessions.get(id)?.cue(name);
  };
  /** Who woke an R1 by name, until its session starts. */
  const calledBy = new Map<string, string>();
  const start = (id: string) => {
    sessions.get(id)?.close();
    const s = openSession(id);
    sessions.set(id, s);
    deps.log(`[${id}] session open`);
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
      if (tail === "voice/up") {
        if (!muted.has(id)) (sessions.get(id) ?? start(id)).frame(payload);
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
        if (typeof text === "string" && text.trim() !== "")
          (sessions.get(id) ?? start(id)).say(text.trim().slice(0, 500));
      } else if (tail === "cmd/voice/start") {
        const s = start(id);
        const word = calledBy.get(id);
        calledBy.delete(id);
        if (word !== undefined) s.call(word);
        cue(id, "wake");
      } else if (tail === "voice/wake") {
        if (!sessions.has(id) && !muted.has(id)) deps.wake?.frame(id, payload);
      } else if (tail === "voice/wake/end") {
        deps.wake?.end(id);
      } else if (tail === "cmd/voice/stop") stop(id);
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
        void deps
          .sleep(noCues.has(id) ? 0 : soundMs("end") + config.downDelayMs)
          .then(() => s.close());
      } else if (tail === "cmd/voice/earcons") {
        if (json()["on"] === false) noCues.add(id);
        else noCues.delete(id);
      } else if (tail === "voice/enrol") {
        if (json()["cancel"] === true) sessions.get(id)?.cancelEnrol();
        else (sessions.get(id) ?? start(id)).enrol();
      } else if (
        tail === "state/online" &&
        String(payload).trim() === "1" &&
        config.inhouse.has(id)
      )
        void rearm(id);
    },
    /** Ends sessions nobody has spoken in; the R1 hears its own stop and plays the exit chime. */
    sweep: () => {
      for (const [id, s] of sessions)
        if (s.tick() === "stop") {
          // Her closing sound plays out before the R1 is told to stop (it no longer says "Bye bye" itself).
          const closing = noCues.has(id) ? 0 : soundMs("end") + config.downDelayMs;
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
    woken: (id: string, word: string) => {
      if (sessions.has(id)) return;
      calledBy.set(id, word);
      deps.publish(topic(id, "cmd/voice/start"), "{}");
    },
    close: () => {
      for (const id of Array.from(sessions.keys())) stop(id);
    },
  };
};
