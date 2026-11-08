// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
/**
 * Parakeet is 740 MB, so it comes down when he asks for it rather than in the installer. Revision
 * and hash are the ones Handy's catalogue pins (src-tauri/src/catalog/catalog.json at 7bfb2e2c).
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import { markPhase } from "../lifecycle/mainStall.ts";

export const PARAKEET_MODEL = {
  file: "parakeet-tdt-0.6b-v3-Q8_0.gguf",
  url: "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/85ac09ea12fc4b1112fa76810059364bc6adc9de/parakeet-tdt-0.6b-v3-Q8_0.gguf",
  size: 739_508_576,
  sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7",
} as const;

/**
 * English only, 229 MB. On 240 clips of real dictation it agreed with Wispr exactly as well as v3
 * (3.04% of words) and ran 3.4 times faster, so it is one tray click away.
 */
export const PARAKEET_FAST_MODEL = {
  file: "parakeet-tdt_ctc-110m-F16.gguf",
  url: "https://huggingface.co/handy-computer/parakeet-tdt_ctc-110m-gguf/resolve/9d66d34f9e1594075c5dd72c90c0f4c321b29f21/parakeet-tdt_ctc-110m-F16.gguf",
  size: 229334560,
  sha256: "965cc3f8e171286ecb4d4e6646b407a1782a97da9aed22f88d1e0ec6c96b2358",
} as const;

/**
 * Voice match (VOICE-ID): 3D-Speaker CAM++ trained on VoxCeleb, the sherpa-onnx export (Apache-2.0, code and weights).
 * 30 MB, about 30 ms of one CPU core per second of speech; chosen by the voice-match benchmark of 2026-11-08.
 */
export const SPEAKER_MODEL = {
  file: "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
  url: "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
  size: 29_596_978,
  sha256: "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b",
  /** Stamped on every profile made with it, so a profile from another model is never compared. */
  id: "campplus-voxceleb-357a834f",
} as const;

/**
 * The model of its own the wake path asks for (what he says to Tessaya; dictation keeps his choice), or null for
 * dictation's. Only ever the fast English one, when every language he speaks is English and dictation is not already
 * on it: 3.4 times faster at the same accuracy. Never the other way: a fast dictation choice is kept for Tessaya too.
 */
export const wakeModelFor = (
  languages: ReadonlyArray<string>,
  speechModel: "v3" | "fast",
): DownloadableModel | null =>
  speechModel !== "fast" && englishOnly(languages) ? PARAKEET_FAST_MODEL : null;

const englishOnly = (languages: ReadonlyArray<string>) =>
  languages.length > 0 && languages.every((code) => code.toLowerCase().split("-")[0] === "en");

/** His laptop (8 threads, 16 GB) logged model loads of 1-14 s, so a load over this is a slow machine. */
const SLOW_START_MS = 30_000;

/**
 * Slow starts in a row, after one that took `loadMs`. A start that downloaded the model first (cold disk, the virus
 * scanner) counts neither way.
 */
export const slowStartsAfter = (previous: number, loadMs: number, downloaded: boolean) =>
  downloaded ? previous : loadMs > SLOW_START_MS ? previous + 1 : 0;

/**
 * Why this machine is too weak for the 0.6B model, or null. Cores and memory count only on a fresh install, where no
 * earlier pick of his can be lost; one slow start can be a busy login, so it takes two in a row.
 */
export const weakMachine = (machine: {
  readonly freshInstall: boolean;
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly slowStarts: number;
}): string | null => {
  if (machine.freshInstall && machine.cpus <= 4) return `${machine.cpus} logical cores`;
  if (machine.freshInstall && machine.memoryBytes < 10 * 2 ** 30)
    return `${Math.round(machine.memoryBytes / 2 ** 30)} GB of memory`;
  return machine.slowStarts >= 2 ? `${machine.slowStarts} slow starts in a row` : null;
};

export const machinePicksFast = (
  settings: {
    readonly speechModel: "v3" | "fast";
    readonly speechModelPicked?: "you" | "machine" | undefined;
    readonly languages: ReadonlyArray<string>;
  },
  weak: string | null,
) =>
  weak !== null &&
  settings.speechModelPicked === undefined &&
  settings.speechModel === "v3" &&
  englishOnly(settings.languages);

export interface DownloadableModel {
  readonly file: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface EnsureModelInput {
  readonly dir: string;
  readonly model: DownloadableModel;
  readonly onProgress: (fraction: number) => void;
  readonly fetchImpl?: typeof fetch;
  /** No bytes for this long is a failed download, not a slow one. */
  readonly stallMs?: number;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
}

const STALL_MS = 60_000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

export const hashFile = async (path: string): Promise<string> => {
  // Hashing a model is the one CPU-heavy step here, so it is a phase of its own in the stall log.
  markPhase("model-hash:begin", { file: NodePath.basename(path) });
  try {
    const hash = NodeCrypto.createHash("sha256");
    await NodeStreamPromises.pipeline(NodeFS.createReadStream(path), hash);
    return hash.digest("hex");
  } finally {
    markPhase("model-hash:end");
  }
};

/** Yields the body's chunks, and gives up when one takes longer than `stallMs` to arrive. */
async function* withStallLimit(
  body: AsyncIterable<Uint8Array>,
  stallMs: number,
  onChunk: (size: number) => void,
): AsyncGenerator<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The download stalled.")), stallMs);
    });
    try {
      const next = await Promise.race([iterator.next(), stalled]);
      if (next.done === true) return;
      onChunk(next.value.length);
      yield next.value;
    } finally {
      clearTimeout(timer);
    }
  }
}

const download = async (input: EnsureModelInput, target: string): Promise<void> => {
  const part = `${target}.part`;
  const controller = new AbortController();
  try {
    const response = await (input.fetchImpl ?? fetch)(input.model.url, {
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Could not download ${input.model.file} (${response.status}).`);
    }
    let received = 0;
    let shown = -1;
    const chunks = withStallLimit(
      response.body as unknown as AsyncIterable<Uint8Array>,
      input.stallMs ?? STALL_MS,
      (size) => {
        received += size;
        const percent = Math.floor((received / input.model.size) * 100);
        if (percent !== shown) {
          shown = percent;
          input.onProgress(percent / 100);
        }
      },
    );
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.from(chunks, { objectMode: false }),
      NodeFS.createWriteStream(part),
    );
    if ((await hashFile(part)) !== input.model.sha256) {
      throw new Error(`${input.model.file} did not match its checksum.`);
    }
    await NodeFSP.rename(part, target);
    await NodeFSP.writeFile(`${target}.verified`, input.model.sha256);
  } catch (error) {
    controller.abort();
    await NodeFSP.rm(part, { force: true });
    throw error;
  }
};

/** A file on disk counts once its bytes have been hashed; the marker saves doing that each launch. */
const verified = async (target: string, model: DownloadableModel): Promise<boolean> => {
  const stat = await NodeFSP.stat(target).catch(() => null);
  if (stat?.size !== model.size) return false;
  const marker = await NodeFSP.readFile(`${target}.verified`, "utf8").catch(() => null);
  if (marker === model.sha256) return true;
  if ((await hashFile(target)) !== model.sha256) {
    await NodeFSP.rm(target, { force: true });
    return false;
  }
  await NodeFSP.writeFile(`${target}.verified`, model.sha256);
  return true;
};

const inFlight = new Map<string, Promise<string>>();

const run = async (input: EnsureModelInput, target: string): Promise<string> => {
  await NodeFSP.mkdir(input.dir, { recursive: true });
  if (await verified(target, input.model)) return target;
  const attempts = input.attempts ?? ATTEMPTS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await download(input, target);
      return target;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, input.retryDelayMs ?? RETRY_DELAY_MS));
    }
  }
};

/** One download per file, however many callers ask. Nothing reaches `file` until its bytes match. */
export const ensureModel = (input: EnsureModelInput): Promise<string> => {
  const target = NodePath.join(input.dir, input.model.file);
  const running = inFlight.get(target);
  if (running !== undefined) return running;
  const started = run(input, target).finally(() => inFlight.delete(target));
  inFlight.set(target, started);
  return started;
};

/** Present at the right size, which is enough to offer it; `ensureModel` still checks the bytes. */
export const modelPresent = (dir: string, model: DownloadableModel): boolean => {
  try {
    return NodeFS.statSync(NodePath.join(dir, model.file)).size === model.size;
  } catch {
    return false;
  }
};
