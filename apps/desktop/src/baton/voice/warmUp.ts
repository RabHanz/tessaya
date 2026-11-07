/* oxlint-disable t3code/no-low-value-comments -- Baton file predating the rule (D82) */
// @effect-diagnostics globalTimers:off globalDate:off
/**
 * Models load on first use: the wake scorer and the speech detector on the first frames, the recogniser on
 * the first transcription. Armed cold, the first phrase after launch waits behind that load and is lost.
 * So before the microphone opens, a second of silence goes through all three; a failure here only means
 * the first real phrase pays for the load, as it did. A starved CPU can take far longer than a healthy one
 * (about a second there), so the limit is generous and the caller shows each stage as it finishes.
 */
const FRAME_SAMPLES = 320;
const WARM_FRAMES = 100;
/** The microphone opens after this at the latest, however the models are doing. */
export const WARM_LIMIT_MS = 45_000;

/**
 * A second of quiet noise, not digital silence: a recogniser may decline to answer for silence at all,
 * and then there is nothing to wait for. Deterministic, so a run is repeatable.
 */
const warmClip = (seconds = 1): Int16Array => {
  const out = new Int16Array(16_000 * seconds);
  let seed = 12_345;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    out[i] = (seed % 4_001) - 2_000;
  }
  return out;
};

/**
 * After the first second, longer clips, one at a time: the recogniser sizes its working memory for the longest
 * audio it has seen, so without these the first real sentence (three to eight seconds) pays for that instead.
 * They run before the microphone opens and none starts after the limit: the sidecar has one engine thread, so a
 * clip still running would queue his first sentence and the wake check behind it.
 */
export const LONGER_WARM_SECONDS: ReadonlyArray<number> = [4, 8];

export interface WarmUpInput {
  readonly pushFrame: (frame: Int16Array) => void;
  readonly transcribe: (pcm: Int16Array) => Promise<string>;
  /** Resolves once every frame pushed so far has been scored. */
  readonly settled: () => Promise<void>;
  /** Called as each of the two stages finishes (frames scored; recogniser answered), so the start can show progress. */
  readonly onStage?: (ready: number, total: number) => void;
  /** Resolves after the limit. Real time by default; a test passes its own. */
  readonly limit?: () => Promise<void>;
  /** Each longer clip as it finishes, for the turn log. */
  readonly onLonger?: (seconds: number, ms: number) => void;
}

/**
 * `result` settles at the first of: both models ready (true), a failure or the limit (false). `complete` settles when the
 * models really are ready, however long that takes on this computer (never rejects; a failed load settles it too, since
 * nothing more can be waited for), so audio heard in the meantime can be held and played in, not lost.
 */
export const startWarmUp = (
  input: WarmUpInput,
): { readonly result: Promise<boolean>; readonly complete: Promise<void> } => {
  const limit =
    input.limit ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, WARM_LIMIT_MS).unref()));
  let pastLimit = false;
  const limitPassed = limit().then(() => {
    pastLimit = true;
    return false;
  });
  let ready = 0;
  const stage = () => input.onStage?.((ready += 1), 2);
  let complete: Promise<void>;
  try {
    for (let i = 0; i < WARM_FRAMES; i += 1) input.pushFrame(new Int16Array(FRAME_SAMPLES));
    complete = Promise.all([
      input.settled().then(stage),
      input.transcribe(warmClip()).then(stage),
    ]).then(async () => {
      for (const seconds of LONGER_WARM_SECONDS) {
        if (pastLimit) return;
        const started = Date.now();
        // A failed longer clip only means the first long sentence pays for the sizing, as before.
        const answered = await input.transcribe(warmClip(seconds)).then(
          () => true,
          () => false,
        );
        if (!answered) return;
        input.onLonger?.(seconds, Date.now() - started);
      }
    });
  } catch {
    complete = Promise.reject(new Error("warm-up failed to start"));
  }
  const done = complete.then(
    () => true,
    () => false,
  );
  return {
    // Never wait on it for good: the recogniser may not answer for silence at all (0.1.30 hung here).
    result: Promise.race([done, limitPassed]),
    complete: done.then(() => undefined),
  };
};

export const warmUpVoice = (input: WarmUpInput): Promise<boolean> => startWarmUp(input).result;

const FRAME_SAMPLES_PER_MS = 16;
/** A frame this quiet is room tone: a long run of them is shortened, because the replay below runs at the speed of speech. */
const QUIET_RMS = 0.004;
const KEEP_QUIET_MS = 1_200;

const rms = (frame: Int16Array): number => {
  let sum = 0;
  for (const v of frame) sum += (v / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, frame.length));
};

/** The held audio with every long quiet stretch cut to 1.2 s: enough to end a phrase, not minutes of waiting in silence. */
export const compactQuiet = (frames: ReadonlyArray<Int16Array>): ReadonlyArray<Int16Array> => {
  const out: Int16Array[] = [];
  let quietMs = 0;
  for (const frame of frames) {
    if (rms(frame) < QUIET_RMS) {
      quietMs += frame.length / FRAME_SAMPLES_PER_MS;
      if (quietMs > KEEP_QUIET_MS) continue;
    } else quietMs = 0;
    out.push(frame);
  }
  return out;
};

/**
 * The core, except that audio arriving before `ready` is kept (the newest `maxFrames`, about 5 min) and played in once it
 * is ready. Played in at twice the speed it was said, not all at once: the wake check, the command window and the recogniser
 * all follow the clock, so a phrase pushed in a burst finishes before the window that waits for it has opened.
 */
export const holdFramesUntil = <T extends { pushAudio: (frame: Int16Array) => void }>(
  core: T,
  ready: Promise<unknown>,
  maxFrames = 15_000,
  /** For the turn log, and a test's clock. */
  on: {
    readonly first?: () => void;
    readonly played?: (frames: number) => void;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): T => {
  const sleep =
    on.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let open = false;
  let seen = false;
  const held: Int16Array[] = [];
  void ready.then(async () => {
    const backlog = compactQuiet(held.splice(0));
    on.played?.(backlog.length);
    let next = 0;
    // Frames that arrive while this plays queue behind it, in order; the last check and `open = true` have no await between them.
    for (;;) {
      const frame = backlog[next++] ?? held.shift();
      if (frame === undefined) break;
      core.pushAudio(frame);
      // Twice the speed it was said, so the frames that arrive meanwhile are caught up with, not trailed for good.
      await sleep(frame.length / FRAME_SAMPLES_PER_MS / 2);
    }
    open = true;
  });
  const pushAudio = (frame: Int16Array) => {
    if (!seen) {
      seen = true;
      on.first?.();
    }
    if (open) return core.pushAudio(frame);
    held.push(frame);
    if (held.length > maxFrames) held.shift();
  };
  return new Proxy(core, {
    get: (target, prop) => {
      if (prop === "pushAudio") return pushAudio;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/** Runs each job after the one before has finished or failed: start, stop and relisten never overlap. */
export const serialQueue = () => {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = last.then(job, job);
    last = next.catch(() => undefined);
    return next;
  };
};

/** Rejects if `work` has not settled within `ms`, so a call that never answers cannot hold the queue. */
export const within = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s.`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

/** After start-up has settled: the window, T3 and the server are up, so the sidecar spawn does not stall them. */
export const DICTATION_SETTLE_MS = 15_000;

/**
 * When the dictation sidecar and its speech model load at launch. With the wake word on, `start` loads them at once
 * (it cannot listen without them). With it off, only the hold-to-dictate key needs them, and that key is the
 * sidecar's: they load once start-up has settled rather than never, so the first press still types.
 */
export const dictationAtLaunch = (s: {
  readonly available: boolean;
  readonly dictation: string;
  readonly modelPresent: boolean;
  readonly wakeOn: boolean;
}): "now" | "settled" | "never" =>
  !s.available || s.dictation !== "baton" || !s.modelPresent
    ? "never"
    : s.wakeOn
      ? "now"
      : "settled";
