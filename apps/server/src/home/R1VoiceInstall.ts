// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
/**
 * Installs the R1's room voice under `<T3 home>/userdata/r1-voice` when the first R1 pairs (R1Loop): the bundle this
 * release was built with (R1VoiceBundle.ts) and the large models, each pinned by size and sha256, resumed where a
 * download stopped. Nothing is fetched before an R1 is on this server's hub.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";

import { POCKET_VOICE_FILES, pocketVoiceUrl } from "@t3tools/baton-shared/voiceLibrary";

export interface Pinned {
  /** Where it goes, relative to the install folder. */
  readonly file: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

const HF = "https://huggingface.co";
const POCKET = `${HF}/kyutai/pocket-tts-without-voice-cloning/resolve`;
const eve = POCKET_VOICE_FILES.find((v) => v.name === "eve")!;

/**
 * The shipped models, all licensed for sale: Parakeet TDT 0.6B v3 (CC-BY-4.0) writes the words, Smart Turn (BSD-2)
 * hears the end of a turn, CAM++ (Apache-2.0) is Voice ID, Pocket TTS (CC-BY-4.0) and its eve voice (CC-BY-4.0) speak.
 * SenseVoice (personal use only) is never fetched; see deploy/r1-voice/README.md.
 */
export const R1_VOICE_MODELS: ReadonlyArray<Pinned> = [
  {
    file: "models/parakeet-tdt-0.6b-v3-Q8_0.gguf",
    url: `${HF}/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/d8d8c32cb2017c57e5307767343e97870f8a7f53/parakeet-tdt-0.6b-v3-Q8_0.gguf`,
    size: 739_508_576,
    sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7",
  },
  {
    file: "models/smart-turn-v3.2-cpu.onnx",
    url: `${HF}/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx`,
    size: 8_679_182,
    sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
  },
  {
    file: "models/campplus.onnx",
    url: `${HF}/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`,
    size: 29_596_978,
    sha256: "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b",
  },
  {
    file: "models/pocket/english/model.safetensors",
    url: `${POCKET}/a7056f505a4a8ca72d8b5fb1440071d6f1a35739/languages/english/model.safetensors`,
    size: 219_029_196,
    sha256: "4c56cbd171c63e8a26ea61f5d48b8a0cd8f3c51f4652c0ab9a19bfcced8c931d",
  },
  {
    file: "models/pocket/english/tokenizer.json",
    url: `${POCKET}/00eac05ed3d16bdc3f6b5d598874019c34a89214/languages/english/tokenizer.json`,
    size: 245_020,
    sha256: "f498428e1eafee50492f7be13dc9bfafcfc12e508cd0eb1b01c92ecd5d8c6687",
  },
  {
    file: "models/pocket/english/eve.safetensors",
    url: pocketVoiceUrl("eve"),
    size: eve.size,
    sha256: eve.sha256,
  },
];

/** The bundle's own marker: which bundle is unpacked here. A folder without one was installed by hand. */
export const BUNDLE_MARK = "app/.bundle-sha256";
export const BUNDLE_TAR = "r1-voice-bundle.tar.gz";
/** Room left on the disk after everything is in. */
const SPARE_BYTES = 1024 ** 3;

const verifiedMark = (path: string) => `${path}.verified`;
const read = (path: string) => NodeFSP.readFile(path, "utf8").catch(() => null);

const hashFile = async (path: string) => {
  const hash = NodeCrypto.createHash("sha256");
  await NodeStreamPromises.pipeline(NodeFS.createReadStream(path), hash);
  return hash.digest("hex");
};

/** Whether `file` is in place with its pinned bytes (checked once, then remembered beside it). */
const isVerified = async (dir: string, pin: Pinned): Promise<boolean> =>
  (await read(verifiedMark(NodePath.join(dir, pin.file)))) === pin.sha256;

/**
 * One pinned file, resumed from its `.part` with a Range request, then checked. A server that ignores the Range sends
 * it all again, so the part restarts. A finished part that does not match is deleted, and the download fails.
 */
export const fetchPinned = async (
  dir: string,
  pin: Pinned,
  onBytes: (bytes: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  const target = NodePath.join(dir, pin.file);
  if (await isVerified(dir, pin)) return;
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const part = `${target}.part`;
  let have = (await NodeFSP.stat(part).catch(() => null))?.size ?? 0;
  if (have > pin.size) {
    await NodeFSP.rm(part);
    have = 0;
  }
  if (have < pin.size) {
    const response = await fetchImpl(pin.url, {
      redirect: "follow",
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok || response.body === null)
      throw new Error(`${NodePath.basename(pin.file)} answered ${response.status}`);
    const resumed = response.status === 206;
    if (!resumed) have = 0;
    onBytes(have);
    // Each chunk is on disk before the next is read, so a broken download resumes from what really arrived.
    const out = await NodeFSP.open(part, resumed ? "a" : "w");
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        await out.write(chunk);
        onBytes(chunk.length);
      }
    } finally {
      await out.close();
    }
  } else onBytes(have);
  if ((await hashFile(part)) !== pin.sha256) {
    await NodeFSP.rm(part, { force: true });
    throw new Error(`${NodePath.basename(pin.file)} did not match its checksum`);
  }
  await NodeFSP.rename(part, target);
  await NodeFSP.writeFile(verifiedMark(target), pin.sha256);
};

/** What is still to fetch for this bundle: nothing once the bundle is unpacked and every model is checked. */
export const missing = async (
  dir: string,
  bundle: Pinned,
  models: ReadonlyArray<Pinned>,
): Promise<ReadonlyArray<Pinned>> => {
  const unpacked = (await read(NodePath.join(dir, BUNDLE_MARK))) === bundle.sha256;
  const out: Pinned[] = unpacked ? [] : [bundle];
  for (const m of models) if (!(await isVerified(dir, m))) out.push(m);
  return out;
};

export interface InstallProgress {
  readonly done: number;
  readonly total: number;
}

/** Fetches what is missing (after checking the disk has room), then unpacks the bundle over the folder. */
export const install = async (input: {
  readonly dir: string;
  readonly bundle: Omit<Pinned, "file">;
  readonly models?: ReadonlyArray<Pinned>;
  readonly onProgress: (progress: InstallProgress) => void;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> => {
  const bundle: Pinned = { ...input.bundle, file: BUNDLE_TAR };
  const todo = await missing(input.dir, bundle, input.models ?? R1_VOICE_MODELS);
  if (todo.length === 0) return;
  await NodeFSP.mkdir(input.dir, { recursive: true });
  const total = todo.reduce((n, p) => n + p.size, 0);
  const stats = await NodeFSP.statfs(input.dir);
  const free = stats.bavail * stats.bsize;
  if (free < total + SPARE_BYTES)
    throw new Error(
      `it needs ${gb(total + SPARE_BYTES)} free on this server's disk and ${gb(free)} is free`,
    );
  let done = 0;
  input.onProgress({ done, total });
  for (const pin of todo) {
    await fetchPinned(
      input.dir,
      pin,
      (bytes) => {
        done += bytes;
        input.onProgress({ done, total });
      },
      input.fetchImpl,
    );
  }
  if (todo.includes(bundle)) {
    const tar = NodePath.join(input.dir, BUNDLE_TAR);
    await NodeUtil.promisify(NodeChildProcess.execFile)("tar", ["-xzf", tar, "-C", input.dir]);
    await NodeFSP.writeFile(NodePath.join(input.dir, BUNDLE_MARK), bundle.sha256);
    await NodeFSP.rm(tar, { force: true });
    await NodeFSP.rm(verifiedMark(tar), { force: true });
  }
};

export const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
