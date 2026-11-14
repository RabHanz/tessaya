// @effect-diagnostics globalDate:off nodeBuiltinImport:off
/* oxlint-disable t3code/no-low-value-comments -- Baton file predating the rule (D82) */
/**
 * Scores audio with the product's own openWakeWord code. Two ways in:
 *   node wake-score.mjs --models DIR --words a,b,c --list files.txt --out scores.jsonl
 *   tessaya-voice record ... | node wake-score.mjs --models DIR --words a,b,c --stdin --label X --out f.jsonl
 * Audio is never written anywhere. One JSON line per file, or per minute on stdin.
 * Events are counted the way `streamingScorer` fires: over the threshold, then 12 chunks of rest.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { createOpenWakeWordScorer } from "../../../packages/tessaya-voice/src/providers/onnx.ts";

export const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const REFRACTORY_CHUNKS = 12;
const CHUNK_SECONDS = 0.08;

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};

/** Peak and fired events per word, per threshold, and when each first crossing happened. */
export const makeTally = (words: ReadonlyArray<string>) => {
  const rest = words.map(() => THRESHOLDS.map(() => 0));
  const events = words.map(() => THRESHOLDS.map(() => 0));
  const times: Array<Array<number>> = words.map(() => []);
  const peaks = words.map(() => 0);
  let chunks = 0;
  return {
    add: (scores: ReadonlyArray<number>) => {
      scores.forEach((score, w) => {
        peaks[w] = Math.max(peaks[w]!, score);
        THRESHOLDS.forEach((threshold, t) => {
          if (rest[w]![t]! > 0) rest[w]![t]! -= 1;
          else if (score >= threshold) {
            events[w]![t]! += 1;
            rest[w]![t] = REFRACTORY_CHUNKS;
            if (threshold === 0.3) times[w]!.push(Math.round(chunks * CHUNK_SECONDS * 100) / 100);
          }
        });
      });
      chunks += 1;
    },
    result: () => ({
      seconds: chunks * CHUNK_SECONDS,
      words: Object.fromEntries(
        words.map((word, w) => [
          word,
          {
            peak: peaks[w],
            times: times[w],
            events: Object.fromEntries(THRESHOLDS.map((t, i) => [t, events[w]![i]])),
          },
        ]),
      ),
    }),
  };
};

const main = async () => {
  const dir = flag("--models")!;
  const words = flag("--words")!.split(",");
  const scorer = await createOpenWakeWordScorer({
    melspectrogram: NodePath.join(dir, "melspectrogram.onnx"),
    embedding: NodePath.join(dir, "embedding_model.onnx"),
    wakes: words.map((word) => ({
      word,
      path: NodePath.join(dir, `${word}.onnx`),
      threshold: 0.5,
    })),
  });
  const out = NodeFS.createWriteStream(flag("--out")!, { flags: "a" });
  const list = flag("--list");

  if (list !== undefined) {
    for (const file of NodeFS.readFileSync(list, "utf8").split(/\r?\n/).filter(Boolean)) {
      scorer.reset();
      const tally = makeTally(words);
      const wav = NodeFS.readFileSync(file);
      const data = wav.indexOf("data", 12) + 8;
      const pcm = new Int16Array(
        wav.buffer.slice(
          wav.byteOffset + data,
          wav.byteOffset + wav.length - ((wav.length - data) % 2),
        ),
      );
      for (let at = 0; at + scorer.chunkSamples <= pcm.length; at += scorer.chunkSamples) {
        tally.add(await scorer.score(pcm.subarray(at, at + scorer.chunkSamples)));
      }
      out.write(`${JSON.stringify({ file, ...tally.result() })}\n`);
    }
    return;
  }

  const label = flag("--label") ?? "stdin";
  let tally = makeTally(words);
  let held = Buffer.alloc(0);
  let busy: Promise<void> = Promise.resolve();
  const bytes = scorer.chunkSamples * 2;
  process.stdin.on("data", (data: Buffer) => {
    held = Buffer.concat([held, data]);
    while (held.length >= bytes) {
      const chunk = new Int16Array(scorer.chunkSamples);
      Buffer.from(chunk.buffer).set(held.subarray(0, bytes));
      held = held.subarray(bytes);
      busy = busy.then(async () => {
        tally.add(await scorer.score(chunk));
        if (tally.result().seconds >= 60) {
          out.write(
            `${JSON.stringify({ label, at: new Date().toISOString(), ...tally.result() })}\n`,
          );
          tally = makeTally(words);
        }
      });
    }
  });
  await new Promise((resolve) => process.stdin.on("end", resolve));
  await busy;
};

await main();
