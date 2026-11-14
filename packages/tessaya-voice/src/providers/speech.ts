/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off - providers spawn OS binaries; the desktop calls this outside Effect.
/**
 * STT and TTS providers. whisper.cpp runs as its `whisper-cli` binary (no
 * native addon to build per Electron ABI); the cloud provider is any
 * OpenAI-compatible `/audio/transcriptions` endpoint behind the same interface;
 * TTS is the OS voice.
 *
 * @module baton-voice/providers/speech
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SttProvider, TtsProvider } from "../types.ts";
import { VOICE_SAMPLE_RATE } from "../types.ts";

/** 16-bit mono PCM → a WAV file's bytes. */
export const encodeWav = (pcm: Int16Array, sampleRate = VOICE_SAMPLE_RATE): Buffer => {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

/** A 16 kHz mono 16-bit WAV's samples. Refuses anything else rather than resampling badly. */
export const decodeWav = (bytes: Buffer): Int16Array => {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let offset = 12;
  let format: { channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        channels: bytes.readUInt16LE(body + 2),
        rate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (
        format === null ||
        format.channels !== 1 ||
        format.rate !== VOICE_SAMPLE_RATE ||
        format.bits !== 16
      ) {
        throw new Error(`WAV must be 16 kHz mono 16-bit, got ${JSON.stringify(format)}`);
      }
      const copy = Buffer.from(bytes.subarray(body, body + Math.min(size, bytes.length - body)));
      return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
};

const run = (
  command: string,
  args: ReadonlyArray<string>,
  stdin?: string,
  live?: Set<NodeChildProcess.ChildProcess>,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    live?.add(child);
    child.on("exit", () => live?.delete(child));
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} exited ${code}: ${err.slice(-400)}`)),
    );
    child.stdin.end(stdin ?? "");
  });

const vocabularyPrompt = (names: ReadonlyArray<string>): string[] =>
  names.length === 0 ? [] : ["--prompt", `Jarvis. ${names.join(", ")}.`];

export const createWhisperCppStt = (input: {
  /** Path to whisper-cli(.exe). */
  readonly binary: string;
  /** Path to a ggml model, e.g. ggml-base.en.bin. */
  readonly model: string;
  readonly language?: string;
  readonly threads?: number;
  /** Names to bias recognition toward: projects, sessions, accounts ("VantageOS, Codex"). */
  readonly vocabulary?: () => ReadonlyArray<string>;
}): SttProvider => ({
  name: "whisper.cpp",
  transcribe: async (pcm) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "baton-voice-"));
    const file = NodePath.join(dir, "utterance.wav");
    try {
      await NodeFSP.writeFile(file, encodeWav(pcm));
      const out = await run(input.binary, [
        "-m",
        input.model,
        "-f",
        file,
        "-l",
        input.language ?? "en",
        "-t",
        String(input.threads ?? 2),
        "-nt",
        "-np",
        ...vocabularyPrompt(input.vocabulary?.() ?? []),
      ]);
      return out.replace(/\s+/g, " ").trim();
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
});

/** OS TTS: SAPI on Windows, `say` on macOS, espeak-ng on Linux. Text goes on stdin, never the command line. */
/** `platform` is the host's (`process.platform` in the desktop main process). */
export const createOsTts = (platform: NodeJS.Platform): TtsProvider => {
  const live = new Set<NodeChildProcess.ChildProcess>();
  return {
    name: `os:${platform}`,
    speak: async (text) => {
      if (text.trim().length === 0) return;
      if (platform === "win32") {
        await run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())",
          ],
          text,
          live,
        );
      } else if (platform === "darwin") {
        await run("say", ["-f", "-"], text, live);
      } else {
        await run("espeak-ng", ["--stdin"], text, live);
      }
    },
    cancel: () => {
      for (const child of live) child.kill();
      live.clear();
    },
  };
};
