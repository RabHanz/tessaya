// @effect-diagnostics nodeBuiltinImport:off - the desktop's door is a local socket or pipe, which fetch cannot reach.
/**
 * Tessaya's voice for clients that send audio here (web, the phone, remote): the desktop's own recogniser when this
 * server runs inside the desktop app and it is free, T3's model otherwise, then the desktop's cleanup chain
 * (`@t3tools/baton-shared/dictationCleanup`) on the text. "T3 built-in" (`speechEngine: "t3"`) leaves T3's path as it is.
 */
import * as NodeHttp from "node:http";

import type { SpeechCustomWords, SpeechTranscriptionOptions } from "@t3tools/contracts";
import {
  cleanDictation,
  rewriteMessage,
  rewriteSystemPrompt,
  type DictionaryEntry,
} from "@t3tools/baton-shared/dictationCleanup";
import { biasTranscript } from "@t3tools/baton-shared/vocabulary";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { DictationCleanupApi } from "./DictationCleanupApi.ts";
import { decodeSpeechPcm, type SpeechService } from "./SpeechService.ts";

type Speech = Pick<SpeechService["Service"], "transcribe" | "startStream">;

/** T3's dictionary as Tessaya's: each term spelt his way, with the forms it is heard as. */
const dictionaryFrom = (words: SpeechCustomWords): ReadonlyArray<DictionaryEntry> => {
  const seen = new Set<string>();
  return words.flatMap(({ term, aliases }) => {
    const key = term.trim().toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ phrase: term, replacement: null, heard: aliases }];
  });
};

/** The desktop's pass on one transcript: his names put back, the rules, then the model when something is left. */
const tessayaClean = async (
  raw: string,
  dictionary: ReadonlyArray<DictionaryEntry>,
  ask: (system: string, message: string, maxTokens: number) => Promise<string>,
) =>
  cleanDictation({
    raw: biasTranscript(raw, dictionary),
    mode: "default",
    level: "claude",
    dictionary,
    ask: (text, mode) =>
      ask(
        rewriteSystemPrompt(dictionary),
        rewriteMessage(text, mode),
        64 + Math.ceil(text.length / 2),
      ),
  });

/** The desktop app's recogniser (its GPU sidecar), reached through the door it names to its own server. */
export class DesktopVoiceDoor extends Context.Service<
  DesktopVoiceDoor,
  {
    /** This server runs inside the desktop app, which named its door. */
    readonly here: boolean;
    /** Its text, or null when there is no desktop here, it is busy with a dictation of its own, or it failed. */
    readonly transcribe: (pcm: Float32Array) => Effect.Effect<string | null>;
  }
>()("t3/speech/TessayaVoice/DesktopVoiceDoor") {}

const askDoor = (path: string, token: string, pcm: Float32Array) =>
  new Promise<string | null>((resolve) => {
    const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const request = NodeHttp.request(
      {
        socketPath: path,
        path: "/transcribe",
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-length": body.byteLength },
        // A cold model loads in a few seconds; past this T3's model is quicker.
        timeout: Math.min(30_000, 4_000 + pcm.length / 64),
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            const text = (JSON.parse(Buffer.concat(parts).toString("utf8")) as { text?: unknown })
              .text;
            resolve(typeof text === "string" ? text : null);
          } catch {
            resolve(null);
          }
        });
        response.on("error", () => resolve(null));
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end(body);
  });

const doorLayer = Layer.sync(DesktopVoiceDoor, () => {
  const path = process.env["TESSAYA_VOICE_DOOR"];
  const token = process.env["TESSAYA_VOICE_DOOR_TOKEN"];
  return DesktopVoiceDoor.of({
    here: Boolean(path && token),
    transcribe: Effect.fn("DesktopVoiceDoor.transcribe")(function* (pcm: Float32Array) {
      if (!path || !token) return null;
      return yield* Effect.promise(() => askDoor(path, token, pcm));
    }),
  });
});

export class TessayaVoice extends Context.Service<
  TessayaVoice,
  {
    /** T3's speech service with Tessaya's recogniser and cleanup in front, while Tessaya voice is chosen here. */
    readonly speech: (base: Speech) => Speech;
    /** The transcript already came back cleaned, so the client's separate cleanup must not run again. */
    readonly cleansTranscripts: Effect.Effect<boolean>;
  }
>()("t3/speech/TessayaVoice") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const cleanupApi = yield* DictationCleanupApi;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const door = yield* DesktopVoiceDoor;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());

  const on = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.speechEngine === "tessaya"),
    Effect.orElseSucceed(() => false),
  );

  // His own key when one is saved (the fastest Haiku), else the cleanup model on his subscription, as T3's cleanup.
  const ask = Effect.fn("TessayaVoice.ask")(
    function* (system: string, message: string, maxTokens: number) {
      const viaKey = yield* cleanupApi
        .cleanup({ system, message, maxTokens })
        .pipe(Effect.orElseSucceed(() => ({ configured: false }) as const));
      if (viaKey.configured) return viaKey.text;
      const settings = yield* settingsService.getSettings;
      // Providers run in a working directory; cleanup must not read a checkout.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-cleanup-" });
      const generated = yield* textGeneration.generateTranscriptionPostProcessing({
        cwd,
        prompt: `${system}\n\n${message}`,
        modelSelection: resolveSpeechPostProcessingModelSelection(settings),
      });
      return generated.transcription;
    },
    Effect.scoped,
    Effect.timeout("20 seconds"),
  );

  const clean = Effect.fn("TessayaVoice.clean")(function* (
    raw: string,
    options: SpeechTranscriptionOptions,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    const shared = settings._tag === "Some" ? settings.value.speechProjectCustomWords : [];
    const dictionary = dictionaryFrom([...options.speechCustomWords, ...shared]);
    const cleaned = yield* Effect.tryPromise({
      try: () =>
        tessayaClean(raw, dictionary, (system, message, maxTokens) =>
          run(ask(system, message, maxTokens)),
        ),
      catch: () => "unclean" as const,
    }).pipe(Effect.orElseSucceed(() => ({ text: raw })));
    return cleaned.text.trim();
  });

  // The desktop cannot translate; a recording to translate stays on T3's model.
  const viaDesktop = (options: SpeechTranscriptionOptions, pcm: () => Float32Array) =>
    !door.here || options.speechTranslateToEnglish
      ? Effect.succeed(null)
      : Effect.try({ try: pcm, catch: () => "invalid" as const }).pipe(
          Effect.flatMap(door.transcribe),
          Effect.orElseSucceed(() => null),
        );

  return TessayaVoice.of({
    cleansTranscripts: on,
    speech: (base) => ({
      transcribe: Effect.fn("TessayaVoice.transcribe")(function* (pcmBytes, options) {
        if (!(yield* on)) return yield* base.transcribe(pcmBytes, options);
        const heard =
          (yield* viaDesktop(options, () => decodeSpeechPcm(pcmBytes))) ??
          (yield* base.transcribe(pcmBytes, options));
        return yield* clean(heard, options);
      }),
      startStream: Effect.fn("TessayaVoice.startStream")(function* (options) {
        const stream = yield* base.startStream(options);
        if (!(yield* on)) return stream;
        const chunks: Uint8Array[] = [];
        return {
          feed: (bytes) => {
            // A copy: a socket frame can be a view of a pooled Buffer.
            if (door.here) chunks.push(new Uint8Array(bytes));
            return stream.feed(bytes);
          },
          // T3's live words show while he speaks; the final text is the desktop's when it is free.
          finish: Effect.gen(function* () {
            const heard =
              (yield* viaDesktop(options, () => {
                const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
                let at = 0;
                for (const chunk of chunks) {
                  all.set(chunk, at);
                  at += chunk.byteLength;
                }
                return decodeSpeechPcm(all);
              })) ?? (yield* stream.finish);
            return yield* clean(heard, options);
          }),
        };
      }),
    }),
  });
});

export const layer = Layer.effect(TessayaVoice, make).pipe(Layer.provide(doorLayer));
