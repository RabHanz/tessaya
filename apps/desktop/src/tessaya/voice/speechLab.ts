// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * Baton's real voice path, first-run download included, timed in the app's own process: engine,
 * speaker and hidden-page player. Prints when each sentence's first samples were handed to the page.
 * Run under Electron with LAB_ROOT, LAB_VOICE and LAB_OUT. Needs no window on screen.
 */
/* oxlint-disable t3code/no-global-process-runtime -- standalone lab harness, no Effect runtime */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { createPocketEngine, type PocketVoice } from "./pocketVoice.ts";
import { createVoicePlayer } from "./voicePlayer.ts";
import { createSpeaker, labVoice, type VoicePlayer } from "./voiceSpeaker.ts";

const out = process.env["LAB_OUT"] ?? "lab-speech";
const voice = (process.env["LAB_VOICE"] ?? "quick") as PocketVoice;
NodeFS.mkdirSync(out, { recursive: true });
const log = NodeFS.createWriteStream(NodePath.join(out, `speech-${voice}.jsonl`));
const t0 = Date.now();
const note = (event: string, data: object = {}) =>
  log.write(`${JSON.stringify({ t: Date.now() - t0, event, ...data })}\n`);

const SENTENCES = [
  "Ben Nevis, in the Scottish Highlands, is the tallest mountain in the UK at 1,345 metres.",
  "Your scheduler session has finished, and the tests all passed.",
  "That is the Export button, top right of the toolbar.",
];

Electron.app.whenReady().then(async () => {
  const engine = createPocketEngine({
    root: process.env["LAB_ROOT"] ?? NodePath.join(out, "pocket"),
    platform: process.platform,
    arch: process.arch,
    onProgress: (message) => note("progress", { message }),
  });
  while (engine.synthesise(voice) === null) await new Promise((r) => setTimeout(r, 2_000));
  note("files.ready");
  const real = createVoicePlayer((level) => {
    if (level > 0.01) note("level", { level: Math.round(level * 100) / 100 });
  });
  let said = 0;
  const player: VoicePlayer = {
    ...real,
    play: async (wav) => {
      const n = ++said;
      const started = Date.now();
      const timed = (async function* () {
        let first = true;
        for await (const chunk of wav) {
          if (first) note("first.bytes", { n, waitedMs: Date.now() - started });
          first = false;
          yield chunk;
        }
      })();
      const played = await real.play(timed);
      note("played", { n, played, ms: Date.now() - started });
      return played;
    },
  };
  const speaker = createSpeaker({
    os: {
      name: "os",
      speak: async () => {
        note("FELL.BACK.TO.OS");
      },
    },
    voice: () => labVoice(engine.synthesise(voice)),
    player,
  });
  // The first sentence pays for loading; the pause lets the next ones show the warm figure.
  note("speak");
  await speaker.speak(SENTENCES[0]!);
  await new Promise((r) => setTimeout(r, 1_000));
  note("speak");
  await Promise.all(SENTENCES.map((s) => speaker.speak(s)));
  note("done");
  speaker.dispose();
  engine.dispose();
  log.end(() => {
    NodeFS.writeFileSync(NodePath.join(out, `finished-${voice}.flag`), "1");
    Electron.app.quit();
  });
});
