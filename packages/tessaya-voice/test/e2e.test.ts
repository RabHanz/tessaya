/* oxlint-disable t3code/no-low-value-comments, t3code/no-test-timeout-or-unreasoned-skip -- Baton file predating upstream's rule (D82) */
/**
 * Recorded WAV → openWakeWord → Silero VAD → whisper.cpp → mode machine →
 * router → the real grammar. Needs the models and whisper-cli; skipped (with
 * the reason) when they are not on this machine. See docs/baton/VOICE.md.
 *
 *   BATON_VOICE_MODELS=<dir with melspectrogram.onnx, embedding_model.onnx,
 *     hey_jarvis_v0.1.onnx, silero_vad.onnx, ggml-base.en.bin>
 *   BATON_WHISPER_CLI=<path to whisper-cli>
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createVoiceCore, type VoiceCoreEvent } from "../src/core.ts";
import { createOpenWakeWordProvider, createSileroVad } from "../src/providers/onnx.ts";
import { createWhisperCppStt, decodeWav } from "../src/providers/speech.ts";
import { createVoiceRouter } from "../src/router.ts";
import { VOICE_FRAME_SAMPLES } from "../src/types.ts";
import { grammarClient } from "./grammarClient.ts";

const models = process.env.BATON_VOICE_MODELS ?? "";
const whisper = process.env.BATON_WHISPER_CLI ?? "";
const need = [
  "melspectrogram.onnx",
  "embedding_model.onnx",
  "hey_jarvis_v0.1.onnx",
  "silero_vad.onnx",
  "ggml-base.en.bin",
];
const ready =
  models !== "" &&
  whisper !== "" &&
  NodeFS.existsSync(whisper) &&
  need.every((f) => NodeFS.existsSync(NodePath.join(models, f)));

const fixture = (name: string) =>
  decodeWav(NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", `${name}.wav`)));

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
/** Word accuracy = 1 − WER, by edit distance over words. */
const wordAccuracy = (expected: string, heard: string) => {
  const a = words(expected);
  const b = words(heard);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return Math.max(0, 1 - d[a.length]![b.length]! / a.length);
};

describe.skipIf(!ready)("voice pipeline end to end (real models)", () => {
  it("wake → VAD → STT → intent on spoken fixtures", { timeout: 180_000 }, async () => {
    const wake = await createOpenWakeWordProvider({
      melspectrogram: NodePath.join(models, "melspectrogram.onnx"),
      embedding: NodePath.join(models, "embedding_model.onnx"),
      wakes: [
        { word: "jarvis", path: NodePath.join(models, "hey_jarvis_v0.1.onnx"), threshold: 0.5 },
      ],
    });
    const vad = await createSileroVad(NodePath.join(models, "silero_vad.onnx"));
    const stt = createWhisperCppStt({
      binary: whisper,
      model: NodePath.join(models, "ggml-base.en.bin"),
      vocabulary: () => ["VantageOS", "The Margin", "Codex", "Claude"],
    });
    const { client, calls } = grammarClient();
    const core = createVoiceCore({ wake, vad, stt, router: createVoiceRouter(client), origin: 0 });
    const events: VoiceCoreEvent[] = [];
    core.subscribe((e) => events.push(e));

    const feed = async (name: string) => {
      const pcm = fixture(name);
      for (let o = 0; o + VOICE_FRAME_SAMPLES <= pcm.length; o += VOICE_FRAME_SAMPLES) {
        core.pushAudio(pcm.slice(o, o + VOICE_FRAME_SAMPLES));
        await wake.drain();
        await vad.drain();
      }
      await core.idle();
      const transcripts = events.filter((e) => e.type === "transcript");
      return transcripts.at(-1)?.type === "transcript" ? transcripts.at(-1)!.text : "";
    };
    const wakes = () => events.filter((e) => e.type === "wake").length;

    const report: string[] = [];
    const cases: Array<[string, string, number]> = [];

    const t1 = await feed("wake-status");
    cases.push(["wake-status", "Hey Jarvis, what is VantageOS doing?", wakes()]);
    report.push(`wake-status: wakes=${wakes()} heard="${t1}"`);
    expect(wakes()).toBe(1);
    expect(calls.find((c) => c.kind === "run")).toBeDefined();
    expect(core.snapshot().machine.conversationTarget).toBe("ws-vantageos");

    const before = wakes();
    const t2 = await feed("followup");
    cases.push(["followup", "Tell it to run the other test too.", wakes() - before]);
    report.push(`followup: wakes=${wakes() - before} heard="${t2}"`);
    // Conversation mode: no wake needed, target inherited.
    expect(calls.findLast((c) => c.kind === "run")?.target).toBe("ws-vantageos");

    const t3 = await feed("dictate");
    cases.push([
      "dictate",
      "Hey Jarvis, dictate. Thanks, I will send the revised version tomorrow.",
      0,
    ]);
    report.push(`dictate: heard="${t3}" mode=${core.snapshot().state}`);
    expect(core.snapshot().state).toBe("dictation");
    const t4 = await feed("stop-dictating");
    cases.push(["stop-dictating", "Stop dictating.", 0]);
    report.push(`stop-dictating: heard="${t4}" mode=${core.snapshot().state}`);
    expect(core.snapshot().machine.mode).not.toBe("dictation");
    // Dictated words never reached the intent path.
    expect(calls.some((c) => c.kind !== "insertText" && /revised/i.test(c.text))).toBe(false);

    // A fresh core, asleep: speech without the wake phrase does nothing.
    wake.reset();
    vad.reset();
    const quiet = createVoiceCore({
      wake,
      vad,
      stt,
      router: createVoiceRouter(grammarClient().client),
      origin: 0,
    });
    const quietEvents: VoiceCoreEvent[] = [];
    quiet.subscribe((e) => quietEvents.push(e));
    const pcm = fixture("no-wake");
    for (let o = 0; o + VOICE_FRAME_SAMPLES <= pcm.length; o += VOICE_FRAME_SAMPLES) {
      quiet.pushAudio(pcm.slice(o, o + VOICE_FRAME_SAMPLES));
      await wake.drain();
      await vad.drain();
    }
    await quiet.idle();
    const falseWakes = quietEvents.filter((e) => e.type === "wake").length;
    report.push(
      `no-wake: wakes=${falseWakes} transcripts=${quietEvents.filter((e) => e.type === "transcript").length}`,
    );
    expect(falseWakes).toBe(0);

    const heard = [t1, t2, t3, t4];
    const acc = cases.map(([, expected], i) =>
      wordAccuracy(
        expected.replace(/^hey jarvis,?\s*/i, ""),
        (heard[i] ?? "").replace(/^hey jarvis,?\s*/i, ""),
      ),
    );
    report.push(
      `word accuracy: ${acc.map((a) => a.toFixed(2)).join(" ")} mean=${(acc.reduce((x, y) => x + y, 0) / acc.length).toFixed(2)}`,
    );
    if (process.env.BATON_VOICE_REPORT)
      NodeFS.writeFileSync(process.env.BATON_VOICE_REPORT, `${report.join("\n")}\n`);
  });
});
