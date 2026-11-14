/* oxlint-disable t3code/no-low-value-comments -- Baton file predating the rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
/**
 * A test microphone: with BATON_TEST_WAV set, the voice loop hears recorded files, in order, at real-time
 * pace, then silence, in place of the microphone. The wake scorer, the speech detector, the recogniser and
 * the pill all run as they do for a person speaking. The variable does nothing unless it is set.
 *
 * BATON_TEST_WAV is a folder of 16 kHz mono WAV files (played by name), or a text file with one entry per
 * line: a WAV path (relative to the file), optionally followed by the silence to leave after it in
 * milliseconds, or a bare number for silence alone. `#` starts a comment.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { makeFramer, parseWav, toVoicePcm } from "./pcm.ts";
import { VOICE_FRAME_SAMPLES, type AudioInputProvider } from "./voiceTypes.ts";

export type TestAudioItem =
  | { readonly kind: "wav"; readonly path: string }
  | { readonly kind: "silence"; readonly ms: number };

export type TestAudioEvent =
  | { readonly type: "start"; readonly source: string; readonly items: number }
  | { readonly type: "file"; readonly path: string; readonly index: number }
  | { readonly type: "silence"; readonly ms: number }
  | { readonly type: "end" };

/** The entries of a listing file. Pure. */
export const parseTestScript = (text: string, baseDir: string): ReadonlyArray<TestAudioItem> =>
  text.split(/\r?\n/).flatMap((raw): ReadonlyArray<TestAudioItem> => {
    const line = raw.replace(/#.*/, "").trim();
    if (line === "") return [];
    if (/^\d+$/.test(line)) return [{ kind: "silence", ms: Number(line) }];
    const tail = /^(.*?)\s+(\d+)$/.exec(line);
    const file = tail === null ? line : tail[1]!;
    const wav: TestAudioItem = {
      kind: "wav",
      path: NodePath.isAbsolute(file) ? file : NodePath.join(baseDir, file),
    };
    return tail === null ? [wav] : [wav, { kind: "silence", ms: Number(tail[2]) }];
  });

/** What BATON_TEST_WAV names: a folder's WAV files by name, or a listing file. */
export const testAudioItems = (source: string): ReadonlyArray<TestAudioItem> => {
  if (NodeFS.statSync(source).isDirectory()) {
    return NodeFS.readdirSync(source)
      .filter((name) => name.toLowerCase().endsWith(".wav"))
      .sort()
      .map((name) => ({ kind: "wav", path: NodePath.join(source, name) }));
  }
  return parseTestScript(NodeFS.readFileSync(source, "utf8"), NodePath.dirname(source));
};

const FRAME_MS = (VOICE_FRAME_SAMPLES * 1000) / 16_000;

/** Real time: each frame is released when its moment comes, so the pace does not drift. */
const realTimePace = () => {
  const origin = Date.now();
  let count = 0;
  return async () => {
    count += 1;
    const wait = origin + count * FRAME_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
};

export const makeTestAudioInput = (input: {
  readonly source: string;
  readonly onEvent: (event: TestAudioEvent) => void;
  /** Awaited before every frame. Real time by default; tests pass an immediate one. */
  readonly pace?: () => () => Promise<void>;
}): AudioInputProvider => {
  let stopped = false;
  return {
    listDevices: async () => [{ deviceId: "test-audio", label: "Test audio files" }],
    start: async ({ onFrame }) => {
      stopped = false;
      const items = testAudioItems(input.source);
      const tick = (input.pace ?? realTimePace)();
      const silent = new Int16Array(VOICE_FRAME_SAMPLES);
      input.onEvent({ type: "start", source: input.source, items: items.length });
      // Plays in the background: the loop starts at once, as it does with a microphone.
      void (async () => {
        let index = 0;
        for (const item of items) {
          if (stopped) return;
          if (item.kind === "silence") {
            input.onEvent({ type: "silence", ms: item.ms });
            for (let t = 0; t < item.ms && !stopped; t += FRAME_MS) {
              await tick();
              onFrame(silent);
            }
            continue;
          }
          input.onEvent({ type: "file", path: item.path, index });
          index += 1;
          const wav = parseWav(new Uint8Array(NodeFS.readFileSync(item.path)));
          const frames: Int16Array[] = [];
          makeFramer((frame) => frames.push(frame))(
            toVoicePcm(wav.samples, wav.channels, wav.sampleRate),
          );
          for (const frame of frames) {
            if (stopped) return;
            await tick();
            onFrame(frame);
          }
        }
        input.onEvent({ type: "end" });
        // Then silence, for as long as the app runs: timers and the window's end still need audio time.
        while (!stopped) {
          await tick();
          onFrame(silent);
        }
      })();
    },
    stop: async () => {
      stopped = true;
    },
  };
};
