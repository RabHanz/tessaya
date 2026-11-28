/**
 * The phone page's push-to-talk, server side: its 16 kHz WAV goes through the server's one SpeechService, the
 * recogniser, dictionary and model every other client of this server is heard with.
 */
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { SpeechService } from "../speech/SpeechService.ts";

export const NOT_AVAILABLE =
  "Voice is not available on this server: it has no speech model here. Type instead.";

export type Transcription =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly why: string };

/** A checked 16 kHz mono 16-bit WAV (`checkWav`) as the Float32 PCM bytes SpeechService takes. */
export const wavToSpeechPcm = (wav: Uint8Array): Uint8Array => {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  while (at + 8 <= wav.byteLength) {
    const size = view.getUint32(at + 4, true);
    if (String.fromCharCode(...wav.subarray(at, at + 4)) === "data") {
      const end = Math.min(wav.byteLength, at + 8 + size);
      const pcm = new Float32Array(Math.floor((end - at - 8) / 2));
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(at + 8 + i * 2, true) / 32768;
      return new Uint8Array(pcm.buffer);
    }
    at += 8 + size + (size % 2);
  }
  return new Uint8Array();
};

export const transcribeWav = (
  speech: SpeechService["Service"] | undefined,
  wav: Uint8Array,
): Effect.Effect<Transcription> => {
  const pcm = wavToSpeechPcm(wav);
  if (speech === undefined) return Effect.succeed({ ok: false, why: NOT_AVAILABLE });
  if (pcm.byteLength === 0)
    return Effect.succeed({ ok: false, why: "I could not hear anything in that." });
  return speech.transcribe(pcm, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(
    Effect.map((text): Transcription =>
      text.trim() === ""
        ? { ok: false, why: "I could not hear anything in that." }
        : { ok: true, text: text.trim() },
    ),
    Effect.catchTags({
      SpeechModelNotFoundError: () => Effect.succeed({ ok: false, why: NOT_AVAILABLE } as const),
      SpeechUnsupportedPlatformError: () =>
        Effect.succeed({ ok: false, why: NOT_AVAILABLE } as const),
      SpeechBusyError: () =>
        Effect.succeed({
          ok: false,
          why: "Still working on the last recording. Try again in a moment.",
        } as const),
    }),
    Effect.orElseSucceed((): Transcription => ({
      ok: false,
      why: "The speech model did not answer. Try again, or type.",
    })),
  );
};
