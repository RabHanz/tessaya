// @effect-diagnostics globalFetch:off nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off
/**
 * The voice library this environment serves to every client: voices, each persona's choice (in his pack file), and
 * previews cached under `<userdata>/voice/previews`. Pocket previews reuse the desktop's files in `<userdata>/voice/pocket`,
 * one run at a time; a server without them says so.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import {
  BATON_VOICE_ACT_OPS,
  BATON_VOICE_OWNER_OPS,
  BATON_VOICE_READ_OPS,
  type CloneResult,
  type TessayaVoiceCallInput,
  VocabularyChange,
  type TessayaVoiceCallResult,
  type LibraryVoiceView,
  SavedCloneView,
  type VoiceClip,
  type VoiceLibraryView,
} from "@t3tools/tessaya-contracts";
import { cloneGrant, stands } from "@t3tools/tessaya-shared/consent";
import { isLineEvent } from "@t3tools/tessaya-shared/expression";
import { setPersonaField } from "@t3tools/tessaya-shared/personaFile";
import { pronounce } from "@t3tools/tessaya-shared/pronounce";
import {
  commercialBuild,
  isLibraryVoice,
  LICENCE_LABELS,
  POCKET_VOICE_FILES,
  pocketVoiceUrl,
  PREVIEW_LINE,
  resolvePersonaVoice,
  voiceLibrary,
  type LibraryVoice,
} from "@t3tools/tessaya-shared/voiceLibrary";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { fbank } from "@t3tools/tessaya-voice/fbank";
import { CAMPLUS_POLICY, cosine, unitOrNull } from "@t3tools/tessaya-voice/speaker";
import type * as Ort from "onnxruntime-node";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { BrainUsage, type CallTokens } from "./BrainUsage.ts";
import * as ServerConfig from "../config.ts";
import { serveArbiter } from "../home/VoiceArbiter.ts";
import { Consent, readGrants, setGrant } from "./consent.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { TessayaExpression } from "./TessayaExpression.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { TessayaVocabulary } from "./TessayaVocabulary.ts";
import {
  cloneClean,
  CLONE_MIN_SECONDS,
  type CloneClean,
  cloneClipProblem,
  isNearSilence,
  markSynthetic,
  type Pcm,
  readWav,
  resample,
  writeWav,
} from "./voiceClip.ts";

export const GOOGLE_KEY_SECRET = "google-api-key";
/** A Hugging Face read token: Kyutai gates the voice-cloning weights behind accepting their terms. */
export const HF_TOKEN_SECRET = "huggingface-token";
/** Kyutai's English model with its cloning weights (gated); the installed tokenizer and config fit it as they are. */
const CLONE_WEIGHTS = {
  url: "https://huggingface.co/kyutai/pocket-tts/resolve/db04f0e653473e5c7333c69686ac92b7460b0c1d/languages/english/model.safetensors",
  size: 219_029_196,
  sha256: "bc96b82436c5ec00d3118ef3b01bc3358423e1766ecae3dca0aeea84789e7d74",
};
// shortcut: the desktop's SPEAKER_MODEL file name (voiceModels.ts); move it to tessaya-shared if a third reader appears.
const SPEAKER_MODEL_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
/** How a clone's reference and lines are cleaned; a better pipeline is provided here, not edited into cloneVoice. */
export const CloneCleanStep = Context.Reference<CloneClean>("t3/tessaya/CloneCleanStep", {
  defaultValue: () => cloneClean(deepFilter),
});
const CLONE_ID = /^(test-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.8-flash-tts";
const SAY_MAX = 600;

export class VoiceRefusedError extends Schema.TaggedError<VoiceRefusedError>()(
  "VoiceRefusedError",
  { why: Schema.String },
) {
  override get message(): string {
    return this.why;
  }
}

/** A clip from the cache, or made once and kept there; a failed make leaves nothing behind. */
export const cachedClip = async (file: string, make: () => Promise<Buffer>): Promise<Buffer> => {
  try {
    return await NodeFS.promises.readFile(file);
  } catch {
    // not made yet
  }
  const bytes = await make();
  await NodeFS.promises.mkdir(NodePath.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  await NodeFS.promises.writeFile(part, bytes);
  await NodeFS.promises.rename(part, file);
  return bytes;
};

const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Where the desktop app keeps Pocket: its program under `bin/<release>/`, the English model under `english/`. */
export const pocketFiles = (root: string) => {
  let binary: string | null = null;
  try {
    for (const release of NodeFS.readdirSync(NodePath.join(root, "bin"))) {
      for (const name of ["pocket-tts.exe", "pocket-tts"]) {
        const file = NodePath.join(root, "bin", release, name);
        if (binary === null && NodeFS.existsSync(file)) binary = file;
      }
    }
  } catch {
    // no program here
  }
  const english = NodePath.join(root, "english");
  const config = NodePath.join(english, "config.yaml");
  return binary !== null &&
    NodeFS.existsSync(config) &&
    NodeFS.existsSync(NodePath.join(english, "model.safetensors"))
    ? { binary, english, config }
    : null;
};

const ensureEmbedding = async (english: string, voice: string): Promise<string> => {
  const entry = POCKET_VOICE_FILES.find((v) => v.name === voice);
  if (entry === undefined) throw new Error("That is not one of Tessaya's voices.");
  const file = NodePath.join(english, `${voice}.safetensors`);
  if (NodeFS.existsSync(file)) return file;
  const response = await fetch(pocketVoiceUrl(voice), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`The voice could not be downloaded (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
    throw new Error("The voice did not match its checksum.");
  }
  await NodeFS.promises.writeFile(`${file}.part`, bytes);
  await NodeFS.promises.rename(`${file}.part`, file);
  return file;
};

type PocketFiles = NonNullable<ReturnType<typeof pocketFiles>>;

/**
 * DeepFilterNet 3, the `deep-filter` program (TESSAYA_DEEP_FILTER, else PATH), at 48 kHz with a 30 dB limit (no limit
 * bends his timbre); null when it is not installed or fails, and the clean goes on without it.
 */
const deepFilter = async (pcm: Pcm): Promise<Pcm | null> => {
  const dir = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tessaya-df-"));
  try {
    const input = NodePath.join(dir, "in.wav");
    await NodeFS.promises.writeFile(
      input,
      writeWav({ rate: 48_000, samples: resample(pcm, 48_000) }),
    );
    await new Promise<void>((resolve, reject) =>
      NodeChildProcess.execFile(
        process.env["TESSAYA_DEEP_FILTER"]?.trim() || "deep-filter",
        ["-D", "-a", "30", "-o", NodePath.join(dir, "out"), input],
        { timeout: 60_000, windowsHide: true },
        (error) => (error === null ? resolve() : reject(error)),
      ),
    );
    return readWav(await NodeFS.promises.readFile(NodePath.join(dir, "out", "in.wav")));
  } catch {
    return null;
  } finally {
    await NodeFS.promises.rm(dir, { recursive: true, force: true });
  }
};

const runPocket = (files: PocketFiles, args: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) =>
    NodeChildProcess.execFile(
      files.binary,
      [...args],
      {
        cwd: files.english,
        timeout: 90_000,
        windowsHide: true,
        // A downloaded program gets what it needs to start, and none of his variables (no token reaches it).
        env: Object.fromEntries(
          ["SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "PATH"].flatMap((key) => {
            const value = process.env[key];
            return value === undefined ? [] : [[key, value]];
          }),
        ),
      },
      (error) => (error === null ? resolve() : reject(error)),
    ),
  );

/** One line in the voice an embedding holds; silence is an error, never a clip (Pocket's own failure is silent). */
const pocketRun = async (files: PocketFiles, embedding: string, text: string): Promise<Buffer> => {
  const out = NodePath.join(files.english, `preview-${process.pid}-${NodeCrypto.randomUUID()}.wav`);
  await runPocket(files, [
    "generate",
    "-q",
    "--config",
    files.config,
    "--voice",
    embedding,
    "--text",
    text,
    "--output-path",
    out,
  ]).catch(() => {
    throw new Error("Tessaya's voice could not say that.");
  });
  const bytes = await NodeFS.promises.readFile(out);
  await NodeFS.promises.rm(out, { force: true });
  const pcm = readWav(bytes);
  if (pcm === null || isNearSilence(pcm))
    throw new Error("The voice came out silent, so nothing was played. Clone it again.");
  return bytes;
};

const pocketSay = async (root: string, voice: string, text: string): Promise<Buffer> => {
  const files = pocketFiles(root);
  if (files === null) throw new Error("Tessaya's voice is not installed on this machine.");
  return pocketRun(files, await ensureEmbedding(files.english, voice), text);
};

/** The gated cloning weights, fetched once with his token and checked; the installed model has none (a silent clone). */
const ensureCloneWeights = async (english: string, token: string | null): Promise<string> => {
  const file = NodePath.join(english, "clone-model.safetensors");
  if (NodeFS.existsSync(file)) return file;
  if (token === null)
    throw new Error(
      "Cloning needs Kyutai's cloning weights: accept their terms at huggingface.co/kyutai/pocket-tts, then save a Hugging Face read token here.",
    );
  const response = await fetch(CLONE_WEIGHTS.url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30 * 60_000),
  }).catch(() => null);
  if (response === null) throw new Error("Couldn’t reach Hugging Face for the cloning weights.");
  if (response.status === 401 || response.status === 403)
    throw new Error(
      "Hugging Face refused the token: accept Kyutai’s terms at huggingface.co/kyutai/pocket-tts with that account.",
    );
  if (!response.ok || response.body === null)
    throw new Error(`Hugging Face answered ${response.status} for the cloning weights.`);
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  const part = `${file}.${process.pid}.part`;
  try {
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      new NodeStream.Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
      }),
      NodeFS.createWriteStream(part),
    );
    if (size !== CLONE_WEIGHTS.size || hash.digest("hex") !== CLONE_WEIGHTS.sha256)
      throw new Error("The cloning weights did not match their checksum.");
    await NodeFS.promises.rename(part, file);
  } finally {
    await NodeFS.promises.rm(part, { force: true });
  }
  return file;
};

/** The installed config with its weights swapped for the cloning ones. */
const cloneConfig = async (files: PocketFiles, weights: string): Promise<string> => {
  const file = NodePath.join(files.english, "clone.yaml");
  const text = (await NodeFS.promises.readFile(files.config, "utf8")).replace(
    /^(weights_path(?:_without_voice_cloning)?):.*$/gm,
    `$1: ${weights.replaceAll("\\", "/")}`,
  );
  await NodeFS.promises.writeFile(file, text);
  return file;
};

/** Whether both halves of the clip are one voice (Voice ID's model); null when this machine does not have it. */
const oneSpeaker = async (modelsDir: string, pcm: Pcm): Promise<boolean | null> => {
  const model = NodePath.join(modelsDir, SPEAKER_MODEL_FILE);
  if (!NodeFS.existsSync(model)) return null;
  // Resolved from disk, as TessayaMemoryEmbedder does: the server's single executable cannot import it.
  const ort = NodeModule.createRequire(import.meta.url)("onnxruntime-node") as typeof Ort;
  const session = await ort.InferenceSession.create(model, { intraOpNumThreads: 1 });
  const embed = async (part: Int16Array) => {
    const { frames, data } = fbank(part);
    if (frames === 0) return null;
    const out = await session.run({
      [session.inputNames[0]!]: new ort.Tensor("float32", data, [1, frames, 80]),
    });
    return unitOrNull(Float32Array.from(Object.values(out)[0]!.data as Float32Array));
  };
  const mono = resample(pcm, 16_000);
  const half = Math.floor(mono.length / 2);
  const a = await embed(mono.subarray(0, half));
  const b = await embed(mono.subarray(half));
  await session.release();
  return a === null || b === null ? null : cosine(a, b) >= CAMPLUS_POLICY.single.steer;
};

/** Gemini's reply carries the audio as base64 in `steps[].content[]`; bare PCM gets a WAV header. */
export const geminiAudio = (reply: unknown): Buffer | null => {
  const steps = (reply as { steps?: ReadonlyArray<{ content?: ReadonlyArray<unknown> }> }).steps;
  for (const step of steps ?? []) {
    for (const item of step.content ?? []) {
      const part = item as { type?: unknown; data?: unknown; mime_type?: unknown };
      if (part.type !== "audio" || typeof part.data !== "string") continue;
      const bytes = Buffer.from(part.data, "base64");
      if (bytes.subarray(0, 4).toString("latin1") === "RIFF") return bytes;
      const head = Buffer.alloc(44);
      head.write("RIFF", 0, "latin1");
      head.writeUInt32LE(36 + bytes.length, 4);
      head.write("WAVEfmt ", 8, "latin1");
      head.writeUInt32LE(16, 16);
      head.writeUInt16LE(1, 20);
      head.writeUInt16LE(1, 22);
      head.writeUInt32LE(24_000, 24);
      head.writeUInt32LE(48_000, 28);
      head.writeUInt16LE(2, 32);
      head.writeUInt16LE(16, 34);
      head.write("data", 36, "latin1");
      head.writeUInt32LE(bytes.length, 40);
      return Buffer.concat([head, bytes]);
    }
  }
  return null;
};

/** The interaction's token counts, when its reply carries them. */
// shortcut: reads both the Interactions (`usage.total_*_tokens`) and generateContent (`usageMetadata`) shapes; pin
// to one when Google's TTS reply format settles.
export const geminiTokens = (reply: unknown): CallTokens | null => {
  const r = (reply ?? {}) as {
    usage?: Record<string, unknown>;
    usageMetadata?: Record<string, unknown>;
  };
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  const input = n(r.usage?.["total_input_tokens"] ?? r.usageMetadata?.["promptTokenCount"]);
  const output = n(r.usage?.["total_output_tokens"] ?? r.usageMetadata?.["candidatesTokenCount"]);
  return input + output === 0
    ? null
    : { model: GEMINI_MODEL, input, cacheRead: 0, cacheWrite: 0, output };
};

const geminiSay = async (
  key: string,
  voice: string,
  text: string,
): Promise<{ readonly audio: Buffer; readonly tokens: CallTokens | null }> => {
  const response = await fetch(GEMINI_URL, {
    method: "POST",
    // The key goes only into this request's header: never a log or a reply.
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [{ type: "user_input", content: [{ type: "text", text }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (response === null) throw new Error("Couldn’t reach Google. The persona’s own voice is used.");
  if (response.status === 401 || response.status === 403)
    throw new Error("Google rejected the key saved in Settings → APIs.");
  if (!response.ok) throw new Error(`Google’s voice answered ${response.status}.`);
  const reply: unknown = await response.json().catch(() => null);
  const audio = geminiAudio(reply);
  if (audio === null) throw new Error("Google’s voice sent no audio.");
  return { audio, tokens: geminiTokens(reply) };
};

const view = (voice: LibraryVoice): LibraryVoiceView => ({
  ...voice,
  licenceLabel: LICENCE_LABELS[voice.licence],
});
const clip = (bytes: Buffer): VoiceClip => ({
  mime: "audio/wav",
  base64: bytes.toString("base64"),
});
/** A cloned voice's line, marked synthetic in the reply and in the file. */
const syntheticClip = (bytes: Buffer): VoiceClip => ({
  mime: "audio/wav",
  base64: Buffer.from(markSynthetic(bytes)).toString("base64"),
  synthetic: true,
});
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(SavedCloneView));

export type SayEngine = "pocket" | "gemini" | "clone";

/**
 * The voice a spoken name means ("in Freya's voice", "in my voice" once saved as a clone): a saved clone first, then a
 * persona (its cloud voice when it has one here), then a library voice by name or id. Null when nothing matches.
 */
export const voiceFor = (
  view: VoiceLibraryView,
  words: string,
): { readonly engine: SayEngine; readonly voice: string; readonly name: string } | null => {
  const wanted = words.trim().toLowerCase();
  const same = (v: { readonly id: string; readonly name: string }) =>
    v.name.toLowerCase() === wanted || v.id.toLowerCase() === wanted;
  const clone = view.clones?.find(same);
  if (clone !== undefined) return { engine: "clone", voice: clone.id, name: clone.name };
  const persona = view.personas.find(same);
  const personaClone = view.clones?.find((c) => c.id === persona?.cloneVoice);
  if (persona !== undefined && personaClone !== undefined)
    return { engine: "clone", voice: personaClone.id, name: persona.name };
  if (persona !== undefined)
    return persona.cloudVoice !== null && view.cloud !== null
      ? { engine: "gemini", voice: persona.cloudVoice, name: persona.name }
      : { engine: "pocket", voice: persona.speaks, name: persona.name };
  const pocket = view.pocket.find(same);
  if (pocket !== undefined) return { engine: "pocket", voice: pocket.id, name: pocket.name };
  const cloud = view.cloud?.find(same);
  return cloud === undefined ? null : { engine: "gemini", voice: cloud.id, name: cloud.name };
};

export class TessayaVoiceLibrary extends Context.Service<
  TessayaVoiceLibrary,
  {
    readonly library: Effect.Effect<VoiceLibraryView>;
    readonly preview: (input: {
      readonly engine: "pocket" | "gemini";
      readonly voice: string;
    }) => Effect.Effect<VoiceClip, VoiceRefusedError>;
    /**
     * Any line in any voice: a library voice on Pocket or Gemini (Gemini when no engine is named: the desktop's speaker
     * falls back to Pocket when it fails), or one of his clones while his consent for it stands.
     */
    readonly say: (input: {
      readonly engine?: SayEngine | undefined;
      readonly voice: string;
      readonly text: string;
    }) => Effect.Effect<VoiceClip, VoiceRefusedError>;
    /** A test voice from his clip, on this machine only; his `consent` is required and recorded. */
    readonly cloneVoice: (input: {
      readonly wav: Uint8Array;
      readonly consent: boolean;
    }) => Effect.Effect<CloneResult, VoiceRefusedError>;
    readonly saveClone: (input: {
      readonly id: string;
      readonly name: string;
    }) => Effect.Effect<SavedCloneView, VoiceRefusedError>;
    readonly deleteClone: (id: string) => Effect.Effect<void, VoiceRefusedError>;
    readonly setHfToken: (token: string | null) => Effect.Effect<void, VoiceRefusedError>;
    readonly setPersona: (input: {
      readonly persona: string;
      readonly engine: "pocket" | "gemini" | "clone";
      readonly voice: string | null;
    }) => Effect.Effect<void, VoiceRefusedError>;
    readonly setGoogleKey: (key: string | null) => Effect.Effect<void, VoiceRefusedError>;
  }
>()("t3/tessaya/TessayaVoiceLibrary") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore;
  const usage = yield* BrainUsage;
  const userdata = config.stateDir;
  const packDir = NodePath.join(userdata, "operating-system");
  const pocketRoot = NodePath.join(userdata, "voice", "pocket");
  const previews = NodePath.join(userdata, "voice", "previews");
  const commercial = commercialBuild(process.env);
  // One Pocket run at a time: each loads the 220 MB model.
  const oneAtATime = yield* Semaphore.make(1);
  const clean = yield* CloneCleanStep;
  /** A clone's line, through the output clean step. */
  const cloneLine = async (files: PocketFiles, embedding: string, text: string) =>
    Buffer.from(writeWav(await clean.output(readWav(await pocketRun(files, embedding, text))!)));
  // His clones: this environment's own data, outside every sync.
  const clonesDir = NodePath.join(userdata, "voice", "clones");
  const embeddingOf = (id: string) => NodePath.join(clonesDir, `${id}.safetensors`);
  // Tessaya's own database, captured here: a tool's caller may run beside upstream's SqlClient (consent.ts).
  const consent = yield* Effect.serviceOption(Consent);
  const grants = Option.isSome(consent) ? consent.value.read : readGrants;
  const grant = (key: string, allow: boolean) =>
    Option.isSome(consent) ? consent.value.set(key, allow) : setGrant(key, allow);

  const secretText = (name: string) =>
    secrets.get(name).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
      Effect.map(Option.filter((key) => key !== "")),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  const googleKey = secretText(GOOGLE_KEY_SECRET);
  const refuse = (cause: unknown) =>
    new VoiceRefusedError({
      why: cause instanceof Error ? cause.message : "That voice could not be played.",
    });

  /** Saved clones whose consent still stands: revoking it in Standing yeses retires the clone. */
  const savedClones = Effect.gen(function* () {
    const keys = yield* grants;
    const names = yield* Effect.promise(() =>
      NodeFS.promises.readdir(clonesDir).catch(() => [] as string[]),
    );
    const views: SavedCloneView[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const text = yield* Effect.promise(() =>
        NodeFS.promises.readFile(NodePath.join(clonesDir, name), "utf8").catch(() => ""),
      );
      const saved = decodeSaved(text);
      if (Option.isSome(saved) && stands(keys, cloneGrant(saved.value.id), { his: true }))
        views.push(saved.value);
    }
    return views.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  const library = Effect.fn("BatonVoiceLibrary.library")(function* () {
    const cloud = Option.isSome(yield* googleKey);
    const pack = readPack(userdata);
    const pocket = pocketFiles(pocketRoot);
    return {
      clones: yield* savedClones,
      cloning: {
        pocket: pocket !== null,
        weights:
          pocket !== null &&
          NodeFS.existsSync(NodePath.join(pocket.english, "clone-model.safetensors")),
      },
      pocket: voiceLibrary("pocket", { commercial }).map(view),
      cloud: cloud ? voiceLibrary("gemini", { commercial }).map(view) : null,
      personas: pack.personas.map((p) => ({
        id: p.id,
        name: p.name,
        lead: p.lead,
        voice: p.voice,
        cloudVoice: p.cloudVoice ?? null,
        cloneVoice: p.cloneVoice ?? null,
        speaks: resolvePersonaVoice(p, { cloud, commercial }).pocket,
      })),
      previews: { pocket: pocket !== null, cloud },
      previewLine: PREVIEW_LINE,
    } satisfies VoiceLibraryView;
  });

  const gemini = Effect.fn("BatonVoiceLibrary.gemini")(function* (voice: string, text: string) {
    const key = yield* googleKey;
    if (Option.isNone(key)) {
      return yield* new VoiceRefusedError({
        why: "Save a Google key in Settings → APIs to use cloud voices.",
      });
    }
    const said = yield* Effect.tryPromise({
      try: () => geminiSay(key.value, voice, text),
      catch: refuse,
    });
    yield* usage.record({
      ...(said.tokens ?? { model: GEMINI_MODEL, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
      role: "speech",
      provider: "google",
      credential: "apiKey:google",
      billing: "apiKey",
      ...(said.tokens === null ? { outcome: "unmeasured" as const } : {}),
      attribution: { feature: "voice-cloud", origin: "user" },
    });
    return said.audio;
  });

  const preview = Effect.fn("BatonVoiceLibrary.preview")(function* (input: {
    readonly engine: "pocket" | "gemini";
    readonly voice: string;
  }) {
    if (!isLibraryVoice(input.engine, input.voice, { commercial })) {
      return yield* new VoiceRefusedError({ why: "That voice is not in the library." });
    }
    const line = pronounce(PREVIEW_LINE);
    const file = NodePath.join(
      previews,
      `${input.engine}-${input.voice}-${sha256(line).slice(0, 10)}.wav`,
    );
    if (NodeFS.existsSync(file)) {
      return clip(
        yield* Effect.tryPromise({ try: () => NodeFS.promises.readFile(file), catch: refuse }),
      );
    }
    if (input.engine === "pocket") {
      return clip(
        yield* oneAtATime.withPermits(1)(
          Effect.tryPromise({
            try: () => cachedClip(file, () => pocketSay(pocketRoot, input.voice, line)),
            catch: refuse,
          }),
        ),
      );
    }
    const made = yield* gemini(input.voice, line);
    yield* Effect.tryPromise({ try: () => cachedClip(file, async () => made), catch: refuse });
    return clip(made);
  });

  const say = Effect.fn("BatonVoiceLibrary.say")(function* (input: {
    readonly engine?: SayEngine | undefined;
    readonly voice: string;
    readonly text: string;
  }) {
    const engine = input.engine ?? "gemini";
    const text = input.text.slice(0, SAY_MAX);
    if (text.trim() === "") return yield* new VoiceRefusedError({ why: "Type something to say." });
    if (engine === "clone") {
      if (!CLONE_ID.test(input.voice) || !NodeFS.existsSync(embeddingOf(input.voice)))
        return yield* new VoiceRefusedError({ why: "There is no clone by that name." });
      if (!stands(yield* grants, cloneGrant(input.voice), { his: true }))
        return yield* new VoiceRefusedError({ why: "The consent for that clone was withdrawn." });
      const files = pocketFiles(pocketRoot);
      if (files === null)
        return yield* new VoiceRefusedError({ why: "Tessaya's voice is not installed here." });
      return syntheticClip(
        yield* oneAtATime.withPermits(1)(
          Effect.tryPromise({
            try: () => cloneLine(files, embeddingOf(input.voice), pronounce(text)),
            catch: refuse,
          }),
        ),
      );
    }
    if (!isLibraryVoice(engine, input.voice, { commercial }))
      return yield* new VoiceRefusedError({ why: "That voice is not in the library." });
    if (engine === "pocket")
      return clip(
        yield* oneAtATime.withPermits(1)(
          Effect.tryPromise({
            try: () => pocketSay(pocketRoot, input.voice, pronounce(text)),
            catch: refuse,
          }),
        ),
      );
    return clip(yield* gemini(input.voice, text));
  });

  const cloneVoice = Effect.fn("TessayaVoiceLibrary.cloneVoice")(function* (input: {
    readonly wav: Uint8Array;
    readonly consent: boolean;
  }) {
    if (input.consent !== true)
      return yield* new VoiceRefusedError({
        why: "Confirm it is your voice, or that you have their permission, before cloning it.",
      });
    const pcm = readWav(input.wav);
    if (pcm === null)
      return yield* new VoiceRefusedError({ why: "Send the clip as a 16-bit PCM WAV." });
    const problem = cloneClipProblem(pcm);
    if (problem !== null) return yield* new VoiceRefusedError({ why: problem });
    const files = pocketFiles(pocketRoot);
    if (files === null)
      return yield* new VoiceRefusedError({
        why: "Tessaya's voice is not installed on this machine yet; it downloads the first time she speaks.",
      });
    const token = Option.getOrNull(yield* secretText(HF_TOKEN_SECRET));
    const id = `test-${NodeCrypto.randomUUID()}`;
    // One test voice at a time: the last one's file and consent go.
    for (const key of (yield* grants).filter((k) => k.startsWith(cloneGrant("test-"))))
      yield* grant(key, false);
    const made = yield* oneAtATime.withPermits(1)(
      Effect.tryPromise({
        try: async () => {
          const single = await oneSpeaker(NodePath.join(userdata, "voice", "models"), pcm);
          if (single === false)
            throw new Error(
              "It sounds like more than one voice. Record just the one person, with no one else talking.",
            );
          const config = await cloneConfig(files, await ensureCloneWeights(files.english, token));
          await NodeFS.promises.mkdir(clonesDir, { recursive: true });
          for (const old of await NodeFS.promises.readdir(clonesDir))
            if (old.startsWith("test-"))
              await NodeFS.promises.rm(NodePath.join(clonesDir, old), { force: true });
          const reference = await clean.reference(pcm);
          if (reference.samples.length / reference.rate < CLONE_MIN_SECONDS)
            throw new Error(
              `Without its pauses the clip is under ${CLONE_MIN_SECONDS} seconds. Say a few more sentences.`,
            );
          const source = NodePath.join(clonesDir, `${id}.wav`);
          await NodeFS.promises.writeFile(
            source,
            writeWav({ rate: 24_000, samples: resample(reference, 24_000) }),
          );
          try {
            await runPocket(files, [
              "export-voice",
              "-q",
              "--config",
              config,
              source,
              embeddingOf(id),
            ]);
          } catch {
            throw new Error("Pocket could not make a voice from that clip.");
          } finally {
            // Only the voice is kept, never his recording.
            await NodeFS.promises.rm(source, { force: true });
          }
          const line = await cloneLine(files, embeddingOf(id), pronounce(PREVIEW_LINE));
          return { single, line };
        },
        catch: refuse,
      }),
    );
    yield* grant(cloneGrant(id), true);
    return {
      id,
      seconds: Math.round((pcm.samples.length / pcm.rate) * 10) / 10,
      oneSpeaker: made.single,
      clip: syntheticClip(made.line),
    } satisfies CloneResult;
  });

  const saveClone = Effect.fn("TessayaVoiceLibrary.saveClone")(function* (input: {
    readonly id: string;
    readonly name: string;
  }) {
    const name = input.name.trim();
    if (!input.id.startsWith("test-") || !CLONE_ID.test(input.id))
      return yield* new VoiceRefusedError({ why: "Only a test voice can be saved." });
    if (name === "") return yield* new VoiceRefusedError({ why: "Give the voice a name." });
    if (!stands(yield* grants, cloneGrant(input.id), { his: true }))
      return yield* new VoiceRefusedError({ why: "Clone it again: that test voice has gone." });
    if ((yield* savedClones).some((c) => c.name.toLowerCase() === name.toLowerCase()))
      return yield* new VoiceRefusedError({ why: `A voice is already called ${name}.` });
    const saved: SavedCloneView = {
      id: input.id.slice("test-".length),
      name,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFS.promises.rename(embeddingOf(input.id), embeddingOf(saved.id));
        await NodeFS.promises.writeFile(
          NodePath.join(clonesDir, `${saved.id}.json`),
          JSON.stringify({
            ...saved,
            synthetic: true,
            consent: "his own voice, or their permission",
          }),
        );
      },
      catch: () => new VoiceRefusedError({ why: "Clone it again: that test voice has gone." }),
    });
    yield* grant(cloneGrant(saved.id), true);
    yield* grant(cloneGrant(input.id), false);
    return saved;
  });

  const deleteClone = Effect.fn("TessayaVoiceLibrary.deleteClone")(function* (id: string) {
    if (!CLONE_ID.test(id))
      return yield* new VoiceRefusedError({ why: "There is no clone by that name." });
    yield* Effect.promise(() =>
      Promise.all(
        [embeddingOf(id), NodePath.join(clonesDir, `${id}.json`)].map((file) =>
          NodeFS.promises.rm(file, { force: true }),
        ),
      ),
    );
    yield* grant(cloneGrant(id), false);
  });

  const setPersona = Effect.fn("BatonVoiceLibrary.setPersona")(function* (input: {
    readonly persona: string;
    readonly engine: "pocket" | "gemini" | "clone";
    readonly voice: string | null;
  }) {
    // A clone is a library voice too, while his consent for it stands; `voice:` stays its fallback.
    if (input.engine === "clone") {
      if (input.voice !== null && !(yield* savedClones).some((c) => c.id === input.voice))
        return yield* new VoiceRefusedError({ why: "There is no saved clone by that name." });
    } else if (input.voice !== null && !isLibraryVoice(input.engine, input.voice, { commercial })) {
      return yield* new VoiceRefusedError({ why: "That voice is not in the library." });
    }
    if (!readPack(userdata).personas.some((p) => p.id === input.persona)) {
      return yield* new VoiceRefusedError({ why: "There is no persona by that name." });
    }
    const key =
      input.engine === "pocket"
        ? "voice"
        : input.engine === "gemini"
          ? "cloud voice"
          : "clone voice";
    const done = yield* Effect.try({
      try: () => setPersonaField(packDir, input.persona, key, input.voice),
      catch: () => new VoiceRefusedError({ why: "The persona's file could not be written." }),
    });
    if (!done) return yield* new VoiceRefusedError({ why: "There is no persona by that name." });
  });

  const setSecret = (name: string, value: string | null) => {
    const trimmed = value?.trim() ?? "";
    const stored =
      trimmed === "" ? secrets.remove(name) : secrets.set(name, new TextEncoder().encode(trimmed));
    return stored.pipe(
      Effect.mapError(
        () => new VoiceRefusedError({ why: "The key could not be stored on this server." }),
      ),
    );
  };
  const setGoogleKey = Effect.fn("BatonVoiceLibrary.setGoogleKey")(function* (key: string | null) {
    yield* setSecret(GOOGLE_KEY_SECRET, key);
  });
  const setHfToken = Effect.fn("TessayaVoiceLibrary.setHfToken")(function* (token: string | null) {
    yield* setSecret(HF_TOKEN_SECRET, token);
  });

  return TessayaVoiceLibrary.of({
    library: library(),
    preview,
    say,
    cloneVoice,
    saveClone,
    deleteClone,
    setPersona,
    setGoogleKey,
    setHfToken,
  });
});

export const layer = Layer.effect(TessayaVoiceLibrary, make);

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Engine = Schema.Literals(["pocket", "gemini"]);
const READ: ReadonlySet<string> = new Set(BATON_VOICE_READ_OPS);
const ACT: ReadonlySet<string> = new Set(BATON_VOICE_ACT_OPS);
const OWNER: ReadonlySet<string> = new Set(BATON_VOICE_OWNER_OPS);
/** A clip of up to 30 s, 48 kHz stereo, as base64. */
const CLIP_BASE64_MAX = 8_000_000;

/** The `baton.voice.call` door: decodes one op's arguments, calls one service method, and answers in a sentence. */
export const serveVoiceCall = Effect.fn("baton.voice.call")(function* (
  input: TessayaVoiceCallInput,
) {
  const args = input.args ?? {};
  const decode = <S extends Schema.Decoder<unknown>>(schema: S) =>
    Schema.decodeUnknownOption(schema)(args as unknown);
  const allowed = input.kind === "read" ? READ : input.kind === "owner" ? OWNER : ACT;
  const bad: TessayaVoiceCallResult = { ok: false, error: "That is not a voice request." };
  if (!allowed.has(input.op)) return bad;
  if (input.op === "vocabulary" || input.op === "vocabularyChange") {
    const store = yield* Effect.serviceOption(TessayaVocabulary);
    if (Option.isNone(store)) return { ok: false, error: "This server keeps no dictionary." };
    if (input.op === "vocabulary") return { ok: true, value: yield* store.value.read };
    const a = decode(VocabularyChange);
    if (Option.isNone(a)) return bad;
    return yield* store.value.change(a.value).pipe(
      Effect.map((value): TessayaVoiceCallResult => ({ ok: true, value })),
      Effect.catchTags({
        VocabularyRefusedError: (e) =>
          Effect.succeed<TessayaVoiceCallResult>({ ok: false, error: e.why }),
      }),
    );
  }
  const arbiter = yield* serveArbiter(input.op, args);
  if (arbiter !== null) return arbiter;
  const voices = yield* TessayaVoiceLibrary;
  const answer = <A>(effect: Effect.Effect<A, VoiceRefusedError>) =>
    effect.pipe(
      Effect.map((value): TessayaVoiceCallResult => ({ ok: true, value })),
      Effect.catchTags({
        VoiceRefusedError: (e) =>
          Effect.succeed<TessayaVoiceCallResult>({ ok: false, error: e.why }),
      }),
    );
  switch (input.op) {
    case "express": {
      const a = decode(Schema.Struct({ event: Text(16), persona: Schema.optionalKey(Text(60)) }));
      if (Option.isNone(a) || !isLineEvent(a.value.event)) return bad;
      const lines = yield* Effect.serviceOption(TessayaExpression);
      const said = Option.isNone(lines)
        ? null
        : yield* lines.value.express(a.value.event, { persona: a.value.persona });
      return { ok: true, value: said };
    }
    case "mood": {
      const a = decode(Schema.Struct({ persona: Schema.optionalKey(Text(60)) }));
      if (Option.isNone(a)) return bad;
      const mood = yield* Effect.serviceOption(TessayaMood);
      if (Option.isNone(mood)) return { ok: true, value: null };
      const felt = yield* mood.value.view(a.value.persona);
      // Why is the owner's alone (EMOTION §8.1): anyone else gets enough for the face.
      return {
        ok: true,
        value: {
          label: felt.label,
          intensity: felt.intensity,
          ...(input.kind === "owner" ? { why: felt.why } : {}),
        },
      };
    }
    case "library":
      return yield* answer(voices.library);
    case "preview": {
      const a = decode(Schema.Struct({ engine: Engine, voice: Text(80) }));
      return Option.isNone(a) ? bad : yield* answer(voices.preview(a.value));
    }
    case "say": {
      const a = decode(
        Schema.Struct({
          engine: Schema.optionalKey(Schema.Literals(["pocket", "gemini", "clone"])),
          voice: Text(80),
          text: Text(4_000),
        }),
      );
      if (Option.isNone(a)) return bad;
      // Speaking in his cloned voice is the owner's alone, as cloning it is.
      if (a.value.engine === "clone" && input.kind !== "owner")
        return { ok: false, error: "Only the owner can speak in a cloned voice." };
      return yield* answer(voices.say(a.value));
    }
    case "clone": {
      const a = decode(Schema.Struct({ wav: Text(CLIP_BASE64_MAX), consent: Schema.Boolean }));
      if (Option.isNone(a)) return bad;
      return yield* answer(
        voices.cloneVoice({ wav: Buffer.from(a.value.wav, "base64"), consent: a.value.consent }),
      );
    }
    case "saveClone": {
      const a = decode(Schema.Struct({ id: Text(60), name: Text(40) }));
      return Option.isNone(a) ? bad : yield* answer(voices.saveClone(a.value));
    }
    case "deleteClone": {
      const a = decode(Schema.Struct({ id: Text(60) }));
      return Option.isNone(a) ? bad : yield* answer(voices.deleteClone(a.value.id));
    }
    case "setHfToken": {
      const a = decode(Schema.Struct({ token: Schema.NullOr(Text(400)) }));
      return Option.isNone(a) ? bad : yield* answer(voices.setHfToken(a.value.token));
    }
    case "setPersona": {
      const a = decode(
        Schema.Struct({
          persona: Text(60),
          engine: Schema.Literals(["pocket", "gemini", "clone"]),
          voice: Schema.NullOr(Text(80)),
        }),
      );
      return Option.isNone(a) ? bad : yield* answer(voices.setPersona(a.value));
    }
    case "setGoogleKey": {
      const a = decode(Schema.Struct({ key: Schema.NullOr(Text(400)) }));
      return Option.isNone(a) ? bad : yield* answer(voices.setGoogleKey(a.value.key));
    }
    default:
      return bad;
  }
});
