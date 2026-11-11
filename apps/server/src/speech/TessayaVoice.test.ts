import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { DictationCleanupApi } from "./DictationCleanupApi.ts";
import * as TessayaVoice from "./TessayaVoice.ts";

const HEARD = "um so the build failed on main because the cache was stale again";
const CLEANED = "So the build failed on main because the cache was stale again.";
const DOOR_HEARD = "the desktop heard that the build failed on main because the cache was stale";
const DOOR_CLEANED = "The desktop heard that the build failed on main because the cache was stale.";
/** The model's answer: the dictation it was given, as a sentence. */
const answer = (prompt: string) =>
  prompt.split("<dictation>").at(-1)!.split("</dictation>")[0]!.replace(/\.?$/, ".");
const pcm = new Uint8Array(new Float32Array(1_600).buffer);
const options = {
  ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  speechCustomWords: [{ term: "Tessaya", aliases: ["Tisia"] }],
};

const setup = (input: {
  readonly engine: "tessaya" | "t3";
  readonly door?: string | null;
  readonly key?: boolean;
}) => {
  const base = {
    transcribe: vi.fn(() => Effect.succeed(HEARD)),
    finish: vi.fn(() => HEARD),
  };
  const speech = {
    transcribe: base.transcribe,
    startStream: () =>
      Effect.succeed({
        feed: () => Effect.succeed({ revision: 0, text: null }),
        finish: Effect.sync(base.finish),
      }),
  } as unknown as Parameters<TessayaVoice.TessayaVoice["Service"]["speech"]>[0];
  const door = vi.fn((_: Float32Array) => Effect.succeed(input.door ?? null));
  const cleanup = vi.fn(({ message }: { readonly message: string }) =>
    Effect.succeed(
      input.key === false
        ? ({ configured: false } as const)
        : ({ configured: true, text: answer(message), ms: 1 } as const),
    ),
  );
  const generate = vi.fn(({ prompt }: { readonly prompt: string }) =>
    Effect.succeed({ transcription: answer(prompt) }),
  );
  const layer = Layer.effect(TessayaVoice.TessayaVoice, TessayaVoice.make).pipe(
    Layer.provide(
      Layer.succeed(TessayaVoice.DesktopVoiceDoor, {
        here: input.door !== undefined,
        transcribe: door,
      }),
    ),
    Layer.provide(Layer.mock(DictationCleanupApi)({ cleanup })),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({ generateTranscriptionPostProcessing: generate }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        speechEngine: input.engine,
        speechPostProcessingModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-5-5",
        },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { base, speech, door, cleanup, generate, layer };
};

it.effect("T3 built-in leaves T3's transcript and cleanup alone", () => {
  const t = setup({ engine: "t3", door: DOOR_HEARD });
  return Effect.gen(function* () {
    const voice = yield* TessayaVoice.TessayaVoice;
    expect(yield* voice.speech(t.speech).transcribe(pcm, options)).toBe(HEARD);
    expect(yield* voice.cleansTranscripts).toBe(false);
    expect(t.door).not.toHaveBeenCalled();
    expect(t.cleanup).not.toHaveBeenCalled();
  }).pipe(Effect.provide(t.layer));
});

it.effect("Tessaya voice cleans T3's transcript with his key when no desktop is here", () => {
  const t = setup({ engine: "tessaya" });
  return Effect.gen(function* () {
    const voice = yield* TessayaVoice.TessayaVoice;
    expect(yield* voice.speech(t.speech).transcribe(pcm, options)).toBe(CLEANED);
    expect(yield* voice.cleansTranscripts).toBe(true);
    expect(t.base.transcribe).toHaveBeenCalledOnce();
    expect(t.door).not.toHaveBeenCalled();
    // The desktop's prompt, with his dictionary in it.
    expect(t.cleanup.mock.calls[0]![0]).toMatchObject({
      system: expect.stringContaining("Tessaya"),
      message: expect.stringContaining("<dictation>"),
    });
    expect(t.generate).not.toHaveBeenCalled();
  }).pipe(Effect.provide(t.layer));
});

it.effect("without a key the cleanup goes to the cleanup model on his subscription", () => {
  const t = setup({ engine: "tessaya", key: false });
  return Effect.gen(function* () {
    const voice = yield* TessayaVoice.TessayaVoice;
    expect(yield* voice.speech(t.speech).transcribe(pcm, options)).toBe(CLEANED);
    expect(t.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({ model: "claude-haiku-5-5" }),
      }),
    );
  }).pipe(Effect.provide(t.layer));
});

it.effect("the desktop's recogniser hears it when free, and T3's model when it is busy", () => {
  const free = setup({ engine: "tessaya", door: DOOR_HEARD });
  const busy = setup({ engine: "tessaya", door: null });
  return Effect.gen(function* () {
    const fromFree = yield* TessayaVoice.TessayaVoice.pipe(
      Effect.flatMap((voice) => voice.speech(free.speech).transcribe(pcm, options)),
      Effect.provide(free.layer),
    );
    expect(fromFree).toBe(DOOR_CLEANED);
    expect(free.door.mock.calls[0]![0]).toHaveLength(1_600);
    expect(free.base.transcribe).not.toHaveBeenCalled();

    const fromBusy = yield* TessayaVoice.TessayaVoice.pipe(
      Effect.flatMap((voice) => voice.speech(busy.speech).transcribe(pcm, options)),
      Effect.provide(busy.layer),
    );
    expect(fromBusy).toBe(CLEANED);
    expect(busy.door).toHaveBeenCalledOnce();
    expect(busy.base.transcribe).toHaveBeenCalledOnce();
  });
});

it.effect("a live stream ends on the desktop's text, or on T3's when the desktop cannot", () => {
  const free = setup({ engine: "tessaya", door: DOOR_HEARD });
  const busy = setup({ engine: "tessaya", door: null });
  const finish = (t: ReturnType<typeof setup>) =>
    Effect.gen(function* () {
      const voice = yield* TessayaVoice.TessayaVoice;
      const stream = yield* voice.speech(t.speech).startStream(options);
      yield* stream.feed(pcm.slice(0, 3_200));
      yield* stream.feed(pcm.slice(3_200));
      return yield* stream.finish;
    }).pipe(Effect.scoped, Effect.provide(t.layer));
  return Effect.gen(function* () {
    expect(yield* finish(free)).toBe(DOOR_CLEANED);
    expect(free.door.mock.calls[0]![0]).toHaveLength(1_600);
    expect(free.base.finish).not.toHaveBeenCalled();
    expect(yield* finish(busy)).toBe(CLEANED);
    expect(busy.base.finish).toHaveBeenCalledOnce();
  });
});
