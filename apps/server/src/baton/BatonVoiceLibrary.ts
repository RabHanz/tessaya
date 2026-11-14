// @effect-diagnostics globalFetch:off nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off
/**
 * The voice library this environment serves to every client: voices, each persona's choice (in his pack file), and
 * previews cached under `<userdata>/voice/previews`. Pocket previews reuse the desktop's files in `<userdata>/voice/pocket`,
 * one run at a time; a server without them says so.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BATON_VOICE_ACT_OPS,
  BATON_VOICE_READ_OPS,
  type BatonVoiceCallInput,
  type BatonVoiceCallResult,
  type LibraryVoiceView,
  type VoiceClip,
  type VoiceLibraryView,
} from "@t3tools/tessaya-contracts";
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { serveArbiter } from "../home/VoiceArbiter.ts";
import { readPack } from "./OperatingSystemPack.ts";

export const GOOGLE_KEY_SECRET = "google-api-key";
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

const pocketSay = async (root: string, voice: string, text: string): Promise<Buffer> => {
  const files = pocketFiles(root);
  if (files === null) throw new Error("Tessaya's voice is not installed on this machine.");
  const embedding = await ensureEmbedding(files.english, voice);
  const out = NodePath.join(files.english, `preview-${process.pid}-${NodeCrypto.randomUUID()}.wav`);
  await new Promise<void>((resolve, reject) =>
    NodeChildProcess.execFile(
      files.binary,
      [
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
      ],
      {
        cwd: files.english,
        timeout: 90_000,
        windowsHide: true,
        // A downloaded program gets what it needs to start, and none of his variables.
        env: Object.fromEntries(
          ["SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "PATH"].flatMap((key) => {
            const value = process.env[key];
            return value === undefined ? [] : [[key, value]];
          }),
        ),
      },
      (error) => (error === null ? resolve() : reject(error)),
    ),
  ).catch(() => {
    throw new Error("Tessaya's voice could not say that.");
  });
  const bytes = await NodeFS.promises.readFile(out);
  await NodeFS.promises.rm(out, { force: true });
  return bytes;
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

const geminiSay = async (key: string, voice: string, text: string): Promise<Buffer> => {
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
  const audio = geminiAudio(await response.json().catch(() => null));
  if (audio === null) throw new Error("Google’s voice sent no audio.");
  return audio;
};

const view = (voice: LibraryVoice): LibraryVoiceView => ({
  ...voice,
  licenceLabel: LICENCE_LABELS[voice.licence],
});
const clip = (bytes: Buffer): VoiceClip => ({
  mime: "audio/wav",
  base64: bytes.toString("base64"),
});

export class BatonVoiceLibrary extends Context.Service<
  BatonVoiceLibrary,
  {
    readonly library: Effect.Effect<VoiceLibraryView>;
    readonly preview: (input: {
      readonly engine: "pocket" | "gemini";
      readonly voice: string;
    }) => Effect.Effect<VoiceClip, VoiceRefusedError>;
    /** A line in a persona's cloud voice, for the desktop's speaker; it falls back to Pocket when this fails. */
    readonly say: (input: {
      readonly voice: string;
      readonly text: string;
    }) => Effect.Effect<VoiceClip, VoiceRefusedError>;
    readonly setPersona: (input: {
      readonly persona: string;
      readonly engine: "pocket" | "gemini";
      readonly voice: string | null;
    }) => Effect.Effect<void, VoiceRefusedError>;
    readonly setGoogleKey: (key: string | null) => Effect.Effect<void, VoiceRefusedError>;
  }
>()("t3/baton/BatonVoiceLibrary") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore;
  const userdata = config.stateDir;
  const packDir = NodePath.join(userdata, "operating-system");
  const pocketRoot = NodePath.join(userdata, "voice", "pocket");
  const previews = NodePath.join(userdata, "voice", "previews");
  const commercial = commercialBuild(process.env);
  // One Pocket run at a time: each loads the 220 MB model.
  const oneAtATime = yield* Semaphore.make(1);

  const googleKey = secrets.get(GOOGLE_KEY_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
    Effect.map(Option.filter((key) => key !== "")),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const refuse = (cause: unknown) =>
    new VoiceRefusedError({
      why: cause instanceof Error ? cause.message : "That voice could not be played.",
    });

  const library = Effect.fn("BatonVoiceLibrary.library")(function* () {
    const cloud = Option.isSome(yield* googleKey);
    const pack = readPack(userdata);
    return {
      pocket: voiceLibrary("pocket", { commercial }).map(view),
      cloud: cloud ? voiceLibrary("gemini", { commercial }).map(view) : null,
      personas: pack.personas.map((p) => ({
        id: p.id,
        name: p.name,
        lead: p.lead,
        voice: p.voice,
        cloudVoice: p.cloudVoice ?? null,
        speaks: resolvePersonaVoice(p, { cloud, commercial }).pocket,
      })),
      previews: { pocket: pocketFiles(pocketRoot) !== null, cloud },
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
    return yield* Effect.tryPromise({
      try: () => geminiSay(key.value, voice, text),
      catch: refuse,
    });
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
    readonly voice: string;
    readonly text: string;
  }) {
    if (!isLibraryVoice("gemini", input.voice, { commercial }) || input.text.trim() === "") {
      return yield* new VoiceRefusedError({ why: "That voice is not in the library." });
    }
    return clip(yield* gemini(input.voice, input.text.slice(0, SAY_MAX)));
  });

  const setPersona = Effect.fn("BatonVoiceLibrary.setPersona")(function* (input: {
    readonly persona: string;
    readonly engine: "pocket" | "gemini";
    readonly voice: string | null;
  }) {
    if (input.voice !== null && !isLibraryVoice(input.engine, input.voice, { commercial })) {
      return yield* new VoiceRefusedError({ why: "That voice is not in the library." });
    }
    if (!readPack(userdata).personas.some((p) => p.id === input.persona)) {
      return yield* new VoiceRefusedError({ why: "There is no persona by that name." });
    }
    const key = input.engine === "pocket" ? "voice" : "cloud voice";
    const done = yield* Effect.try({
      try: () => setPersonaField(packDir, input.persona, key, input.voice),
      catch: () => new VoiceRefusedError({ why: "The persona's file could not be written." }),
    });
    if (!done) return yield* new VoiceRefusedError({ why: "There is no persona by that name." });
  });

  const setGoogleKey = Effect.fn("BatonVoiceLibrary.setGoogleKey")(function* (key: string | null) {
    const trimmed = key?.trim() ?? "";
    const stored =
      trimmed === ""
        ? secrets.remove(GOOGLE_KEY_SECRET)
        : secrets.set(GOOGLE_KEY_SECRET, new TextEncoder().encode(trimmed));
    yield* stored.pipe(
      Effect.mapError(
        () => new VoiceRefusedError({ why: "The key could not be stored on this server." }),
      ),
    );
  });

  return BatonVoiceLibrary.of({
    library: library(),
    preview,
    say,
    setPersona,
    setGoogleKey,
  });
});

export const layer = Layer.effect(BatonVoiceLibrary, make);

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Engine = Schema.Literals(["pocket", "gemini"]);
const READ: ReadonlySet<string> = new Set(BATON_VOICE_READ_OPS);
const ACT: ReadonlySet<string> = new Set(BATON_VOICE_ACT_OPS);

/** The `baton.voice.call` door: decodes one op's arguments, calls one service method, and answers in a sentence. */
export const serveVoiceCall = Effect.fn("baton.voice.call")(function* (input: BatonVoiceCallInput) {
  const voices = yield* BatonVoiceLibrary;
  const args = input.args ?? {};
  const decode = <S extends Schema.Decoder<unknown>>(schema: S) =>
    Schema.decodeUnknownOption(schema)(args as unknown);
  const allowed = input.kind === "read" ? READ : ACT;
  const bad: BatonVoiceCallResult = { ok: false, error: "That is not a voice request." };
  if (!allowed.has(input.op)) return bad;
  const arbiter = yield* serveArbiter(input.op, args);
  if (arbiter !== null) return arbiter;
  const answer = <A>(effect: Effect.Effect<A, VoiceRefusedError>) =>
    effect.pipe(
      Effect.map((value): BatonVoiceCallResult => ({ ok: true, value })),
      Effect.catchTags({
        VoiceRefusedError: (e) => Effect.succeed<BatonVoiceCallResult>({ ok: false, error: e.why }),
      }),
    );
  switch (input.op) {
    case "library":
      return yield* answer(voices.library);
    case "preview": {
      const a = decode(Schema.Struct({ engine: Engine, voice: Text(80) }));
      return Option.isNone(a) ? bad : yield* answer(voices.preview(a.value));
    }
    case "say": {
      const a = decode(Schema.Struct({ voice: Text(80), text: Text(4_000) }));
      return Option.isNone(a) ? bad : yield* answer(voices.say(a.value));
    }
    case "setPersona": {
      const a = decode(
        Schema.Struct({ persona: Text(60), engine: Engine, voice: Schema.NullOr(Text(80)) }),
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
