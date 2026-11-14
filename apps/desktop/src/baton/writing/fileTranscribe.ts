// @effect-diagnostics nodeBuiltinImport:off
/**
 * Transcribes an audio file with the speech model already on this computer: a WAV as it is, any
 * other format through ffmpeg when it is installed. Long recordings go a minute at a time so one
 * slow piece cannot hold the rest.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  chunkRanges,
  ffmpegArgs,
  isAcceptedAudio,
  isWavFile,
  MAX_SECONDS,
} from "@t3tools/tessaya-shared/audioFile";

import { parseWav, toVoicePcm } from "../voice/pcm.ts";
import { VOICE_SAMPLE_RATE } from "../voice/voiceTypes.ts";

export type FileResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly why: string };

export interface FilePorts {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  /** The file as a 16 kHz mono WAV, or null when ffmpeg is not installed. */
  readonly toWav: (path: string) => Promise<Uint8Array | null>;
  readonly transcribe: (pcm: Int16Array) => Promise<string>;
  readonly progress?: (done: number, total: number) => void;
}

export const transcribeFile = async (path: string, ports: FilePorts): Promise<FileResult> => {
  if (!isAcceptedAudio(path)) {
    return {
      ok: false,
      why: "That is not an audio file Tessaya knows (WAV, MP3, M4A, OGG, FLAC and similar).",
    };
  }
  let bytes: Uint8Array;
  try {
    if (isWavFile(path)) bytes = await ports.readFile(path);
    else {
      const wav = await ports.toWav(path);
      if (wav === null) {
        return {
          ok: false,
          why: "That format needs ffmpeg, which is not installed. A WAV file works as it is.",
        };
      }
      bytes = wav;
    }
  } catch {
    return { ok: false, why: "The file could not be read." };
  }
  let pcm: Int16Array;
  try {
    const wav = parseWav(bytes);
    pcm = toVoicePcm(wav.samples, wav.channels, wav.sampleRate);
  } catch {
    return { ok: false, why: "That is not a WAV file Tessaya can read (16-bit or float PCM)." };
  }
  if (pcm.length > MAX_SECONDS * VOICE_SAMPLE_RATE) {
    return { ok: false, why: "That recording is longer than four hours." };
  }
  const ranges = chunkRanges(pcm.length, VOICE_SAMPLE_RATE);
  const parts: string[] = [];
  for (const [i, [from, to]] of ranges.entries()) {
    try {
      const heard = (await ports.transcribe(pcm.slice(from, to))).trim();
      if (heard !== "") parts.push(heard);
    } catch {
      return { ok: false, why: `Recognition stopped at minute ${i + 1}. Nothing was saved.` };
    }
    ports.progress?.(i + 1, ranges.length);
  }
  return parts.length === 0
    ? { ok: false, why: "No speech was recognised in that file." }
    : { ok: true, text: parts.join(" ") };
};

/** ffmpeg on the PATH, writing a temporary WAV that is read back and removed. */
export const ffmpegToWav = async (path: string): Promise<Uint8Array | null> => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "baton-file-"));
  const out = NodePath.join(dir, "audio.wav");
  try {
    const ran = await new Promise<boolean | null>((resolve) =>
      NodeChildProcess.execFile(
        "ffmpeg",
        [...ffmpegArgs(path, out)],
        { timeout: 10 * 60_000, windowsHide: true },
        (error) =>
          resolve(
            error === null
              ? true
              : (error as NodeJS.ErrnoException).code === "ENOENT"
                ? null
                : false,
          ),
      ),
    );
    if (ran === null) return null;
    if (!ran) throw new Error("ffmpeg could not read that file");
    return new Uint8Array(await NodeFSP.readFile(out));
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
};
