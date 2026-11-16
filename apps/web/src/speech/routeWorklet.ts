import { PcmResampler } from "./pcmResampler";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** 60 ms frames of 16 kHz mono PCM16LE, the phone route's mic frame, posted while open; no length limit. */
const FRAME = 960;

class RouteCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate);
  private frame = new Int16Array(FRAME);
  private length = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of this.resampler.push(channel)) {
      this.frame[this.length++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      if (this.length === FRAME) {
        const out = this.frame;
        this.frame = new Int16Array(FRAME);
        this.length = 0;
        this.port.postMessage(out.buffer, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("t3-route-capture", RouteCaptureProcessor);
