// @effect-diagnostics nodeBuiltinImport:off
/**
 * SenseVoice-Small (sherpa-onnx int8 export): how he sounds (an emotion tag, laughter or coughs); Parakeet writes the
 * words. FunASR model licence, not MIT: personal use only. Front end as sherpa-onnx feeds it: Kaldi fbank (Hamming,
 * no mean subtraction), 7-every-6 frame stacking, then the CMVN from the model's metadata.
 */
import * as NodeFS from "node:fs";

import type * as Ort from "onnxruntime-node";

import { fbank } from "../fbank.ts";

const MEL = 80;
/** Past 30 s says nothing new about the mood, and costs time. */
const MAX_SAMPLES = 30 * 16_000;

export const EMOTIONS = [
  "HAPPY",
  "SAD",
  "ANGRY",
  "NEUTRAL",
  "FEARFUL",
  "DISGUSTED",
  "SURPRISED",
] as const;
export type Emotion = Lowercase<(typeof EMOTIONS)[number]> | "unknown";

export interface Affect {
  readonly emotion: Emotion;
  /** Audio events other than plain speech, lower-case ("laughter", "cough"...). */
  readonly events: ReadonlyArray<string>;
  readonly language: string;
  readonly text: string;
}

/**
 * The ONNX model's string metadata (`metadata_props`), read from the file's tail, where the exporter writes it:
 * onnxruntime-node does not expose custom metadata.
 */
export const readOnnxMetadata = (
  path: string,
  keys: ReadonlyArray<string>,
): Record<string, string> => {
  const fd = NodeFS.openSync(path, "r");
  try {
    const size = NodeFS.fstatSync(fd).size;
    const length = Math.min(size, 256 * 1024);
    const tail = Buffer.alloc(length);
    NodeFS.readSync(fd, tail, 0, length, size - length);
    const out: Record<string, string> = {};
    for (const key of keys) {
      // StringStringEntryProto: field 1 (key) then field 2 (value, tag 0x12) with a varint length.
      const at = tail.lastIndexOf(Buffer.from(key, "utf8"));
      let i = at + Buffer.byteLength(key);
      if (at < 0 || tail[i] !== 0x12) continue;
      i += 1;
      let len = 0;
      for (let shift = 0; ; shift += 7) {
        const b = tail[i++]!;
        len |= (b & 0x7f) << shift;
        if (b < 0x80) break;
      }
      out[key] = tail.subarray(i, i + len).toString("utf8");
    }
    return out;
  } finally {
    NodeFS.closeSync(fd);
  }
};

/** FunASR's apply_lfr: stack `m` frames every `n`, the first frame repeated (m-1)/2 times in front, the last at the end. */
export const lowFrameRate = (
  data: Float32Array,
  frames: number,
  m: number,
  n: number,
): { readonly frames: number; readonly data: Float32Array } => {
  const left = (m - 1) / 2;
  const total = frames + left;
  const out = Math.ceil(frames / n);
  const result = new Float32Array(out * m * MEL);
  const row = (j: number) => Math.min(Math.max(j - left, 0), frames - 1);
  for (let i = 0; i < out; i += 1)
    for (let k = 0; k < m; k += 1) {
      const src = row(Math.min(i * n + k, total - 1));
      result.set(data.subarray(src * MEL, src * MEL + MEL), (i * m + k) * MEL);
    }
  return { frames: out, data: result };
};

export interface SenseVoice {
  readonly analyse: (pcm: Int16Array) => Promise<Affect>;
}

export const createSenseVoice = async (input: {
  readonly modelPath: string;
  readonly tokensPath: string;
  readonly threads?: number;
}): Promise<SenseVoice> => {
  const ort: typeof Ort = await import("onnxruntime-node");
  const meta = readOnnxMetadata(input.modelPath, [
    "lfr_window_size",
    "lfr_window_shift",
    "neg_mean",
    "inv_stddev",
    "lang_auto",
    "without_itn",
  ]);
  const negMean = Float32Array.from((meta["neg_mean"] ?? "").split(",").map(Number));
  const invStd = Float32Array.from((meta["inv_stddev"] ?? "").split(",").map(Number));
  const m = Number(meta["lfr_window_size"]);
  const n = Number(meta["lfr_window_shift"]);
  if (negMean.length !== m * MEL || invStd.length !== m * MEL || !(m > 0 && n > 0))
    throw new Error("SenseVoice: the model's front-end metadata is missing or malformed.");
  const tokens: string[] = [];
  for (const line of NodeFS.readFileSync(input.tokensPath, "utf8").split("\n")) {
    const cut = line.lastIndexOf(" ");
    if (cut > 0) tokens[Number(line.slice(cut + 1))] = line.slice(0, cut);
  }
  const session = await ort.InferenceSession.create(input.modelPath, {
    intraOpNumThreads: input.threads ?? 2,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });
  const tag = (id: number) => /^<\|(.+)\|>$/.exec(tokens[id] ?? "")?.[1] ?? "";
  return {
    analyse: async (pcm) => {
      const bank = fbank(pcm.subarray(0, MAX_SAMPLES), { window: "hamming", subtractMean: false });
      if (bank.frames === 0) return { emotion: "unknown", events: [], language: "", text: "" };
      const lfr = lowFrameRate(bank.data, bank.frames, m, n);
      const width = m * MEL;
      for (let i = 0; i < lfr.data.length; i += 1)
        lfr.data[i] = (lfr.data[i]! + negMean[i % width]!) * invStd[i % width]!;
      const out = await session.run({
        x: new ort.Tensor("float32", lfr.data, [1, lfr.frames, width]),
        x_length: new ort.Tensor("int32", Int32Array.from([lfr.frames]), [1]),
        language: new ort.Tensor("int32", Int32Array.from([Number(meta["lang_auto"] ?? 0)]), [1]),
        text_norm: new ort.Tensor(
          "int32",
          Int32Array.from([Number(meta["without_itn"] ?? 15)]),
          [1],
        ),
      });
      const logits = out["logits"]!;
      const [, steps, vocab] = logits.dims as [number, number, number];
      const data = logits.data as Float32Array;
      const best = Array.from({ length: steps }, (_, t) => {
        let id = 0;
        for (let v = 1; v < vocab; v += 1) if (data[t * vocab + v]! > data[t * vocab + id]!) id = v;
        return id;
      });
      // The first four steps are tags: language, emotion, event, text norm. Then CTC (0 is blank).
      const emotionTag = tag(best[1] ?? 0);
      const event = tag(best[2] ?? 0);
      let text = "";
      for (let t = 4, prev = -1; t < steps; t += 1) {
        const id = best[t]!;
        if (id !== 0 && id !== prev) text += tokens[id] ?? "";
        prev = id;
      }
      return {
        emotion: (EMOTIONS as ReadonlyArray<string>).includes(emotionTag)
          ? (emotionTag.toLowerCase() as Emotion)
          : "unknown",
        events: event === "" || event === "Speech" ? [] : [event.toLowerCase()],
        language: tag(best[0] ?? 0),
        text: text.replaceAll("▁", " ").trim(),
      };
    },
  };
};
