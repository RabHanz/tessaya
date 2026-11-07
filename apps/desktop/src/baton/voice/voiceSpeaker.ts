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
import type { TtsProvider } from "@t3tools/baton-voice";

/** Plays a WAV as its bytes arrive; resolves false if there was nothing to play. */
export interface VoicePlayer {
  readonly play: (wav: AsyncIterable<Buffer>) => Promise<boolean>;
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
  | { readonly kind: "synth"; readonly synth: Synthesise }
  /** Not loaded yet: resolves true when it is, false when it cannot be. */
  | { readonly kind: "wait"; readonly ready: Promise<boolean> };

/** For the labs: an engine that is not ready stays silent, as it does in the app. */
export const labVoice = (synth: Synthesise | null): VoiceChoice =>
  synth === null ? { kind: "wait", ready: Promise.resolve(false) } : { kind: "synth", synth };

export interface Speaker extends TtsProvider {
  readonly cancel: () => void;
  readonly dispose: () => void;
  /** Plays one line in a voice he is auditioning, even when answers are written only. */
  readonly sample: (choice: VoiceChoice, text: string) => Promise<void>;
}

export const createSpeaker = (input: {
  readonly os: TtsProvider;
  /** The chosen voice. Asked per sentence, so a change applies at once. */
  readonly voice: () => VoiceChoice;
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
}): Speaker => {
  const running = new Set<() => void>();
  let generation = 0;
  let queued = 0;
  let tail: Promise<void> = Promise.resolve();
  let generating: Promise<void> = Promise.resolve();

  const startSource = (synth: Synthesise, mine: number, text: string) => {
    const previous = generating;
    // The engine takes one sentence at a time.
    const source = readAhead(
      (async function* () {
        await previous;
        if (mine !== generation) return;
        const job = synth(text);
        running.add(job.cancel);
        try {
          yield* job.stream;
        } finally {
          running.delete(job.cancel);
        }
      })(),
    );
    generating = source.finished;
    return source;
  };

  const run = (raw: string, pick: () => VoiceChoice, force: boolean): Promise<void> => {
    if (!force && input.silent?.() === true) return Promise.resolve();
    const text = speakableText(raw);
    if (text.length === 0) return Promise.resolve();
    input.onText?.(text);
    const mine = generation;
    const first = pick();
    let source: ReturnType<typeof readAhead> | null = null;
    if (first.kind === "synth") {
      source = startSource(first.synth, mine, text);
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
          source = startSource(choice.synth, mine, text);
        }
      }
      if (choice.kind === "system") {
        input.onPlaying?.(text);
        await input.os.speak(text).catch(() => undefined);
      } else if (source === null) {
        input.onUnavailable?.(text);
      } else {
        input.onPlaying?.(text);
        const played = await input.player.play(source.stream).catch(() => false);
        if (mine === generation && !played) input.onUnavailable?.(text);
      }
    });
    tail = turn.finally(() => {
      queued -= 1;
      if (queued === 0) input.onActive?.(false);
    });
    return tail;
  };
  const speak = (raw: string) => run(raw, input.voice, false);

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
