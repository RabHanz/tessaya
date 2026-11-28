import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  SpeechBusyError,
  SpeechModelNotFoundError,
  type SpeechService,
} from "../speech/SpeechService.ts";
import { NOT_AVAILABLE, transcribeWav, wavToSpeechPcm } from "./TessayaPhoneVoice.ts";

const wavOf = (samples: ReadonlyArray<number>) => {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(
    [..."RIFF"].map((c) => c.charCodeAt(0)),
    0,
  );
  bytes.set(
    [..."WAVEfmt "].map((c) => c.charCodeAt(0)),
    8,
  );
  view.setUint32(16, 16, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint16(34, 16, true);
  bytes.set(
    [..."data"].map((c) => c.charCodeAt(0)),
    36,
  );
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true));
  return bytes;
};

const speechThat = (transcribe: SpeechService["Service"]["transcribe"]) =>
  ({ transcribe }) as unknown as SpeechService["Service"];

describe("the phone page's push-to-talk", () => {
  it("hands SpeechService the WAV's samples as Float32 PCM", () => {
    const pcm = new Float32Array(wavToSpeechPcm(wavOf([0, 16384, -32768])).buffer);
    expect([...pcm]).toEqual([0, 0.5, -1]);
  });

  it.effect("returns what the server's one recogniser heard", () =>
    Effect.gen(function* () {
      let bytes = 0;
      const out = yield* transcribeWav(
        speechThat((pcm) => {
          bytes = pcm.byteLength;
          return Effect.succeed(" approve the plan ");
        }),
        wavOf([1, 2]),
      );
      expect(out).toEqual({ ok: true, text: "approve the plan" });
      expect(bytes).toBe(8);
    }),
  );

  it.effect("says plainly when the server has no model, is busy, or heard nothing", () =>
    Effect.gen(function* () {
      const run = (speech: SpeechService["Service"] | undefined) =>
        transcribeWav(speech, wavOf([1]));
      expect(yield* run(undefined)).toEqual({ ok: false, why: NOT_AVAILABLE });
      expect(
        yield* run(speechThat(() => Effect.fail(new SpeechModelNotFoundError({ modelId: "m" })))),
      ).toEqual({ ok: false, why: NOT_AVAILABLE });
      expect(
        yield* run(speechThat(() => Effect.fail(new SpeechBusyError({ operation: "x" })))),
      ).toMatchObject({ ok: false, why: expect.stringContaining("Still working") });
      expect(yield* run(speechThat(() => Effect.succeed("  ")))).toMatchObject({
        ok: false,
        why: "I could not hear anything in that.",
      });
    }),
  );
});
