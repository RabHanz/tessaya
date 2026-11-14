// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off globalRandom:off
/**
 * How long the wake and speech models block the thread that loads and feeds them: the five shipped wake words
 * plus Silero are loaded, then fed 10 s of audio at the microphone's pace. Fails above 100 ms. With
 * `--in-process` it measures the old way, the models on this thread, to compare.
 *
 *   node scripts/tessaya/voice-lab/main-block.ts [--in-process] [--models DIR]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { createOnnxHost, type OnnxReply } from "../../../apps/desktop/src/baton/voice/onnxHost.ts";
import {
  createOpenWakeWordProvider,
  createSileroVad,
} from "../../../packages/tessaya-voice/src/providers/onnx.ts";

const LIMIT_MS = 100;
const args = process.argv.slice(2);
const inProcess = args.includes("--in-process");
const root = NodePath.resolve(import.meta.dirname, "../../..");
const models =
  args[args.indexOf("--models") + 1] !== undefined && args.includes("--models")
    ? args[args.indexOf("--models") + 1]!
    : NodePath.join(root, "native/baton-dictation/models");
const at = (file: string) => NodePath.join(models, file);

let worst = 0;
let last = performance.now();
const beat = setInterval(() => {
  const now = performance.now();
  worst = Math.max(worst, now - last - 5);
  last = now;
}, 5);
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const measure = async (name: string, run: () => Promise<void>) => {
  await settle();
  worst = 0;
  last = performance.now();
  await run();
  await settle();
  console.log(`${name}: worst main-thread block ${worst.toFixed(1)} ms`);
  return worst;
};

const host = inProcess
  ? null
  : createOnnxHost({
      fork: () => {
        const child = NodeChildProcess.fork(
          NodePath.join(root, "apps/desktop/src/baton/voice/onnxWorker.ts"),
          { stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "advanced" },
        );
        return {
          postMessage: (request) => child.send(request),
          onMessage: (listener) => child.on("message", (reply) => listener(reply as OnnxReply)),
          onExit: (listener) => child.once("exit", (code) => listener(code ?? -1)),
          kill: () => child.kill(),
        };
      },
      onCrash: (code) => console.log(`worker crashed (${code})`),
    });

let wake: Awaited<ReturnType<typeof createOpenWakeWordProvider>> | undefined;
let vad: Awaited<ReturnType<typeof createSileroVad>> | undefined;
const load = await measure(`load (${inProcess ? "in process" : "worker"})`, async () => {
  wake = await createOpenWakeWordProvider(
    {
      melspectrogram: at("melspectrogram.onnx"),
      embedding: at("embedding_model.onnx"),
      wakes: ["tessaya", "freya", "sebastian", "alfred", "onyx"].map((word) => ({
        word,
        path: at(`${word}.onnx`),
        threshold: 0.5,
      })),
    },
    host?.wake,
  );
  vad = await createSileroVad(at("silero_vad.onnx"), undefined, host?.vad);
});
const feed = await measure("score 10 s of audio", async () => {
  for (let i = 0; i < 125; i++) {
    const frame = new Int16Array(1280).map(() => (Math.random() - 0.5) * 8000);
    wake!.process(frame);
    vad!.isSpeech(frame);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await wake!.drain();
  await vad!.drain();
});
clearInterval(beat);
host?.close();
const worstMs = Math.max(load, feed);
if (worstMs > LIMIT_MS) {
  console.error(`FAIL: the main thread blocked ${worstMs.toFixed(1)} ms (limit ${LIMIT_MS} ms)`);
  process.exit(1);
}
console.log(`ok: under ${LIMIT_MS} ms`);
