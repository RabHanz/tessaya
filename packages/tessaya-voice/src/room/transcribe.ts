// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
/**
 * `node transcribe.mjs [--engine sensevoice|parakeet] <file> > out.txt`: one `[mm:ss] words` line per speech stretch.
 * Nice 19, one file at a time per host, one stretch in memory. `parakeet` shares the room's recogniser with live turns.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { createSileroScorer } from "../providers/onnx.ts";
import { adoptTesselNames } from "./envNames.ts";
import { createFileSegmenter, stamp, type FileSegment } from "./fileSegments.ts";
import { recogniserTurn } from "./recogniserTurn.ts";
import { createSenseVoice } from "./senseVoice.ts";

const fail = (line: string): never => {
  process.stderr.write(`transcribe: ${line}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const engineAt = args.indexOf("--engine");
const engine = engineAt >= 0 ? args.splice(engineAt, 2)[1] : "sensevoice";
const file = args[0];
if (file === undefined || args.length !== 1 || (engine !== "sensevoice" && engine !== "parakeet"))
  fail("usage: transcribe.mjs [--engine sensevoice|parakeet] <audio or video file>");
if (!NodeFS.existsSync(file!)) fail(`no such file: ${file}`);

if (process.env["TESSEL_TRANSCRIBE_LOCKED"] !== "1") {
  const lock = NodePath.join(NodeOS.tmpdir(), `tessel-transcribe-${NodeOS.userInfo().uid}.lock`);
  const run = NodeChildProcess.spawnSync(
    "nice",
    ["-n", "19", "flock", lock, process.execPath, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, TESSEL_TRANSCRIBE_LOCKED: "1" } },
  );
  process.exit(run.status ?? 1);
}

// The bundle sits in ~/r1-voice/app: the loop's env file and models are beside it.
const home = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
if (NodeFS.existsSync(NodePath.join(home, "env"))) process.loadEnvFile(NodePath.join(home, "env"));
adoptTesselNames(process.env);
const models = process.env["R1_MODELS"] ?? NodePath.join(home, "models");
const model = (name: string) => NodePath.join(models, name);

const recognise = async (): Promise<(pcm: Int16Array) => Promise<string>> => {
  if (engine === "sensevoice") {
    const sense = await createSenseVoice({
      modelPath: model("sensevoice.int8.onnx"),
      tokensPath: model("sensevoice.tokens.txt"),
      threads: Number(process.env["R1_ONNX_THREADS"] ?? "2"),
      itn: true,
    });
    // Half a second of silence after a stretch keeps SenseVoice from clipping its last word ("riot" read as "Ri").
    const tail = new Int16Array(8_000);
    return async (pcm) => {
      const padded = new Int16Array(pcm.length + tail.length);
      padded.set(pcm);
      return (await sense.analyse(padded)).text;
    };
  }
  const url = process.env["R1_RECOGNIZER_URL"] ?? fail("R1_RECOGNIZER_URL is not set");
  const tokenFile =
    process.env["R1_RECOGNIZER_TOKEN_FILE"] ?? fail("R1_RECOGNIZER_TOKEN_FILE is not set");
  const token = NodeFS.readFileSync(tokenFile, "utf8").trim();
  return async (pcm) => {
    const turn = recogniserTurn(url, token);
    turn.feed(pcm);
    const text = await turn.finish();
    if (turn.failed()) fail(`the recogniser at ${url} failed a stretch`);
    return text;
  };
};

const main = async () => {
  const started = Date.now();
  const words = await recognise();
  const vad = await createSileroScorer(model("silero_vad.onnx"));
  const segmenter = createFileSegmenter();
  const write = async (segment: FileSegment | null) => {
    if (segment === null) return;
    const text = (await words(segment.pcm)).trim();
    if (text !== "") process.stdout.write(`${stamp(segment.start)} ${text}\n`);
  };
  const ffmpeg = NodeChildProcess.spawn(
    "ffmpeg",
    ["-nostdin", "-v", "error", "-i", file!, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = new Promise<number | null>((resolve) => ffmpeg.on("close", resolve));
  const window = new Int16Array(vad.chunkSamples);
  let filled = 0;
  let samples = 0;
  let rest: Buffer = Buffer.alloc(0);
  // Awaiting each window holds ffmpeg back through the pipe, so the whole file is never in memory.
  for await (const chunk of ffmpeg.stdout as AsyncIterable<Buffer>) {
    const bytes = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % 2);
    for (let i = 0; i < whole; i += 2) {
      window[filled++] = bytes.readInt16LE(i);
      if (filled < window.length) continue;
      samples += filled;
      filled = 0;
      await write(segmenter.push(window, await vad.score(window)));
    }
    rest = bytes.subarray(whole);
  }
  await write(segmenter.flush());
  samples += filled;
  if ((await exited) !== 0) fail("ffmpeg could not decode the file");
  const audioS = samples / 16_000;
  const tookS = (Date.now() - started) / 1000;
  process.stderr.write(
    `transcribe: ${audioS.toFixed(0)} s of audio in ${tookS.toFixed(0)} s (real-time factor ${(tookS / audioS).toFixed(2)}), ` +
      `peak memory ${Math.round(process.resourceUsage().maxRSS / 1024)} MB, engine ${engine}\n`,
  );
};

void main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
