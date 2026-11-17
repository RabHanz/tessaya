/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off
/**
 * One voice for everything Tessaya says, one sentence after another. A local neural voice (free,
 * D113). The OS voice speaks only when he chose "System voice": while the neural voice is still
 * loading a line waits for it, and when it cannot load nothing is spoken, only shown. Each sentence starts
 * generating as soon as the one before has finished generating and plays as it arrives, so a gap
 * between two is only what has not been generated yet. Written only is enforced here, so nothing
 * can reach the speakers.
 */
import type { TtsProvider } from "@t3tools/tessaya-voice";

import {
  directionsOf,
  hasDirection,
  speechPieces,
  withoutDirections,
} from "@t3tools/tessaya-shared/interjections";
import { isNarration } from "@t3tools/tessaya-shared/narration";
import { pronounce } from "@t3tools/tessaya-shared/pronounce";
import { withProsody } from "@t3tools/tessaya-shared/prosody";
import type { Viseme } from "@t3tools/tessaya-shared/visemes";
import { spliceSpeech } from "@t3tools/tessaya-shared/speechSplice";
import { saidText, soundAnchors, type SoundAnchor } from "@t3tools/tessaya-shared/speechEffects";

/** Plays a WAV as its bytes arrive; resolves false if there was nothing to play. */
export interface VoicePlayer {
  /**
   * `text` is what the audio says, when it says only that: her mouth shapes are aligned to it (visemes.ts). `sounds`
   * are its stage directions, each fired on its word (speechEffects.ts).
   */
  readonly play: (
    wav: AsyncIterable<Buffer>,
    text?: string,
    sounds?: ReadonlyArray<SoundAnchor>,
  ) => Promise<boolean>;
  readonly stop: () => void;
  /** Lower the voice while someone may be talking over it; `false` brings it back. */
  readonly duck?: (on: boolean) => void;
  readonly dispose: () => void;
}

/** Text to streaming WAV bytes. The engines differ only here. */
export type Synthesise = (text: string) => {
  readonly stream: AsyncIterable<Buffer>;
  readonly cancel: () => void;
};

/** Off the screen and free of markup a synthesiser would read out. */
export const speakableText = (text: string): string =>
  text
    .replace(/[`*_#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Rate and where samples begin, from the header at the start of a stream. */
export const wavFormat = (
  head: Buffer,
): { readonly rate: number; readonly start: number } | null => {
  const data = head.indexOf("data", 12, "latin1");
  return data < 0 || head.length < 28 ? null : { rate: head.readUInt32LE(24), start: data + 8 };
};

/** Loudness of a run of mono 16-bit samples, 0..1. */
export const pcmLevel = (pcm: Buffer): number => {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 2 <= pcm.length; i += 16) {
    const v = pcm.readInt16LE(i) / 32768;
    sum += v * v;
    count += 1;
  }
  return count === 0 ? 0 : Math.min(1, Math.sqrt(sum / count) * 3.2);
};

/**
 * The sound of one short frame of her voice, for her mouth's shape (the Character Studio's lipsync.js reads the same
 * from an analyser): how often it crosses zero (hiss: s, t, f) and how much of it is high frequency (bright: e, i;
 * dark: o, u), as the share of the signal's energy in its sample-to-sample change.
 */
export interface VoiceShape {
  readonly zcr: number;
  readonly bright: number;
  /** The mouth shape the reply's text aligned here, when the alignment has reached this far. */
  readonly viseme?: Viseme;
}
export const pcmShape = (pcm: Buffer): VoiceShape => {
  let crossings = 0;
  let energy = 0;
  let change = 0;
  let last = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    if (i > 0) {
      if (v >= 0 !== last >= 0) crossings++;
      change += (v - last) * (v - last);
    }
    energy += v * v;
    last = v;
  }
  return n < 2 || energy === 0
    ? { zcr: 0, bright: 0 }
    : { zcr: crossings / n, bright: Math.min(1, change / (4 * energy)) };
};

/** The player page's clocks when it schedules a chunk: its AudioContext's, and the speaker's output timestamp. */
export interface AudioClock {
  /** Context time (s) the chunk's first sample is scheduled at. */
  readonly at: number;
  readonly currentTime: number;
  /** getOutputTimestamp(): the context time leaving the speaker, and the page's performance time it does (0 before it starts). */
  readonly contextTime: number;
  readonly performanceTime: number;
  readonly timeOrigin: number;
  readonly now: number;
  /** outputLatency, or baseLatency where there is none (s). */
  readonly latency: number;
}

/** Epoch ms the chunk's first sample is heard, from the audio clock, never from when the chunk or the page's reply arrived. */
export const heardAtMs = (clock: AudioClock): number =>
  clock.performanceTime > 0
    ? clock.timeOrigin + clock.performanceTime + (clock.at - clock.contextTime) * 1000
    : clock.timeOrigin + clock.now + (clock.at - clock.currentTime + clock.latency) * 1000;

/** Her level and mouth shape are read every this long of sound, so the mouth follows syllables, not chunks. */
export const FRAME_MS = 40;

/** A chunk of 16-bit mono in FRAME_MS frames, each with the epoch ms it is heard. */
export const speechFrames = (
  samples: Buffer,
  rate: number,
  heardAt: number,
): Array<{ readonly atMs: number; readonly pcm: Buffer }> => {
  const step = Math.max(2, Math.round((rate * FRAME_MS) / 1000) * 2);
  const frames = [];
  for (let at = 0; at < samples.length; at += step)
    frames.push({ atMs: heardAt + (at / 2 / rate) * 1000, pcm: samples.subarray(at, at + step) });
  return frames;
};

/** Reads ahead into memory, so generation runs on while the sentence before is still playing. */
const readAhead = (
  source: AsyncIterable<Buffer>,
): { stream: AsyncIterable<Buffer>; finished: Promise<void> } => {
  const chunks: Buffer[] = [];
  let ended = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const poke = () => {
    wake?.();
    wake = null;
  };
  const finished = (async () => {
    try {
      for await (const chunk of source) {
        chunks.push(chunk);
        poke();
      }
    } catch (error) {
      failure = error;
    }
    ended = true;
    poke();
  })();
  return {
    finished,
    stream: (async function* () {
      for (;;) {
        while (chunks.length > 0) yield chunks.shift()!;
        if (ended) {
          if (failure !== null) throw failure;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    })(),
  };
};

/** What the chosen voice is right now. Only "system" ever reaches the OS voice. */
export type VoiceChoice =
  | { readonly kind: "system" }
  /** `voice` names the voice, for its interjection picks; `engine` says whether it takes Gemini's tags. */
  | {
      readonly kind: "synth";
      readonly synth: Synthesise;
      readonly voice?: string;
      readonly engine?: "pocket" | "gemini";
    }
  /** Not loaded yet: resolves true when it is, false when it cannot be. */
  | { readonly kind: "wait"; readonly ready: Promise<boolean> };

/** For the labs: an engine that is not ready stays silent, as it does in the app. */
export const labVoice = (synth: Synthesise | null): VoiceChoice =>
  synth === null ? { kind: "wait", ready: Promise.resolve(false) } : { kind: "synth", synth };

export interface Speaker extends TtsProvider {
  /** `persona` (an id) speaks in that persona's voice; without one, in the voice chosen now. */
  readonly speak: (text: string, persona?: string) => Promise<void>;
  readonly cancel: () => void;
  readonly dispose: () => void;
  /** Plays one line in a voice he is auditioning, even when answers are written only. */
  readonly sample: (choice: VoiceChoice, text: string) => Promise<void>;
}

export const createSpeaker = (input: {
  readonly os: TtsProvider;
  /** The chosen voice, or `persona`'s. Asked per sentence, so a change applies at once. */
  readonly voice: (persona?: string) => VoiceChoice;
  readonly player: VoicePlayer;
  /** Written only: nothing is synthesised and nothing plays. */
  readonly silent?: () => boolean;
  readonly onActive?: (active: boolean) => void;
  /** Each sentence as it is taken, before anything plays. */
  readonly onText?: (text: string) => void;
  /** Each sentence as it starts to play: the audio reported next is its. */
  readonly onPlaying?: (text: string) => void;
  /** A line is held back while the voice loads: true when it starts waiting, false when it stops. */
  readonly onWaiting?: (waiting: boolean) => void;
  /** The voice could not speak this line. Nothing was said aloud; the text is all he gets. */
  readonly onUnavailable?: (text: string) => void;
  /** His own pronunciations (word → how to say it), read for each sentence. */
  readonly respellings?: () => Readonly<Record<string, string>>;
}): Speaker => {
  const running = new Set<() => void>();
  let generation = 0;
  let queued = 0;
  let tail: Promise<void> = Promise.resolve();
  let generating: Promise<void> = Promise.resolve();

  const startSource = (
    choice: Extract<VoiceChoice, { kind: "synth" }>,
    mine: number,
    raw: string,
    continuing: boolean,
  ) => {
    const previous = generating;
    const his = input.respellings?.() ?? {};
    // Gemini's own tags (`<sigh>`) pass through; everything around them is made sayable.
    const sayable = (text: string) =>
      text
        .split(/(<[a-z -]{1,30}>)/)
        .map((part, i) => (i % 2 === 1 ? part : speakableText(pronounce(part, his))))
        .join(" ")
        .trim();
    const engine = choice.engine === undefined ? {} : { engine: choice.engine };
    const pieces = withProsody(
      speechPieces(raw, choice.voice ?? "", { his, ...engine }).map((p) =>
        p.kind === "text" ? { ...p, text: sayable(p.text) } : p,
      ),
      { continuing, ...engine },
    );
    const say = (text: string) => {
      const job = choice.synth(text);
      running.add(job.cancel);
      return (async function* () {
        try {
          yield* job.stream;
        } finally {
          running.delete(job.cancel);
        }
      })();
    };
    // The engine takes one sentence at a time.
    const source = readAhead(
      (async function* () {
        await previous;
        if (mine !== generation) return;
        const only = pieces.length === 1 ? pieces[0] : undefined;
        // Plain words stream as they come; only a line with a sound in it is spliced.
        if (only?.kind === "text") yield* say(only.text);
        else if (pieces.length > 0)
          for await (const chunk of spliceSpeech(pieces, say)) yield Buffer.from(chunk);
      })(),
    );
    generating = source.finished;
    // What the audio says: its words and any sound said as words ("Ha ha."). A spliced breath or pause (one starts most
    // sentences after the first) is a gap the alignment allows for.
    const said = pieces.some((p) => p.kind === "text") ? saidText(pieces) : undefined;
    const gemini = choice.engine === "gemini" ? directionsOf(raw) : [];
    return { ...source, text: said, sounds: soundAnchors(pieces, gemini) };
  };

  const run = (raw: string, pick: () => VoiceChoice, force: boolean): Promise<void> => {
    if (!force && input.silent?.() === true) return Promise.resolve();
    // Her reasoning written out as a sentence is never said, on any surface (13 Nov R1 audit).
    if (isNarration(raw)) return Promise.resolve();
    // A stage direction ("*sighs*") is a sound or nothing, never words.
    const sound = hasDirection(raw);
    const plain = sound ? withoutDirections(raw) : raw;
    const text = speakableText(plain);
    if (text.length === 0 && !sound) return Promise.resolve();
    // What is shown stays as written; only the voice is given it respelled. Her echo is checked against both.
    const spoken = speakableText(pronounce(plain, input.respellings?.() ?? {}));
    if (text.length > 0) input.onText?.(text);
    if (spoken !== text && spoken.length > 0) input.onText?.(spoken);
    // Nothing left to say (only emoji): shown, and not a line the voice failed on.
    if (spoken.length === 0 && !sound) return Promise.resolve();
    const mine = generation;
    // A sentence queued behind another of the same reply is "continuing": it may start with a breath.
    const continuing = queued > 0;
    const first = pick();
    let source: ReturnType<typeof startSource> | null = null;
    if (first.kind === "synth") {
      source = startSource(first, mine, raw, continuing);
    }
    if (queued === 0) input.onActive?.(true);
    queued += 1;
    const turn = tail.then(async () => {
      if (mine !== generation) return;
      let choice = first;
      if (choice.kind === "wait") {
        input.onWaiting?.(true);
        const ok = await choice.ready.catch(() => false);
        input.onWaiting?.(false);
        if (mine !== generation) return;
        choice = ok ? pick() : first;
        if (choice.kind === "synth") {
          source = startSource(choice, mine, raw, continuing);
        }
      }
      if (choice.kind === "system") {
        input.onPlaying?.(text);
        if (spoken.length > 0) await input.os.speak(spoken).catch(() => undefined);
      } else if (source === null) {
        input.onUnavailable?.(text);
      } else {
        input.onPlaying?.(text);
        const played = await input.player
          .play(source.stream, source.text, source.sounds)
          .catch(() => false);
        if (mine === generation && !played) input.onUnavailable?.(text);
      }
    });
    tail = turn.finally(() => {
      queued -= 1;
      if (queued === 0) input.onActive?.(false);
    });
    return tail;
  };
  const speak = (raw: string, persona?: string) => run(raw, () => input.voice(persona), false);

  const cancel = () => {
    generation += 1;
    for (const stop of running) stop();
    running.clear();
    input.player.stop();
    input.os.cancel?.();
  };

  return {
    name: "baton",
    speak,
    sample: (choice, text) => {
      cancel();
      return run(text, () => choice, true);
    },
    cancel,
    dispose: () => {
      cancel();
      input.player.dispose();
    },
  };
};
