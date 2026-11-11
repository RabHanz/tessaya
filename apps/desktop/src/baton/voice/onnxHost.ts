// @effect-diagnostics globalTimers:off -- the worker restart runs on child-process callbacks outside Effect.
/**
 * The main process's side of the ONNX worker: the same scorers the voice core used in-process, answered by a
 * child process. A crashed child is restarted; while it is down every score is "nothing heard", never an error,
 * because one rejected score would stop the provider's queue for good.
 */
import {
  createOpenWakeWordScorer,
  createSileroScorer,
  createSpeakerEmbedder,
  type SpeakerEmbedder,
  type OpenWakeWordPaths,
  type OpenWakeWordScorer,
  type SileroScorer,
} from "@t3tools/baton-voice";

export type OnnxRequest =
  | { readonly op: "open-wake"; readonly id: number; readonly paths: OpenWakeWordPaths }
  | { readonly op: "open-vad"; readonly id: number; readonly path: string }
  | {
      readonly op: "open-speaker";
      readonly id: number;
      readonly path: string;
      readonly model: string;
    }
  | { readonly op: "speaker"; readonly id: number; readonly pcm: Int16Array }
  | { readonly op: "wake" | "vad"; readonly id: number; readonly chunk: Int16Array }
  | { readonly op: "reset-wake" | "reset-vad" };

export type OnnxReply =
  | { readonly id: number; readonly value: number | ReadonlyArray<number> | null }
  | { readonly id: number; readonly error: string };

/** One request at a time, in order, so a reset never lands in the middle of a score. */
export const serveOnnx = (
  post: (reply: OnnxReply) => void,
  make: {
    readonly wake: typeof createOpenWakeWordScorer;
    readonly vad: typeof createSileroScorer;
    readonly speaker?: typeof createSpeakerEmbedder;
  } = { wake: createOpenWakeWordScorer, vad: createSileroScorer, speaker: createSpeakerEmbedder },
) => {
  let wake: OpenWakeWordScorer | null = null;
  let vad: SileroScorer | null = null;
  let speaker: SpeakerEmbedder | null = null;
  let queue: Promise<void> = Promise.resolve();
  const run = async (request: OnnxRequest) => {
    switch (request.op) {
      case "open-wake":
        wake = await make.wake(request.paths);
        return post({ id: request.id, value: wake.chunkSamples });
      case "open-vad":
        vad = await make.vad(request.path);
        return post({ id: request.id, value: vad.chunkSamples });
      case "wake":
        if (wake === null) throw new Error("no wake model open");
        return post({ id: request.id, value: await wake.score(request.chunk) });
      case "vad":
        if (vad === null) throw new Error("no speech model open");
        return post({ id: request.id, value: await vad.score(request.chunk) });
      case "open-speaker":
        speaker = await (make.speaker ?? createSpeakerEmbedder)(request.path, request.model);
        return post({ id: request.id, value: 0 });
      case "speaker": {
        if (speaker === null) throw new Error("no speaker model open");
        const vector = await speaker.embed(request.pcm);
        return post({ id: request.id, value: vector === null ? null : Array.from(vector) });
      }
      case "reset-wake":
        return wake?.reset();
      case "reset-vad":
        return vad?.reset();
    }
  };
  return (request: OnnxRequest) => {
    queue = queue.then(() =>
      run(request).catch((error: unknown) => {
        if ("id" in request) post({ id: request.id, error: String(error) });
      }),
    );
  };
};

export interface OnnxChild {
  readonly postMessage: (request: OnnxRequest) => void;
  readonly onMessage: (listener: (reply: OnnxReply) => void) => void;
  readonly onExit: (listener: (code: number) => void) => void;
  readonly kill: () => void;
}

const FIRST_RESTART_MS = 1_000;
const MAX_RESTART_MS = 60_000;
/** A worker up this long after reloading has recovered: the next crash starts the backoff again. */
const HEALTHY_MS = 60_000;
/** Longer than a cold model load on a slow laptop; a worker silent this long is hung and is restarted. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** A scorer from the host; `close` stops a crash from reloading it once voice is off. */
export type HostedScorer<T> = T & { readonly close: () => void };

export const createOnnxHost = (input: {
  readonly fork: () => OnnxChild;
  /** Every unexpected exit, for the log; `speak` is true once per run, at the first crash while listening. */
  readonly onCrash: (code: number, speak: boolean) => void;
}) => {
  let child: OnnxChild | null = null;
  let id = 0;
  const pending = new Map<
    number,
    {
      readonly resolve: (value: never) => void;
      readonly reject: (error: Error) => void;
      readonly fallback?: unknown;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  const opened: OnnxRequest[] = [];
  let told = false;
  let closed = false;
  let restartMs = FIRST_RESTART_MS;

  const settle = (key: number) => {
    const waiting = pending.get(key);
    if (waiting !== undefined) {
      pending.delete(key);
      clearTimeout(waiting.timer);
    }
    return waiting;
  };
  const start = () => {
    const current = input.fork();
    child = current;
    current.onMessage((reply) => {
      const waiting = settle(reply.id);
      if (waiting === undefined) return;
      if (!("error" in reply)) waiting.resolve(reply.value as never);
      else if (waiting.fallback !== undefined) waiting.resolve(waiting.fallback as never);
      else waiting.reject(new Error(reply.error));
    });
    current.onExit((code) => {
      if (child !== current) return;
      child = null;
      for (const key of pending.keys()) {
        const waiting = settle(key)!;
        if (waiting.fallback !== undefined) waiting.resolve(waiting.fallback as never);
        else waiting.reject(new Error(`voice model process exited (${code})`));
      }
      if (closed) return;
      const listening = opened.length > 0;
      input.onCrash(code, listening && !told);
      if (!listening) return;
      told = true;
      setTimeout(restart, restartMs).unref();
      restartMs = Math.min(restartMs * 2, MAX_RESTART_MS);
    });
  };
  const restart = () => {
    if (closed || child !== null || opened.length === 0) return;
    start();
    const current = child!;
    // The worker answers in order, so scores sent after these wait for the models to load again.
    void Promise.all(
      opened.map((request) =>
        call<number>({ ...request, id: (id += 1) } as OnnxRequest & { readonly id: number }),
      ),
    ).then(
      () =>
        setTimeout(() => {
          if (child === current) restartMs = FIRST_RESTART_MS;
        }, HEALTHY_MS).unref(),
      // A failed reload would leave voice deaf: end this worker so the backoff tries again.
      () => {
        if (child === current) current.kill();
      },
    );
  };

  const call = <T>(request: OnnxRequest & { readonly id: number }, fallback?: T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (child === null) {
        if (fallback !== undefined) return resolve(fallback);
        if (closed) return reject(new Error("voice model process closed"));
        start();
      }
      const current = child!;
      const timer = setTimeout(() => {
        if (child === current) current.kill();
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      pending.set(request.id, {
        resolve: resolve as (value: never) => void,
        reject,
        timer,
        ...(fallback === undefined ? {} : { fallback }),
      });
      current.postMessage(request);
    });
  const open = async (request: OnnxRequest & { readonly id: number }) => {
    const chunkSamples = await call<number>(request);
    const slot = opened.findIndex((r) => r.op === request.op);
    if (slot >= 0) opened.splice(slot, 1);
    opened.push(request);
    return chunkSamples;
  };
  const release = (request: OnnxRequest) => () => {
    const slot = opened.indexOf(request);
    if (slot >= 0) opened.splice(slot, 1);
  };

  return {
    wake: async (paths: OpenWakeWordPaths): Promise<HostedScorer<OpenWakeWordScorer>> => {
      const silent = paths.wakes.map(() => 0);
      const request = { op: "open-wake" as const, id: (id += 1), paths };
      return {
        chunkSamples: await open(request),
        score: (chunk) => call({ op: "wake", id: (id += 1), chunk }, silent),
        reset: () => child?.postMessage({ op: "reset-wake" }),
        close: release(request),
      };
    },
    vad: async (path: string): Promise<HostedScorer<SileroScorer>> => {
      const request = { op: "open-vad" as const, id: (id += 1), path };
      return {
        chunkSamples: await open(request),
        score: (chunk) => call({ op: "vad", id: (id += 1), chunk }, 0),
        reset: () => child?.postMessage({ op: "reset-vad" }),
        close: release(request),
      };
    },
    /** The speaker model (VOICE-ID). While the worker is down every clip is unscored, so the turn is unverified. */
    speaker: async (path: string, model: string): Promise<HostedScorer<SpeakerEmbedder>> => {
      const request = { op: "open-speaker" as const, id: (id += 1), path, model };
      await open(request);
      return {
        model,
        embed: async (pcm) => {
          const value = await call<ReadonlyArray<number> | null>(
            { op: "speaker", id: (id += 1), pcm },
            null,
          );
          return value === null ? null : Float32Array.from(value);
        },
        close: release(request),
      };
    },
    close: () => {
      closed = true;
      child?.kill();
    },
  };
};
