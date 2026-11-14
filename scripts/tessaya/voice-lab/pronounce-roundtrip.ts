// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Pocket TTS says each line as today and through `pronounce`, Parakeet hears it back, word error to report.md. Windows:
 *   node --experimental-strip-types pronounce-roundtrip.ts --pocket <voice\pocket> --sidecar tessaya-voice.exe --model <parakeet .gguf> --out <dir>
 * --word Tessaya scores spellings instead (voiceLabAudio's, or --candidates "A,B"); --save-wav <dir> keeps each as one WAV.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { encodeWav } from "../../../packages/tessaya-voice/src/providers/speech.ts";
import { parseWav, toVoicePcm } from "../../../apps/desktop/src/baton/voice/pcm.ts";
import {
  createPocketEngine,
  type PocketVoice,
} from "../../../apps/desktop/src/baton/voice/pocketVoice.ts";
import { pronounce } from "../../../packages/tessaya-shared/src/pronounce.ts";
import { speakableText } from "../../../apps/desktop/src/baton/voice/voiceSpeaker.ts";
import { candidateFile, joinWavs, TESSAYA_CANDIDATES } from "./voiceLabAudio.ts";

/**
 * A line she might say, and how a person hearing it would write it down. `ownForm`: that reference is the pass's own
 * rewrite (a time, a path, a link), so the line is shown but left out of the mean, which it would win by construction.
 */
const LINES: ReadonlyArray<{
  readonly text: string;
  readonly heard: string;
  readonly ownForm?: true;
}> = [
  { text: "Tessaya here, what do you need?", heard: "Tessaya here what do you need" },
  { text: "Ask Freya to read it back.", heard: "Ask Freya to read it back" },
  { text: "Baton restarted and T3 is up.", heard: "Baton restarted and T3 is up" },
  { text: "The VPN is down again.", heard: "The VPN is down again" },
  { text: "CI failed on the PR.", heard: "CI failed on the PR" },
  { text: "The API key is in the URL.", heard: "The API key is in the URL" },
  { text: "Run the SQL query first.", heard: "Run the SQL query first" },
  {
    text: "The call is at 9:30 GMT+5.",
    heard: "The call is at nine thirty GMT plus five",
    ownForm: true,
  },
  { text: "It starts at 14:00 UTC.", heard: "It starts at two pm UTC", ownForm: true },
  {
    text: "The deadline is 2026-11-07.",
    heard: "The deadline is seven November twenty twenty six",
  },
  {
    text: "Version 0.1.73 is installed.",
    heard: "Version zero point one point seventy three is installed",
  },
  {
    text: "I changed apps/desktop/src/core.ts for you.",
    heard: "I changed core dot ts for you",
    ownForm: true,
  },
  {
    text: "It is at https://github.com/acme/app/pull/12 now.",
    heard: "It is at github dot com now",
    ownForm: true,
  },
  { text: "Done ✅ and shipped 🚀.", heard: "Done and shipped" },
  // 0.1.74: paths say only the file, and each extension the way he says it.
  {
    text: "A conflict in two files, .github/SECURITY.md and apps/web/public/manifest.webmanifest.",
    heard: "A conflict in two files security dot MD and manifest dot web manifest",
  },
  {
    text: "Open package.json and config.yaml.",
    heard: "Open package dot json and config dot yaml",
  },
  {
    text: "It is in state.sqlite; run setup.ps1.",
    heard: "It is in state dot SQLite run setup dot PS1",
  },
  { text: "Edit Pill.tsx and core.ts.", heard: "Edit pill dot TSX and core dot TS" },
  {
    text: "Check main.py, build.rs and Cargo.toml.",
    heard: "Check main dot py build dot RS and cargo dot toml",
  },
  {
    text: "See index.html, app.css and logo.svg.",
    heard: "See index dot HTML app dot CSS and logo dot SVG",
  },
  {
    text: "Then icon.png, boot.mjs and voice.exe.",
    heard: "Then icon dot PNG boot dot MJS and voice dot exe",
  },
  {
    text: "Keep .env, yarn.lock, out.log and build.zip.",
    heard: "Keep dot env yarn dot lock out dot log and build dot zip",
  },
  {
    text: "**Two things:** the build, and the deploy.",
    heard: "Two things the build and the deploy",
  },
];

const ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const TENS = "  twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

/** 0–9999 as words, the way Parakeet may write a number either way. */
const spellNumber = (n: number): string => {
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 === 0 ? "" : ` ${ONES[n % 10]}`}`;
  if (n < 1000)
    return `${ONES[Math.floor(n / 100)]} hundred${n % 100 === 0 ? "" : ` ${spellNumber(n % 100)}`}`;
  // Years the way they are said: 2026 is "twenty twenty six".
  if (n >= 1100 && n < 10_000 && n % 100 !== 0)
    return `${spellNumber(Math.floor(n / 100))} ${spellNumber(n % 100)}`;
  return `${spellNumber(Math.floor(n / 1000))} thousand${n % 1000 === 0 ? "" : ` ${spellNumber(n % 1000)}`}`;
};

/** Words to compare: lower case, numbers spelt out, and spelt-out letters ("v p n") joined back into one word. */
const wordsOf = (text: string): string[] => {
  const words = text
    .toLowerCase()
    .replace(/(\d+)/g, (digits) => ` ${spellNumber(Number(digits))} `)
    .replace(/[^a-z' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  let letters = false;
  for (const [i, word] of words.entries()) {
    if (word.length === 1 && letters) {
      out[out.length - 1] += word;
      continue;
    }
    out.push(word);
    // "a" and "I" are words; they start a run of letters only when another letter follows ("a p i").
    letters = word.length === 1 && (!/^[ai]$/.test(word) || words[i + 1]?.length === 1);
  }
  return out;
};

/** Word error rate of what was heard against the reference. */
const wordError = (reference: string, hypothesis: string): number => {
  const r = wordsOf(reference);
  const h = wordsOf(hypothesis);
  const row = Array.from({ length: h.length + 1 }, (_, i) => i);
  for (let i = 1; i <= r.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= h.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (r[i - 1] === h[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return r.length === 0 ? 0 : row[h.length]! / r.length;
};

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};

/** Sentences that say `word`, for comparing spellings of it: his lines first, then two of the usual shapes. */
const sentencesWith = (word: string): string[] => [
  ...LINES.filter((line) => new RegExp(`\\b${word}\\b`, "i").test(line.text)).map(
    (line) => line.text,
  ),
  `${word}, what time is it?`,
  `Ask ${word} to read it back.`,
];

const pct = (n: number) => `${Math.round(n * 100)}%`;

const main = async () => {
  const pocketRoot = flag("--pocket");
  const sidecar = flag("--sidecar");
  const model = flag("--model");
  const out = flag("--out");
  const voice = (flag("--voice") ?? "anna") as PocketVoice;
  // Candidate mode: --word Tessaya --candidates "Tessaya,Tessayah,Tess-AY-ya,Tessaiya" scores each spelling.
  const word = flag("--word");
  const candidates =
    flag("--candidates")
      ?.split(",")
      .map((c) => c.trim())
      .filter(Boolean) ?? (word === undefined ? undefined : [...TESSAYA_CANDIDATES]);
  const saveWav = flag("--save-wav");
  if (pocketRoot === undefined || sidecar === undefined || model === undefined || out === undefined)
    throw new Error("Needs --pocket, --sidecar, --model and --out.");
  if (word === undefined && candidates !== undefined) throw new Error("--candidates needs --word.");
  NodeFS.mkdirSync(out, { recursive: true });
  const engine = createPocketEngine({
    root: pocketRoot,
    // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
    platform: process.platform,
    // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
    arch: process.arch,
    onProgress: (message) => message !== null && console.error(message),
  });
  try {
    if (!(await engine.ensure(voice))) throw new Error(`Pocket TTS has no ${voice} voice here.`);
    const synth = engine.synthesise(voice);
    if (synth === null) throw new Error("Pocket TTS did not start.");
    /** Pocket's own audio for each file said, for --save-wav. */
    const spoken = new Map<string, Buffer>();
    /** Her voice says `text` into `name`.wav (16 kHz mono, as the sidecar takes it). */
    const say = async (text: string, name: string): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const chunk of synth(text).stream) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const wav = parseWav(raw);
      const file = NodePath.join(out, `${name}.wav`);
      NodeFS.writeFileSync(file, encodeWav(toVoicePcm(wav.samples, wav.channels, wav.sampleRate)));
      spoken.set(file, raw);
      return file;
    };
    /** What Parakeet hears in each file. */
    const hear = (files: ReadonlyArray<string>): Map<string, string> => {
      const list = NodePath.join(out, "clips.txt");
      NodeFS.writeFileSync(list, `${files.join("\n")}\n`);
      const run = NodeChildProcess.spawnSync(
        sidecar,
        ["transcribe", "--model", model, "--language", "en", "--list", list],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      if (run.status !== 0) throw new Error(`The sidecar failed: ${run.stderr}`);
      const heard = new Map<string, string>();
      for (const row of run.stdout.split("\n")) {
        if (!row.startsWith("{")) continue;
        const parsed = JSON.parse(row) as { readonly file?: string; readonly text?: string };
        if (parsed.file !== undefined) heard.set(parsed.file, parsed.text ?? "");
      }
      return heard;
    };

    if (word !== undefined && candidates !== undefined) {
      // Each spelling said in the same sentences; the one heard back as the word, written as he writes it, wins.
      const sentences = sentencesWith(word);
      const files = new Map<string, string>();
      for (const [c, candidate] of candidates.entries())
        for (const [i, sentence] of sentences.entries())
          files.set(
            `${c}:${i}`,
            await say(speakableText(pronounce(sentence, { [word]: candidate })), `cand-${c}-${i}`),
          );
      if (saveWav !== undefined) {
        NodeFS.mkdirSync(saveWav, { recursive: true });
        for (const [c, candidate] of candidates.entries())
          NodeFS.writeFileSync(
            NodePath.join(saveWav, candidateFile(c, candidate)),
            joinWavs(
              sentences
                .map((_, i) => spoken.get(files.get(`${c}:${i}`) ?? ""))
                .filter((b): b is Buffer => b !== undefined),
            ),
          );
      }
      const heard = hear([...files.values()]);
      const rows = candidates.map((candidate, c) => {
        const back = sentences.map((_, i) => heard.get(files.get(`${c}:${i}`) ?? "") ?? "");
        const wer = sentences.reduce(
          (sum, sentence, i) => sum + wordError(sentence, back[i] ?? ""),
          0,
        );
        return { candidate, back, wer: wer / sentences.length };
      });
      rows.sort((x, y) => x.wer - y.wer);
      const report = [
        `Spellings of "${word}", voice ${voice}: each said in ${sentences.length} sentences, heard back by Parakeet (${NodePath.basename(model)}).`,
        "",
        `| Spelling | Mean WER | ${sentences.map((_, i) => `Heard ${i + 1}`).join(" | ")} |`,
        `| --- | --- | ${sentences.map(() => "---").join(" | ")} |`,
        ...rows.map((r) => `| ${r.candidate} | ${pct(r.wer)} | ${r.back.join(" | ")} |`),
        "",
        ...sentences.map((sentence, i) => `${i + 1}. ${sentence}`),
        "",
      ].join("\n");
      NodeFS.writeFileSync(NodePath.join(out, "candidates.json"), JSON.stringify(rows, null, 2));
      NodeFS.writeFileSync(NodePath.join(out, "candidates.md"), report);
      console.log(report);
      return;
    }

    const files: string[] = [];
    for (const [index, line] of LINES.entries()) {
      for (const pass of ["before", "after"] as const) {
        const text =
          pass === "before" ? speakableText(line.text) : speakableText(pronounce(line.text));
        files.push(await say(text, `${String(index).padStart(2, "0")}-${pass}`));
      }
    }
    const heard = hear(files);
    const results = LINES.map((line, index) => {
      const of = (pass: "before" | "after") =>
        heard.get(NodePath.join(out, `${String(index).padStart(2, "0")}-${pass}.wav`)) ?? "";
      return {
        text: line.text,
        heard: line.heard,
        before: {
          said: speakableText(line.text),
          back: of("before"),
          wer: wordError(line.heard, of("before")),
        },
        after: {
          said: speakableText(pronounce(line.text)),
          back: of("after"),
          wer: wordError(line.heard, of("after")),
        },
      };
    });
    const scored = results.filter((_, index) => LINES[index]?.ownForm !== true);
    const mean = (pass: "before" | "after") =>
      scored.reduce((sum, r) => sum + r[pass].wer, 0) / Math.max(scored.length, 1);
    const report = [
      `Round trip, voice ${voice}: Pocket TTS, then Parakeet (${NodePath.basename(model)}).`,
      "",
      "| Line | Heard before | WER | Heard after | WER |",
      "| --- | --- | --- | --- | --- |",
      ...results.map(
        (r, index) =>
          `| ${r.text.replaceAll("|", "/")}${LINES[index]?.ownForm === true ? " (not in the mean)" : ""} | ${r.before.back} | ${pct(r.before.wer)} | ${r.after.back} | ${pct(r.after.wer)} |`,
      ),
      `| **Mean of ${scored.length} lines** | | **${pct(mean("before"))}** | | **${pct(mean("after"))}** |`,
      "",
    ].join("\n");
    NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(results, null, 2));
    NodeFS.writeFileSync(NodePath.join(out, "report.md"), report);
    console.log(report);
  } finally {
    engine.dispose();
  }
};

await main();
