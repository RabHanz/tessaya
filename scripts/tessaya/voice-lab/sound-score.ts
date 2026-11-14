// @effect-diagnostics nodeBuiltinImport:off
/**
 * Puts the pill's sounds through the product's own wake scorer and Silero, at normal level and
 * louder, so "the chime cannot wake it" is a measurement. Prints the peak score per sound and gain.
 *   node sound-score.mjs --models native/baton-dictation/models
 */
import {
  renderSound,
  PILL_SOUNDS,
  type PillSound,
} from "../../../apps/desktop/src/baton/voice/pillSounds.ts";
import { createOpenWakeWordScorer } from "../../../packages/tessaya-voice/src/providers/onnx.ts";
import * as Ort from "onnxruntime-node";
import * as NodePath from "node:path";

const models = process.argv[process.argv.indexOf("--models") + 1]!;
const WORDS = ["sebastian", "alfred", "freya", "onyx"];
const RATE = 16_000;
const GAINS = [1, 3, 8];
const REPEATS = 6;

const toPcm = (wave: Float32Array, gain: number): Int16Array => {
  const out = new Int16Array(wave.length);
  wave.forEach((v, i) => (out[i] = Math.max(-1, Math.min(1, v * gain)) * 32767));
  return out;
};

const main = async () => {
  const scorer = await createOpenWakeWordScorer({
    melspectrogram: NodePath.join(models, "melspectrogram.onnx"),
    embedding: NodePath.join(models, "embedding_model.onnx"),
    wakes: WORDS.map((word) => ({
      word,
      path: NodePath.join(models, `${word}.onnx`),
      threshold: 0.5,
    })),
  });
  const silero = await Ort.InferenceSession.create(NodePath.join(models, "silero_vad.onnx"));
  const sileroPeak = async (pcm: Int16Array): Promise<number> => {
    let state = new Float32Array(2 * 128);
    let context = new Float32Array(64);
    let peak = 0;
    for (let at = 0; at + 512 <= pcm.length; at += 512) {
      const x = new Float32Array(576);
      x.set(context);
      for (let i = 0; i < 512; i++) x[64 + i] = pcm[at + i]! / 32768;
      context = x.slice(-64);
      const out = await silero.run({
        input: new Ort.Tensor("float32", x, [1, 576]),
        state: new Ort.Tensor("float32", state, [2, 1, 128]),
        sr: new Ort.Tensor("int64", BigInt64Array.from([16000n]), []),
      });
      state = new Float32Array(out["stateN"]!.data as Float32Array);
      peak = Math.max(peak, (out["output"]!.data as Float32Array)[0] ?? 0);
    }
    return peak;
  };

  for (const name of Object.keys(PILL_SOUNDS) as PillSound[]) {
    const wave = renderSound(PILL_SOUNDS[name], RATE);
    const peakDb = 20 * Math.log10(Math.max(...wave.map(Math.abs)));
    for (const gain of GAINS) {
      const sound = toPcm(wave, gain);
      // A second of silence on each side, then the sound several times, as a lively turn would.
      const clip = new Int16Array(RATE * 2 + REPEATS * (sound.length + RATE / 2));
      for (let i = 0; i < REPEATS; i++) clip.set(sound, RATE + i * (sound.length + RATE / 2));
      scorer.reset();
      const peaks = WORDS.map(() => 0);
      for (let at = 0; at + scorer.chunkSamples <= clip.length; at += scorer.chunkSamples) {
        const scores = await scorer.score(clip.subarray(at, at + scorer.chunkSamples));
        scores.forEach((score, w) => (peaks[w] = Math.max(peaks[w]!, score)));
      }
      const vad = await sileroPeak(clip);
      process.stdout.write(
        `${name} ${(peakDb + 20 * Math.log10(gain)).toFixed(1)} dBFS  ` +
          `${WORDS.map((w, i) => `${w} ${peaks[i]!.toFixed(4)}`).join("  ")}  silero ${vad.toFixed(3)}\n`,
      );
    }
  }
};

void main();
