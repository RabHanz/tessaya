// @effect-diagnostics nodeBuiltinImport:off
/**
 * The phone's push-to-talk, server side: a 16 kHz WAV goes through the same speech model the laptop uses, by way of the
 * dictation sidecar's `transcribe` command. A server without the sidecar or the model says so; it never guesses.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { envOf } from "@t3tools/tessaya-shared/envOf";

export const MODEL_FILE = "parakeet-tdt-0.6b-v3-Q8_0.gguf";
export const NOT_AVAILABLE =
  "Voice is not available on this server: it has no speech model here. Type instead.";

/** The sidecar prints one JSON line per file: `{"file":..., "text":...}` or `{"file":..., "error":...}`. */
export const parseTranscript = (stdout: string): string | null => {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as { file?: unknown; text?: unknown };
      if (typeof value.file === "string" && typeof value.text === "string")
        return value.text.trim();
    } catch {
      // Progress lines are not JSON text; skip them.
    }
  }
  return null;
};

export type RunSidecar = (binary: string, args: ReadonlyArray<string>) => Promise<string>;

const execSidecar: RunSidecar = (binary, args) =>
  new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      binary,
      [...args],
      { timeout: 90_000, maxBuffer: 1 << 20, windowsHide: true },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    ),
  );

export type Transcription =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly why: string };

export const transcribeWav = async (input: {
  readonly wav: Uint8Array;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userdataDir: string;
  readonly run?: RunSidecar;
  readonly exists?: (path: string) => boolean;
}): Promise<Transcription> => {
  const exists = input.exists ?? NodeFS.existsSync;
  const binary = envOf("DICTATION", input.env);
  const model =
    envOf("STT_MODEL", input.env) ??
    NodePath.join(input.userdataDir, "voice", "models", MODEL_FILE);
  if (binary === undefined || !exists(binary) || !exists(model))
    return { ok: false, why: NOT_AVAILABLE };
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-phone-"));
  const file = NodePath.join(dir, "say.wav");
  try {
    NodeFS.writeFileSync(file, input.wav, { mode: 0o600 });
    const text = parseTranscript(
      await (input.run ?? execSidecar)(binary, ["transcribe", "--model", model, file]),
    );
    return text === null || text === ""
      ? { ok: false, why: "I could not hear anything in that." }
      : { ok: true, text };
  } catch {
    return { ok: false, why: "The speech model did not answer. Try again, or type." };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};
