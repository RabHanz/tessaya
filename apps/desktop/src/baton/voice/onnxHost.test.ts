import { assert, it, vi } from "vite-plus/test";

import {
  createOnnxHost,
  REQUEST_TIMEOUT_MS,
  serveOnnx,
  type OnnxChild,
  type OnnxReply,
} from "./onnxHost.ts";

const paths = {
  melspectrogram: "mel.onnx",
  embedding: "embed.onnx",
  wakes: [{ word: "tessaya", path: "tessaya.onnx", threshold: 0.5 }],
};

interface FakeChild {
  readonly exit: (code: number) => void;
  readonly opened: string[];
  /** Stops answering, like a worker stuck inside a native call. */
  hung: boolean;
}

/** Children that answer through the real request loop, with scorers that need no models. */
const fakeChildren = (failsToLoad: (n: number) => boolean = () => false) => {
  const children: FakeChild[] = [];
  const fork = (): OnnxChild => {
    const listeners: Array<(reply: OnnxReply) => void> = [];
    const exits: Array<(code: number) => void> = [];
    let alive = true;
    const fails = failsToLoad(children.length);
    const me: FakeChild = {
      opened: [],
      hung: false,
      exit: (code) => {
        if (!alive) return;
        alive = false;
        for (const exit of exits) exit(code);
      },
    };
    const load = (kind: string) => {
      if (fails) throw new Error(`cannot load ${kind}`);
      me.opened.push(kind);
    };
    const handle = serveOnnx(
      (reply) => {
        if (alive && !me.hung) for (const listener of listeners) listener(reply);
      },
      {
        wake: async () => {
          load("wake");
          return { chunkSamples: 1280, score: async () => [0.9], reset: () => undefined };
        },
        vad: async () => {
          load("vad");
          return { chunkSamples: 512, score: async () => 0.8, reset: () => undefined };
        },
        speaker: async (_path: string, model: string) => {
          load("speaker");
          return { model, embed: async () => Float32Array.from([0.6, 0.8]) };
        },
      },
    );
    children.push(me);
    return {
      postMessage: (request) => {
        if (alive) handle(request);
      },
      onMessage: (listener) => listeners.push(listener),
      onExit: (listener) => exits.push(listener),
      kill: () => me.exit(-15),
    };
  };
  return { children, fork };
};

const listening = async (failsToLoad?: (n: number) => boolean) => {
  vi.useFakeTimers();
  const { children, fork } = fakeChildren(failsToLoad);
  const crashes: Array<[number, boolean]> = [];
  const host = createOnnxHost({ fork, onCrash: (code, speak) => crashes.push([code, speak]) });
  const wake = await host.wake(paths);
  const vad = await host.vad("silero.onnx");
  return { children, crashes, host, wake, vad };
};

it("scores through the worker, hears nothing while it is down, and reloads the models after a crash", async () => {
  const { children, crashes, host, wake, vad } = await listening();
  assert.deepEqual(await wake.score(new Int16Array(1280)), [0.9]);
  assert.equal(await vad.score(new Int16Array(512)), 0.8);

  // In flight when the worker dies: answered as silence, never rejected (a rejection stops the provider's queue).
  const inFlight = wake.score(new Int16Array(1280));
  children[0]!.exit(1);
  assert.deepEqual(await inFlight, [0]);
  assert.equal(await vad.score(new Int16Array(512)), 0);

  await vi.advanceTimersByTimeAsync(1_000);
  assert.lengthOf(children, 2);
  assert.deepEqual(await wake.score(new Int16Array(1280)), [0.9]);
  assert.deepEqual(children[1]!.opened, ["wake", "vad"]);

  // Every exit is logged; only the first is spoken. The next restart waits longer.
  children[1]!.exit(2);
  assert.deepEqual(crashes, [
    [1, true],
    [2, false],
  ]);
  await vi.advanceTimersByTimeAsync(1_999);
  assert.lengthOf(children, 2);
  await vi.advanceTimersByTimeAsync(1);
  assert.lengthOf(children, 3);
  assert.equal(await vad.score(new Int16Array(512)), 0.8);
  vi.useRealTimers();
  host.close();
});

it("starts the backoff again once a restarted worker has stayed up", async () => {
  const { children, host } = await listening();
  children[0]!.exit(1);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(60_000);
  children[1]!.exit(1);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.lengthOf(children, 3);
  vi.useRealTimers();
  host.close();
});

it("ends a worker whose models fail to reload, so the next restart tries again", async () => {
  const { children, host, wake } = await listening((n) => n === 1);
  children[0]!.exit(1);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.lengthOf(children, 2);
  await vi.advanceTimersByTimeAsync(2_000);
  assert.lengthOf(children, 3);
  assert.deepEqual(await wake.score(new Int16Array(1280)), [0.9]);
  vi.useRealTimers();
  host.close();
});

it("restarts a worker that stops answering", async () => {
  const { children, host, wake } = await listening();
  children[0]!.hung = true;
  let heard: ReadonlyArray<number> | null = null;
  void wake.score(new Int16Array(1280)).then((value) => (heard = value));
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  assert.deepEqual(heard, [0]);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.deepEqual(await wake.score(new Int16Array(1280)), [0.9]);
  vi.useRealTimers();
  host.close();
});

it("with voice off, a crash is logged but neither spoken nor reloaded", async () => {
  const { children, crashes, host, wake, vad } = await listening();
  wake.close();
  vad.close();
  children[0]!.exit(1);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.lengthOf(children, 1);
  assert.deepEqual(crashes, [[1, false]]);
  vi.useRealTimers();
  host.close();
});

it("fails the first load, so voice reports it instead of listening to nothing", async () => {
  const crashes: Array<[number, boolean]> = [];
  const host = createOnnxHost({
    fork: () => ({
      postMessage: () => undefined,
      onMessage: () => undefined,
      onExit: (listener) => queueMicrotask(() => listener(3)),
      kill: () => undefined,
    }),
    onCrash: (code, speak) => crashes.push([code, speak]),
  });
  let error: unknown = null;
  await host.wake(paths).catch((e: unknown) => (error = e));
  assert.match(String(error), /exited \(3\)/);
  assert.deepEqual(crashes, [[3, false]]);
});

it("embeds a voice through the worker, and gives no vector while it is down, so the turn is unverified", async () => {
  const { children, host } = await listening();
  const speaker = await host.speaker("campplus.onnx", "m");
  assert.deepEqual(Array.from((await speaker.embed(new Int16Array(32_000)))!), [
    Float32Array.from([0.6])[0],
    Float32Array.from([0.8])[0],
  ]);
  children[0]!.exit(1);
  assert.isNull(await speaker.embed(new Int16Array(32_000)));
  await vi.advanceTimersByTimeAsync(1_000);
  assert.include(children[1]!.opened, "speaker");
  host.close();
});
