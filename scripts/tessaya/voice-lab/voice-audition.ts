// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Casting by ear: every Pocket TTS English voice says three of her lines into <out>/voices/<name>-1..3.wav, and the
 * spellings of her name go into <out>/pronounce/, with <out>/index.html to play them. Files come down hash-checked on
 * first use, as the app fetches them. Pocket TTS is a Windows build; on the laptop (Node 22.13):
 *   node --experimental-strip-types voice-audition.ts --pocket <voice\pocket> --out <dir> [--voices anna,eve] [--candidates "A,B"]
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  createPocketEngine,
  POCKET_ALL_VOICES,
  type PocketVoice,
} from "../../../apps/desktop/src/tessaya/voice/pocketVoice.ts";
import { pronounce } from "../../../packages/tessaya-shared/src/pronounce.ts";
import { speakableText } from "../../../apps/desktop/src/tessaya/voice/voiceSpeaker.ts";
import {
  candidateFile,
  joinWavs,
  pitchOfWav,
  TESSAYA_CANDIDATES,
  voiceKind,
} from "./voiceLabAudio.ts";

const LINES = [
  "Tessaya here, what do you need?",
  "Two builds passed; the deploy finishes at 2 pm.",
  "Nothing is lost while it restarts: what you said is kept, and I will pick up from the last thing you asked for once it is back.",
];
/** Her name in three of the shapes she says it, for each spelling. */
const NAME_LINES = [
  "Tessaya here, what do you need?",
  "Tessaya, what time is it?",
  "Ask Tessaya to read it back.",
];

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
const kb = (file: string) => `${Math.round(NodeFS.statSync(file).size / 1024)} KB`;

const main = async () => {
  const root = flag("--pocket");
  const out = flag("--out");
  if (root === undefined || out === undefined) throw new Error("Needs --pocket and --out.");
  const voices = (
    flag("--voices")
      ?.split(",")
      .map((v) => v.trim()) ?? [...POCKET_ALL_VOICES]
  ).filter((v): v is (typeof POCKET_ALL_VOICES)[number] =>
    (POCKET_ALL_VOICES as ReadonlyArray<string>).includes(v),
  );
  const candidates = flag("--candidates")
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean) ?? [...TESSAYA_CANDIDATES];
  NodeFS.mkdirSync(NodePath.join(out, "voices"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(out, "pronounce"), { recursive: true });
  const makeEngine = () =>
    createPocketEngine({
      root,
      // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
      platform: process.platform,
      // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
      arch: process.arch,
      onProgress: (message) => message !== null && console.error(message),
      onExit: ({ code, stderr }) =>
        code !== 0 && code !== null && console.error(`Pocket exited with ${code}:\n${stderr}`),
    });
  let engine = makeEngine();
  /** Pocket's own WAV for one line, as it would play; a crashed engine is started afresh, twice at most. */
  const say = async (voice: PocketVoice, text: string): Promise<Buffer> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const synth = engine.synthesise(voice);
        if (synth === null) throw new Error(`Pocket TTS did not start with ${voice}.`);
        const chunks: Buffer[] = [];
        for await (const chunk of synth(speakableText(pronounce(text))).stream) chunks.push(chunk);
        return Buffer.concat(chunks);
      } catch (error) {
        if (attempt >= 2) throw error;
        console.error(
          `${voice}: ${error instanceof Error ? error.message : String(error)}; restarting Pocket`,
        );
        engine.dispose();
        engine = makeEngine();
        await engine.ensure(voice);
      }
    }
  };
  try {
    const cards: string[] = [];
    for (const voice of voices) {
      if (!(await engine.ensure(voice))) {
        console.error(`${voice}: not available here, skipped`);
        continue;
      }
      const files: string[] = [];
      const pitches: number[] = [];
      for (const [i, line] of LINES.entries()) {
        const file = NodePath.join(out, "voices", `${voice}-${i + 1}.wav`);
        // A rerun keeps what an earlier run made and carries on from the first missing line.
        const wav = NodeFS.existsSync(file) ? NodeFS.readFileSync(file) : await say(voice, line);
        NodeFS.writeFileSync(file, wav);
        files.push(file);
        const hz = pitchOfWav(wav);
        if (hz !== null) pitches.push(hz);
      }
      pitches.sort((a, b) => a - b);
      const hz = pitches[Math.floor(pitches.length / 2)] ?? null;
      console.log(`${voice}: ${voiceKind(hz)}${hz === null ? "" : `, ${Math.round(hz)} Hz`}`);
      cards.push(
        `<section><h2>${voice}</h2><p>${voiceKind(hz)}${hz === null ? "" : ` (about ${Math.round(hz)} Hz)`}, a guess from the pitch</p>${files
          .map(
            (file, i) =>
              `<p>${escapeHtml(LINES[i] ?? "")}<br><audio controls preload="none" src="voices/${NodePath.basename(file)}"></audio> <small>${kb(file)}</small></p>`,
          )
          .join("")}</section>`,
      );
    }
    // Her name in Tessaya's own voice (anna) unless --name-voice picks another.
    const nameVoice = (flag("--name-voice") ?? "anna") as PocketVoice;
    const spellings: string[] = [];
    if (await engine.ensure(nameVoice))
      for (const [i, candidate] of candidates.entries()) {
        const file = NodePath.join(out, "pronounce", candidateFile(i, candidate));
        if (!NodeFS.existsSync(file)) {
          const clips: Buffer[] = [];
          for (const line of NAME_LINES)
            clips.push(await say(nameVoice, line.replaceAll("Tessaya", candidate)));
          NodeFS.writeFileSync(file, joinWavs(clips));
        }
        spellings.push(
          `<p><b>${escapeHtml(candidate)}</b><br><audio controls preload="none" src="pronounce/${NodePath.basename(file)}"></audio> <small>${kb(file)}</small></p>`,
        );
      }
    const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Voice audition</title>
<style>body{font:15px system-ui,sans-serif;margin:16px;max-width:900px;background:#fff;color:#111}section{border:1px solid #ccc;border-radius:8px;padding:8px 12px;margin:12px 0}h2{margin:4px 0}audio{width:100%;max-width:420px}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}section{border-color:#444}}</style>
<h1>Voice audition</h1><p>Pocket TTS (Kyutai), each English voice saying three of her lines. Voices: CC BY 4.0 via kyutai/pocket-tts-without-voice-cloning; cosette and jean come from non-commercial recordings (Expresso, EARS).</p>
<h2>Her name</h2><p>Aim: tess-AY-uh, the middle syllable rhyming with "say". Voice: ${nameVoice}.</p>${spellings.join("")}
${cards.join("\n")}`;
    NodeFS.writeFileSync(NodePath.join(out, "index.html"), page);
    console.log(`Wrote ${NodePath.join(out, "index.html")}`);
  } finally {
    engine.dispose();
  }
};

await main();
