/**
 * Speex's echo canceller (MDF, speexdsp 1.2.1) and its residual echo suppression, compiled to wasm: her playback is the
 * reference and what comes out is the mic with her echo taken away, so neither the recogniser nor Voice ID hears her.
 * 16 kHz mono s16, in 20 ms frames.
 */
import { SPEEX_AEC_WASM } from "./speexAecWasm.ts";

const FRAME = 320; // 20 ms
const RATE = 16_000;

export interface EchoCancelOptions {
  /** Echo tail the filter models, in ms (alignment slack plus the room). */
  readonly tailMs?: number;
  /** Residual echo cut, in dB (negative); 0 turns the suppressor off and leaves only the linear canceller. */
  readonly suppressDb?: number;
  /** The same while someone talks over her. */
  readonly suppressActiveDb?: number;
  /** At most this much of the room's steady noise is taken away (the suppressor needs its noise estimate). */
  readonly noiseDb?: number;
}

export interface EchoCanceller {
  /** Mic and the reference that was under the speaker as each mic sample was heard; returns the cleaned mic. */
  readonly process: (mic: Int16Array, ref: Int16Array) => Int16Array;
  /** The echo path changed (another output, a long gap): learn it again. */
  readonly reset: () => void;
}

interface Exports {
  readonly memory: WebAssembly.Memory;
  readonly _initialize: () => void;
  readonly aec_create: (
    frame: number,
    filter: number,
    rate: number,
    suppress: number,
    active: number,
    noise: number,
  ) => number;
  readonly aec_buf: (bytes: number) => number;
  readonly aec_process: (st: number, mic: number, ref: number, out: number) => void;
  readonly aec_reset: (st: number) => void;
}

let compiled: WebAssembly.Module | null = null;

export const createEchoCanceller = (options: EchoCancelOptions = {}): EchoCanceller => {
  compiled ??= new WebAssembly.Module(Buffer.from(SPEEX_AEC_WASM, "base64"));
  // One instance per canceller: speex keeps its state in the instance's memory.
  const wasm = new WebAssembly.Instance(compiled, {
    wasi_snapshot_preview1: {
      // Only its allocator's hardening asks; speex itself is deterministic.
      random_get: (ptr: number, len: number) => {
        new Uint8Array(wasm.exports.memory.buffer, ptr, len).fill(7);
        return 0;
      },
    },
  }) as unknown as { readonly exports: Exports };
  const x = wasm.exports;
  x._initialize();
  const tail = Math.round((((options.tailMs ?? 400) * RATE) / 1000 / FRAME) * FRAME);
  const st = x.aec_create(
    FRAME,
    tail,
    RATE,
    Math.round(options.suppressDb ?? -40),
    Math.round(options.suppressActiveDb ?? -15),
    Math.round(options.noiseDb ?? -6),
  );
  const micAt = x.aec_buf(FRAME * 2);
  const refAt = x.aec_buf(FRAME * 2);
  const outAt = x.aec_buf(FRAME * 2);
  // Frames left in which her echo may still arrive; outside them the mic passes as heard, since the suppressor's noise
  // cut would otherwise reshape his voice for Voice ID and the recogniser (it still runs, to keep its estimates).
  const ringFrames = Math.ceil(tail / FRAME) + 5;
  let echoLeft = 0;
  return {
    process: (mic, ref) => {
      const out = mic.slice();
      // shortcut: a tail shorter than 20 ms passes through as heard; R1 uplink frames are 60 ms, so none has one.
      for (let at = 0; at + FRAME <= mic.length; at += FRAME) {
        const heap = new Int16Array(x.memory.buffer);
        heap.set(mic.subarray(at, at + FRAME), micAt >> 1);
        heap.set(ref.subarray(at, at + FRAME), refAt >> 1);
        x.aec_process(st, micAt, refAt, outAt);
        let peak = 0;
        for (let i = at; i < at + FRAME; i += 1) peak = Math.max(peak, Math.abs(ref[i]!));
        echoLeft = peak > 64 ? ringFrames : Math.max(0, echoLeft - 1);
        if (echoLeft > 0) out.set(new Int16Array(x.memory.buffer, outAt, FRAME), at);
      }
      return out;
    },
    reset: () => x.aec_reset(st),
  };
};
