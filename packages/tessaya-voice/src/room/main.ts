// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalConsole:off cryptoRandomUUID:off
/**
 * The R1 room loop as a program on the voice host (next to the R1 on his LAN). Everything it needs comes from
 * the environment; secrets are read from files, never from variables or arguments. See deploy/r1-voice/README.md.
 *
 * @module baton-voice/room/main
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeDgram from "node:dgram";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

import { pocketSpeech } from "@t3tools/tessaya-shared/speechSplice";
import { registerSounds } from "@t3tools/tessaya-shared/voiceClips";
import { pocketVoiceUrl } from "@t3tools/tessaya-shared/voiceLibrary";
import { fetchSignedWake, wakeKey } from "@t3tools/tessaya-shared/wakeModels";
import { WAKE_WORDS, wakeModelFile } from "@t3tools/tessaya-shared/wakeWords";

import { gainLimiter, integratedLufs, loudnessGain } from "../loudness.ts";
import { createOpenWakeWordScorer, createSileroScorer } from "../providers/onnx.ts";
import { loadReplayCheck, replayStatusLine } from "../providers/replayOnnx.ts";
import { createSpeakerEmbedder } from "../providers/speakerOnnx.ts";
import {
  ACT_SINGLE_MS,
  CAMPLUS_POLICY,
  decideSpeaker,
  enrol,
  identityOf,
  ownerScoreOf,
  profileScore,
  REPLAY_CUT,
  ROOM_POLICY,
  replayChecked,
  PRINT_MIN_MS,
  profilesFor,
  TEST_SPEAKER_ID,
  trustTestSpeaker,
  UNVERIFIED,
  type SpeakerProfile,
  type VoiceInput,
} from "../speaker.ts";
import { decodeWav } from "../providers/speech.ts";
import { createSpeakerStore, profileToWire, vectorToBase64 } from "../speakerStore.ts";
import type { FleetFingerprint } from "@t3tools/tessaya-contracts";
import { storeOf } from "@t3tools/tessaya-shared/coherence";
import { createLines, type LinesGot } from "./lines.ts";
import { servedVocabulary, VOCABULARY_EVERY_MS } from "./vocabulary.ts";
import { voicesOf } from "./segments.ts";
import { createAmbientPresence } from "./ambientPresence.ts";
import { createResampler24to16, createWavReader } from "./audio.ts";
import { connectMqtt } from "@t3tools/tessaya-shared/mqtt";
import { connectBrainBridge } from "./brainBridge.ts";
import {
  hedge,
  noteTime,
  PERSONAL_BUDGET_MS,
  pickRecogniser,
  recognisersFor,
  turnAcross,
  type RecogniserState,
} from "./recognisers.ts";
import { createProfileSync, parseShared } from "./profileSync.ts";
import {
  createRoomVoice,
  ROOM_CONFIG,
  brainNotReached,
  brainOrLocal,
  loopBuses,
  routeForDevice,
  servedRoster,
  type RecogniserTurn,
  type RoomDeps,
  type RoomPersona,
} from "./roomVoice.ts";
import { recogniserTurn } from "./recogniserTurn.ts";
import { createSenseVoice } from "./senseVoice.ts";
import { createSmartTurn } from "./smartTurn.ts";
import { createPlaybackWindows, PLAYBACK_TOPIC } from "./playbackWindow.ts";
import { createHealthReport, readHost } from "./healthReport.ts";
import { createLinkWatch, parseArp } from "./netReset.ts";
import { createTurnCapture } from "./turnCapture.ts";
import { createSessionTap } from "./sessionTap.ts";
import { farCentroid } from "./farVoice.ts";
import { createMicWatch } from "./micWatch.ts";
import { createWakeCapture } from "./wakeCapture.ts";
import { bothCaptures, createWakeTrace } from "./wakeTrace.ts";
import { createWriteQueue } from "./writeQueue.ts";
import { createWakeStream, kwsSettingsCommand, parseWakeGate } from "./wakeStream.ts";
import { DEVICE } from "@t3tools/tessaya-shared/productNames";
import {
  biasTranscript,
  recogniserTerms,
  type VocabularyEntry,
} from "@t3tools/tessaya-shared/vocabulary";
import { adoptTesselNames } from "./envNames.ts";

const env = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${key} is not set`);
  return v;
};
const secret = (key: string) => NodeFS.readFileSync(env(key), "utf8").trim();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const startedAt = Date.now();
const healthReport = createHealthReport();
/** A fatal stop that is always in the journal: written synchronously to stderr before exiting. */
const fail = (line: string): never => {
  NodeFS.writeSync(2, `${new Date().toISOString()} ${line}\n`);
  process.exit(1);
};

/** CAM++ as the desktop ships it: a profile made with another model is never compared. */
const SPEAKER_MODEL_ID = "campplus-voxceleb-357a834f";
/** A headset profile is made from this many sure clips, and follows the latest this many. */
const INPUT_ENROL_MIN = 5;
const INPUT_ENROL_KEEP = 12;

const models = env("R1_MODELS");
const state = env("R1_STATE");
const model = (file: string) => NodePath.join(models, file);

const listDir = (dir: string): string[] => {
  try {
    return NodeFS.readdirSync(dir).toSorted();
  } catch {
    return [];
  }
};

/**
 * Each voice's sounds from the interjection cache, `<state>/interjections/<voice>/<sound>/<n>.wav`: rendered once by
 * Gemini off the loop (an ops drip job), played here like the built-in clips, which stay where a sound is missing.
 */
const loadInterjections = (): number => {
  const root = NodePath.join(state, "interjections");
  let count = 0;
  for (const voice of listDir(root)) {
    for (const sound of listDir(NodePath.join(root, voice))) {
      const dir = NodePath.join(root, voice, sound);
      let rate = 24_000;
      const variants = listDir(dir)
        .filter((f) => f.endsWith(".wav"))
        .map((f) => {
          const bytes = NodeFS.readFileSync(NodePath.join(dir, f));
          rate = bytes.readUInt32LE(24);
          return createWavReader()(bytes);
        });
      registerSounds(voice, sound, rate, variants);
      count += variants.length;
    }
  }
  return count;
};

/** One health answer from a recogniser: its queue, or null when it did not answer within 1.5 s. */
const health = (url: string, token: string) =>
  new Promise<number | null>((resolve) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);
    const done = (q: number | null) => {
      clearTimeout(timer);
      ws.close();
      resolve(q);
    };
    const timer = setTimeout(() => done(null), 1_500);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ cmd: "health" })));
    ws.addEventListener("message", (e) => {
      const m =
        typeof e.data === "string" ? (JSON.parse(e.data) as { ev?: string; queue?: number }) : {};
      if (m.ev === "health") done(typeof m.queue === "number" ? m.queue : 0);
    });
    ws.addEventListener("error", () => done(null));
  });

/** Faint noise, not silence, so a recogniser really decodes: that is what is slow after a quiet spell. */
const WARM_CLIP = Int16Array.from({ length: 9_600 }, (_, i) => ((i * 7919) % 401) - 200);

/** His recognisers (`R1_RECOGNIZERS=url=tokenfile,...`), each turn to the quickest lately (recognisers.ts). */
const recognisers = (online: () => boolean, terms: () => ReadonlyArray<string>) => {
  const parse = (pairs: string, personal: boolean) =>
    pairs
      .split(",")
      .filter((pair) => pair.trim() !== "")
      .map((pair) => {
        const [url, file] = pair.split("=") as [string, string];
        return {
          url: url.trim(),
          token: NodeFS.readFileSync(file.trim(), "utf8").trim(),
          personal,
        };
      });
  // `R1_PERSONAL_RECOGNIZERS`: the same service running his own model, for his verified turns only (recognisersFor).
  const list = [
    ...parse(
      process.env["R1_RECOGNIZERS"] ??
        `${env("R1_RECOGNIZER_URL")}=${env("R1_RECOGNIZER_TOKEN_FILE")}`,
      false,
    ),
    // `R1_MORE_RECOGNIZERS`: others beside the bundled one (his laptop's), which naming R1_RECOGNIZERS would replace.
    ...parse(process.env["R1_MORE_RECOGNIZERS"] ?? "", false),
    ...parse(process.env["R1_PERSONAL_RECOGNIZERS"] ?? "", true),
  ];
  let states: RecogniserState[] = list.map((r) => ({
    url: r.url,
    queue: 0,
    recent: [],
    personal: r.personal,
  }));
  const refresh = async () => {
    const queues = await Promise.all(list.map((r) => health(r.url, r.token)));
    states = states.map((s, i) => ({ ...s, queue: queues[i] ?? null }));
  };
  void refresh();
  setInterval(() => void refresh(), 2_000);
  const timed = (url: string, ms: number) => {
    states = states.map((s) =>
      s.url === url ? { ...s, recent: noteTime(s.recent, ms, Date.now()) } : s,
    );
  };
  // Each one decodes faint noise at boot and every 45 s while an R1 is online: it stays quick, and its time is live,
  // so the fastest answers whatever the list order and however many are listed (24 Nov: after a restart the first
  // listed, a loaded machine, took 4.5-12 s against another's 0.4 s).
  const probe = () => {
    for (const r of list) {
      const turn = recogniserTurn(r.url, r.token);
      const at = performance.now();
      turn.feed(WARM_CLIP);
      void turn.finish().then(() => turn.failed() || timed(r.url, performance.now() - at));
    }
  };
  probe();
  setInterval(() => online() && probe(), 45_000);
  const status = () => states.map((s) => ({ url: s.url, up: s.queue !== null }));
  const across = (
    poolOf: (states: ReadonlyArray<RecogniserState>) => ReadonlyArray<RecogniserState>,
    vocabulary: ReadonlyArray<string>,
  ): RecogniserTurn =>
    turnAcross(
      (tried) => {
        const pool = poolOf(states.filter((s) => !tried.has(s.url)));
        const chosen = pickRecogniser(pool) ?? pool[0];
        if (chosen === undefined) return null;
        const token = list.find((r) => r.url === chosen.url)!.token;
        return { url: chosen.url, turn: recogniserTurn(chosen.url, token, vocabulary) };
      },
      (url, ms, failed, next, why) => {
        // A failed one counts as very slow, so the next turns leave it alone until its probes are quick again.
        timed(url, failed ? 30_000 : ms);
        const host = url.replace(/^ws:\/\//, "");
        log(
          failed
            ? `recogniser ${host} failed after ${Math.round(ms)} ms (${why ?? "no reason"}); ${next === null ? "no other to try" : `trying ${next.replace(/^ws:\/\//, "")}`}`
            : `recogniser ${host} ${Math.round(ms)} ms`,
        );
      },
      () => performance.now(),
    );
  /** `only`: his personal model alone (the wake check compares the two models), not hedged with a general one. */
  const turn = (owner = false, only = false): RecogniserTurn => {
    const mine = owner && states.some((s) => s.personal === true && s.queue !== null);
    // A wake check hears the name unbiased: favouring his names there would confirm more false wakes.
    const vocabulary = only ? [] : terms();
    if (!mine || only) return across((pool) => recognisersFor(pool, owner), vocabulary);
    return hedge(
      across((pool) => pool.filter((s) => s.personal === true), vocabulary),
      across((pool) => recognisersFor(pool, false), vocabulary),
      () => new Promise((r) => setTimeout(r, PERSONAL_BUDGET_MS)),
      (who) => log(`recogniser hedge: ${who} words taken`),
    );
  };
  return Object.assign(turn, { status });
};

/** Pocket TTS's own server, kept running beside the loop (her voice, as on the desktop). */
/** A few seconds of ordinary speech to measure each voice's loudness by. */
const CALIBRATION =
  "Good morning. The office fan is on now, and the lamp in the study is off. Shall I set a timer for twenty minutes?";

const startPocket = async (voices: ReadonlyArray<string>) => {
  const dir = NodePath.join(models, "pocket", "english");
  const port = Number(env("R1_POCKET_PORT", "58232"));
  const proc = NodeChildProcess.spawn(
    env("R1_POCKET_BIN"),
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--config", "config.yaml"].concat([
      "--default-voice",
      `${env("R1_VOICE", "anna")}.safetensors`,
    ]),
    {
      cwd: dir,
      stdio: "ignore",
      env: { HOME: process.env["HOME"], RAYON_NUM_THREADS: env("R1_TTS_THREADS", "2") },
    },
  );
  proc.on("exit", (code) => fail(`pocket exited (${code}); the loop restarts with it`));
  log("voice: waiting for pocket");
  const since = Date.now();
  for (let i = 0; ; i += 1) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (Date.now() - since > 180_000)
      throw new Error("pocket did not answer its health check in 180 s");
    await new Promise((r) => setTimeout(r, 200));
  }
  const tts = (text: string, signal: AbortSignal, voice?: string) =>
    fetch(`http://127.0.0.1:${port}/tts`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        text,
        // A clone is its own URL already; a library voice is named.
        ...(voice === undefined
          ? {}
          : { voice_url: /^https?:\/\//.test(voice) ? voice : pocketVoiceUrl(voice) }),
      }).toString(),
      signal,
    });
  log(`voice: pocket up in ${Date.now() - since} ms`);
  // Pocket fetches a voice on its first use (about 8 s on the voice host): each persona's is fetched now, in the
  // background, so a slow or failed fetch never holds the loop from starting.
  // The same fetch measures each voice, so every persona is played at one loudness (R1_VOICE_LUFS, default -16).
  const target = Number(process.env["R1_VOICE_LUFS"] ?? "-16");
  const gains = new Map<string, number>();
  const warmed = new Set<string>();
  const warm = async (list: ReadonlyArray<string>) => {
    for (const voice of list) {
      if (warmed.has(voice)) continue;
      warmed.add(voice);
      const at = Date.now();
      await tts(CALIBRATION, AbortSignal.timeout(60_000), voice).then(
        async (r) => {
          const pcm = createResampler24to16()(
            createWavReader()(new Uint8Array(await r.arrayBuffer())),
          );
          const lufs = integratedLufs(pcm, 16_000);
          const gain = loudnessGain(lufs, target);
          gains.set(voice, gain);
          log(
            `voice ${voice} ready in ${Date.now() - at} ms: ${lufs.toFixed(1)} LUFS, ${(20 * Math.log10(gain)).toFixed(1)} dB, now ${integratedLufs(gainLimiter(gain)(pcm), 16_000).toFixed(1)} LUFS (target ${target})`,
          );
        },
        (e: unknown) => {
          warmed.delete(voice);
          log(`voice ${voice} not ready: ${String(e)}`);
        },
      );
    }
  };
  void warm(voices);
  const say = async function* (text: string, signal: AbortSignal, voice?: string) {
    const res = await tts(text, signal, voice);
    if (!res.ok || res.body === null) throw new Error(`voice answered ${res.status}`);
    yield* res.body as unknown as AsyncIterable<Uint8Array>;
  };
  // Her [laughs] or *sighs* is spliced in as the desktop does it; Pocket would read the word aloud (V-041).
  const speak = async function* (
    text: string,
    signal: AbortSignal,
    voice?: string,
    continuing?: boolean,
    breath?: boolean,
  ) {
    const read = createWavReader();
    const down = createResampler24to16();
    const limit = gainLimiter(gains.get(voice ?? "") ?? 1);
    for await (const chunk of pocketSpeech(
      text,
      voice ?? "",
      (t) => say(t, signal, voice),
      continuing,
      breath,
    )) {
      const pcm = down(read(chunk));
      if (pcm.length > 0) yield limit(pcm);
    }
  };
  return { speak, warm };
};

/**
 * Her server's personas on the R1's device key (SPINE-UNIFY §10, P2): his names, voices and looks reach the room.
 * Null when her server is older, unreachable or `R1_SERVED_PERSONAS=0`; the loop keeps what it has.
 */
const servedPersonas = async (url: string, key: string): Promise<RoomPersona[] | null> => {
  if (process.env["R1_SERVED_PERSONAS"] === "0") return null;
  try {
    const res = await fetch(url.replace(/\/chat\/completions$/, "/personas"), {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    const roster = res.ok ? servedRoster(await res.json()) : null;
    return roster === null ? null : Promise.all(roster.map((p) => withClone(p, url, key)));
  } catch {
    return null;
  }
};

/** Clone files fetched from a brain on another machine, kept in memory only, for this machine's Pocket. */
const clones = new Map<string, Uint8Array>();
let clonePort: Promise<number> | null = null;
const cloneServer = () =>
  (clonePort ??= new Promise<number>((resolve, reject) => {
    const server = NodeHttp.createServer((req, res) => {
      const bytes = clones.get(decodeURIComponent((req.url ?? "").replace(/^\/clone\//, "")));
      res.writeHead(bytes === undefined ? 404 : 200, {
        "content-type": "application/octet-stream",
      });
      res.end(bytes);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  }));

const isLoopbackHost = (host: string) => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(host);

/**
 * A persona's saved clone as its voice (M-046): fetched from her brain on the Tessel's key over the tailnet (only for a
 * machine linked there with full access) and served to this machine's Pocket on loopback. A clone she no longer
 * serves leaves the persona its Pocket voice.
 */
const withClone = async (p: RoomPersona, brainUrl: string, key: string): Promise<RoomPersona> => {
  if (p.cloneUrl === undefined) return p;
  const fetchFile = async (path: string): Promise<string | null> => {
    if (isLoopbackHost(new URL(brainUrl).hostname)) {
      const url = new URL(path, brainUrl);
      url.hostname = "127.0.0.1";
      const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) })
        .then(async (r) => (await r.arrayBuffer(), r.ok))
        .catch(() => false);
      return ok ? url.href : null;
    }
    const file = path.split("/").pop() ?? "";
    const bytes = await fetch(brainUrl.replace(/\/chat\/completions$/, `/voice/clone/${file}`), {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
      .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
      .catch(() => null);
    if (bytes === null || bytes.length === 0) {
      clones.delete(file);
      return null;
    }
    clones.set(file, bytes);
    return `http://127.0.0.1:${await cloneServer()}/clone/${encodeURIComponent(file)}`;
  };
  const voice = await fetchFile(p.cloneUrl);
  if (voice === null) return p;
  // Its recorded tones, the same way; a tone that can't be had is left out.
  const tones =
    p.cloneTones === undefined
      ? {}
      : {
          cloneTones: Object.fromEntries(
            (
              await Promise.all(
                Object.entries(p.cloneTones).map(
                  async ([t, u]) => [t, await fetchFile(u)] as const,
                ),
              )
            ).flatMap(([t, u]) => (u === null ? [] : [[t, u]])),
          ),
        };
  return { ...p, voice, ...tones };
};

/** A word the room listens for; `version` is her signed model's, for a word she trained. */
interface RoomWake {
  readonly word: string;
  readonly persona: string;
  readonly file: string;
  readonly threshold: number;
  readonly version?: number;
}

/**
 * Her trained wake words for the roster's personas (SPINE-UNIFY §10, P3c): each word's signed room model from her
 * server, checked against her signature before it is kept. An unsigned or altered model is never loaded; an
 * unreachable server leaves the copy last checked here.
 */
const trainedWakes = async (
  url: string,
  key: string,
  roster: ReadonlyArray<RoomPersona>,
  skip: ReadonlySet<string>,
): Promise<RoomWake[]> => {
  const dir = NodePath.join(state, "wake");
  const keptFile = NodePath.join(dir, "signed.json");
  let kept: Record<string, { version: number; threshold: number }> = {};
  try {
    kept = JSON.parse(NodeFS.readFileSync(keptFile, "utf8")) as typeof kept;
  } catch {
    // none kept yet
  }
  const out: RoomWake[] = [];
  for (const p of roster) {
    const word = wakeKey(p.name);
    if (word === null || skip.has(word)) continue;
    const file = NodePath.join(dir, `${word.replace(/[^a-z0-9]+/g, "_")}.onnx`);
    const got = await fetchSignedWake({
      server: url,
      authorization: `Bearer ${key}`,
      word,
      target: "room",
      have: kept[word]?.version ?? null,
    }).catch(() => (kept[word] === undefined ? null : ("current" as const)));
    if (got === null || (got !== "current" && got.format !== "openwakeword-onnx")) {
      if (got !== null) log(`wake model for ${word} is not one this loop runs: skipped`);
      continue;
    }
    if (got !== "current") {
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(file, got.bytes);
      kept[word] = { version: got.version, threshold: got.threshold };
      NodeFS.writeFileSync(keptFile, JSON.stringify(kept));
      log(`wake model for ${word}: version ${got.version}, signed`);
    }
    if (NodeFS.existsSync(file))
      out.push({
        word: p.name,
        persona: p.id,
        file,
        threshold: kept[word]!.threshold,
        version: kept[word]!.version,
      });
  }
  return out;
};

/**
 * The R1 posts a camera picture to its LAN host (it is not on the tailnet), so this host takes it and hands it to
 * Tessaya's server, which keeps it only while a capture it asked for is armed.
 */
const startCameraRelay = () => {
  const port = Number(process.env["R1_CAMERA_PORT"] ?? "0");
  if (port === 0) return;
  const upload = new URL("/camera/upload", env("R1_BRAIN_URL")).toString();
  NodeHttp.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://r1");
    if (req.method !== "POST" || url.pathname !== "/camera/upload") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4_000_000) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      void fetch(`${upload}${url.search}`, {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "image/jpeg" },
        body: Buffer.concat(chunks),
      }).then(
        (r) => res.writeHead(r.status).end(),
        () => res.writeHead(502).end(),
      );
    });
  }).listen(port, "0.0.0.0", () => log(`camera relay on :${port}`));
};

/**
 * Two idle connections to her server, opened ahead: from the room host a fresh one costs about 0.25 s before the turn's first
 * byte (205 ms round trip, 15 Nov), and an early start he talks past closes the one it took. The server keeps them 95 s.
 */
const link = (url: string): NonNullable<RoomDeps["link"]> => {
  const health = new URL("/api/health", url).toString();
  let at = 0;
  return () => {
    if (Date.now() - at < 2000) return;
    at = Date.now();
    const sent = performance.now();
    for (let i = 0; i < 2; i += 1)
      void fetch(health, { signal: AbortSignal.timeout(5000) })
        .then((res) => res.arrayBuffer())
        .then(() => i === 0 && healthReport.rtt(performance.now() - sent))
        .catch(() => undefined);
  };
};

// Stamped by the bundle build (scripts/tessaya/build-r1-voice.sh); absent when run from source.
declare const __TESSAYA_LOOP_VERSION__: string | undefined;
declare const __TESSAYA_BUILD_COMMIT__: string | undefined;
/** What this loop believes, for the brain's fleet check (M-146): its build, its brain and its copy of the voices. */
const loopFingerprint = (
  host: string,
  profiles: ReadonlyArray<SpeakerProfile>,
): FleetFingerprint => ({
  id: `loop:${host}`,
  name: `the room loop on ${host}`,
  kind: "loop",
  host,
  version: typeof __TESSAYA_LOOP_VERSION__ === "undefined" ? "source" : __TESSAYA_LOOP_VERSION__,
  commit: (typeof __TESSAYA_BUILD_COMMIT__ === "undefined" ? "" : __TESSAYA_BUILD_COMMIT__) || null,
  startedAt,
  brain: `url:${new URL(env("R1_BRAIN_URL")).host}`,
  account: null,
  stores: {
    voiceProfiles: storeOf(
      profiles.map(profileToWire).map((p) => `${p.id}|${p.samples}|${p.centroid}`),
      profiles.length === 0
        ? "none"
        : profiles.map((p) => `${p.id}: ${p.samples} samples`).join(", "),
    ),
  },
  sentAt: Date.now(),
});

/** Her hub's own server's turn route, from the hub's bus URL. */
const localBrainOf = (hub: string) =>
  new URL("/api/devices/r1/v1/chat/completions", hub.replace(/^ws/, "http")).toString();

/** Tessaya's turn on her server, OpenAI chat-completions shape, streamed. */
const brain = (url: string, key: string): RoomDeps["brain"] =>
  async function* (input, signal) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        messages: input.messages,
        stream: true,
        // This loop strips a `[tone:x]` mark and speaks the tone: an older one would read it aloud.
        tessaya: { ...input.tessaya, tones: true },
        device: input.deviceId,
      }),
      signal,
    }).catch((e: unknown) => {
      if (signal.aborted) throw e;
      healthReport.brainFailed();
      throw brainNotReached(String(e));
    });
    if (!res.ok || res.body === null) {
      healthReport.brainFailed();
      throw brainNotReached(`Tessaya answered ${res.status}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> })
          .choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  };

/**
 * Her server's voice arbiter on the R1's device key. A claim waits for the 250 ms round, at most 1.5 s; any failure (an
 * older server, the network) is null, and the R1 answers as before.
 */
const arbiter = (url: string, key: string): NonNullable<RoomDeps["arbiter"]> => {
  const at = url.replace(/\/chat\/completions$/, "/voice/arbiter");
  const call = (body: Record<string, unknown>, ms: number) =>
    fetch(at, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    }).then(async (res) =>
      res.ok ? ((await res.json()) as { ok?: boolean; value?: unknown }) : null,
    );
  return {
    claim: (claim) =>
      call({ op: "claim", ...claim }, 1_500)
        .then((r) => {
          const v =
            r?.ok === true
              ? (r.value as {
                  answer?: unknown;
                  winner?: unknown;
                  until?: unknown;
                  conversation?: unknown;
                })
              : null;
          if (v === null || typeof v?.answer !== "boolean") return null;
          return {
            answer: v.answer,
            ...(typeof v.winner === "string" ? { winner: v.winner } : {}),
            ...(typeof v.until === "number" ? { until: v.until } : {}),
            ...(typeof v.conversation === "string" ? { conversation: v.conversation } : {}),
          };
        })
        .catch(() => null),
    report: (op, deviceId, untilMs) =>
      void call(
        { op, deviceId, ...(untilMs === undefined ? {} : { untilMs: Math.round(untilMs) }) },
        3_000,
      ).catch(() => undefined),
  };
};

/** A guess's word to the server: `confirm` (his final words matched) or `played` (he heard it). Best effort. */
const turnSignal =
  (url: string, key: string, what: "confirm" | "played") =>
  (callId: string): void =>
    void fetch(url.replace(/\/chat\/completions$/, `/turns/${what}`), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ callId }),
    }).catch((error: unknown) => log(`${what} ${callId} not sent: ${String(error)}`));

/**
 * A recogniser of the loop's own (a release install): `R1_RECOGNIZER_BIN` with its model, kept running beside the loop
 * like Pocket and used as the only recogniser.
 */
const startRecogniser = async () => {
  const bin = process.env["R1_RECOGNIZER_BIN"];
  // His own recognisers, when named, win over the bundled one.
  if (bin === undefined || bin === "" || (process.env["R1_RECOGNIZERS"] ?? "") !== "") return;
  const port = env("R1_RECOGNIZER_PORT", "58233");
  const tokenFile = NodePath.join(state, "recognizer-token");
  NodeFS.writeFileSync(tokenFile, crypto.randomUUID(), { mode: 0o600 });
  const proc = NodeChildProcess.spawn(bin, [], {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      RECOGNIZER_ADDR: `127.0.0.1:${port}`,
      RECOGNIZER_MODEL: env("R1_RECOGNIZER_MODEL", model("parakeet-tdt-0.6b-v3-Q8_0.gguf")),
      RECOGNIZER_TOKEN_FILE: tokenFile,
      RECOGNIZER_THREADS: env("R1_RECOGNIZER_THREADS", "4"),
    },
  });
  proc.on("exit", (code) => fail(`recogniser exited (${code}); the loop restarts with it`));
  process.env["R1_RECOGNIZERS"] = `ws://127.0.0.1:${port}=${tokenFile}`;
  const since = Date.now();
  const token = NodeFS.readFileSync(tokenFile, "utf8");
  while ((await health(`ws://127.0.0.1:${port}`, token)) === null) {
    if (Date.now() - since > 120_000) throw new Error("the recogniser did not start in 120 s");
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`recogniser up in ${Date.now() - since} ms`);
};

const main = async () => {
  adoptTesselNames(process.env);
  const threads = Number(env("R1_ONNX_THREADS", "2"));
  log("starting: loading models");
  await startRecogniser();
  const silero = model("silero_vad.onnx");
  const smart = await createSmartTurn(model("smart-turn-v3.2-cpu.onnx"), threads);
  const sense = NodeFS.existsSync(model("sensevoice.int8.onnx"))
    ? await createSenseVoice({
        modelPath: model("sensevoice.int8.onnx"),
        tokensPath: model("sensevoice.tokens.txt"),
        threads,
      })
    : null;
  const embedder = await createSpeakerEmbedder(model("campplus.onnx"), SPEAKER_MODEL_ID, 1);
  // TESSEL_REPLAY_EXPECTED=1 on a host that should have the model: without it the loop reports itself degraded.
  const replay = await loadReplayCheck(
    model("replay.onnx"),
    process.env["R1_REPLAY_EXPECTED"] === "1",
  );
  const replayCheck = replay.check;
  log(replayStatusLine(replay.status));
  const store = createSpeakerStore(state);
  /** Profiles learnt on his headset's mic (another channel and codec than hers), apart from the mic's. */
  const headsetStore = createSpeakerStore(state, "headset");
  const testMode = process.env["R1_TEST_MODE"] === "1";
  /** When he last asked her to forget what she learnt of his voice (voiceIdGate.forgetLearningAt). */
  const forgotFile = NodePath.join(state, "voice", "forgot.json");
  // Read once: only this loop writes it, and publishLearning asks on every Tessel "online".
  let forgot = (() => {
    try {
      return Number(JSON.parse(NodeFS.readFileSync(forgotFile, "utf8")).at) || 0;
    } catch {
      return 0;
    }
  })();
  const forgotAt = () => forgot;
  // Enrol once, recognised everywhere: the shared bases from her server, and this R1's own refinement of them.
  /** What this loop has learnt of his voice, on each Tessel it serves (retained): Settings shows it with Forget. */
  const publishLearning = () => {
    const owner = store.list().find((p) => p.kind === "owner");
    const mine = sharedProfiles.learning().find((l) => l.id === owner?.id);
    const body = JSON.stringify({
      roomSamples: mine?.roomSamples ?? 0,
      farClips: mine?.farClips ?? 0,
      farAt: mine?.farAt ?? null,
      forgotAt: forgotAt() || null,
    });
    for (const id of online) mqtt.publish(`freya/r1/${id}/state/voice/learning`, body, true);
  };
  const sharedProfiles = createProfileSync({
    store,
    file: NodePath.join(state, "voice", "shared.json"),
    model: SPEAKER_MODEL_ID,
    log,
  });
  sharedProfiles.setRefining(process.env["R1_VOICE_REFINE"] !== "0");
  const policy = { ...CAMPLUS_POLICY, model: SPEAKER_MODEL_ID };
  const roomPolicy = { ...ROOM_POLICY, model: SPEAKER_MODEL_ID };
  log("starting: models loaded");
  const deviceKey = secret("R1_DEVICE_KEY_FILE");
  let roster = (await servedPersonas(env("R1_BRAIN_URL"), deviceKey)) ?? ROOM_CONFIG.personas;
  log(`personas: ${roster.map((p) => `${p.name} (${p.voice})`).join(", ")}`);
  const { speak, warm } = await startPocket(roster.map((p) => p.voice));
  /** A voice profile made here, to her server's door on the device key; the home keeps the copy with more samples. */
  const uploadProfile = (p: SpeakerProfile, fresh: boolean) =>
    void fetch(env("R1_BRAIN_URL").replace(/\/chat\/completions$/, "/voice/profile"), {
      method: "POST",
      headers: { authorization: `Bearer ${deviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        profile: {
          name: p.name,
          kind: p.kind,
          model: p.model,
          centroid: vectorToBase64(p.centroid),
          samples: p.samples,
          enrolledAt: p.enrolledAt,
          sources: p.sources,
          fresh,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) =>
        log(`voice profile ${p.id} sent to her server (${fresh ? "new" : "held"}): ${res.status}`),
      )
      .catch((e: unknown) => log(`voice profile ${p.id} not sent to her server: ${String(e)}`));
  // An enrolment made here before the home could take it (an older server) reaches it now.
  for (const p of sharedProfiles.localOnly()) uploadProfile(p, false);
  const metricsFile = NodePath.join(state, "metrics.ndjson");
  const metricsIo = createWriteQueue((e) => log(`metrics not written (${String(e)})`));

  // Off unless the host names a private folder (R1_WAKE_CAPTURE_DIR), capped at R1_WAKE_CAPTURE_MB (default 1024).
  const captureDir = process.env["R1_WAKE_CAPTURE_DIR"] ?? "";
  const playback = createPlaybackWindows(Date.now);
  const capture =
    captureDir === ""
      ? undefined
      : createWakeCapture({
          dir: captureDir,
          capBytes: Number(process.env["R1_WAKE_CAPTURE_MB"] ?? "1024") * 1_048_576,
          playback: playback.run,
          log,
        });
  // His own turns, beside the wake capture (R1_TURN_CAPTURE_DIR, else "turncap" next to the wake folder), capped at
  // R1_TURN_CAPTURE_MB (default 1024) and R1_TURN_CAPTURE_DAYS (default 30). Off where no wake folder is named either.
  const turnDir =
    process.env["R1_TURN_CAPTURE_DIR"] ??
    (captureDir === "" ? "" : NodePath.join(NodePath.dirname(captureDir), "turncap"));
  const turnCapture =
    turnDir === ""
      ? undefined
      : createTurnCapture({
          dir: turnDir,
          capBytes: Number(process.env["R1_TURN_CAPTURE_MB"] ?? "1024") * 1_048_576,
          maxAgeMs: Number(process.env["R1_TURN_CAPTURE_DAYS"] ?? "30") * 86_400_000,
          log,
        });
  // Off unless named: the raw aligned uplink and her downlink, for replaying the echo path (R1_SESSION_TAP_DIR,
  // R1_SESSION_TAP_MB default 2048, R1_SESSION_TAP_DAYS default 7).
  const tapDir = process.env["R1_SESSION_TAP_DIR"] ?? "";
  const sessionTap =
    tapDir === ""
      ? undefined
      : createSessionTap({
          dir: tapDir,
          capBytes: Number(process.env["R1_SESSION_TAP_MB"] ?? "2048") * 1_048_576,
          maxAgeMs: Number(process.env["R1_SESSION_TAP_DAYS"] ?? "7") * 86_400_000,
          log,
        });
  // How late this loop's timers run, to split the R1 running dry between this loop and Wi-Fi.
  const lag = NodePerfHooks.monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  // The garbage collector's longest pause in the same minute: a stall it does not explain is this loop's own work.
  let gcMax = 0;
  new NodePerfHooks.PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcMax = Math.max(gcMax, e.duration);
  }).observe({ entryTypes: ["gc"] });
  setInterval(() => {
    if (lag.max / 1e6 >= 50)
      log(
        `loop lag p99 ${Math.round(lag.percentile(99) / 1e6)} ms, max ${Math.round(lag.max / 1e6)} ms, longest gc ${Math.round(gcMax)} ms, heap ${Math.round(process.memoryUsage().heapUsed / 1_048_576)} MB (1 min)`,
      );
    lag.reset();
    gcMax = 0;
  }, 60_000).unref();
  // Always on, no audio: every segment and kws verdict, capped at R1_WAKE_TRACE_MB (default 50) in two files.
  const trace = createWakeTrace({
    file: NodePath.join(state, "wake-trace.ndjson"),
    capBytes: Number(process.env["R1_WAKE_TRACE_MB"] ?? "50") * 1_048_576,
    log,
  });
  const wakeLog = bothCaptures(
    bothCaptures(trace, capture),
    createMicWatch({
      restart: (id) => mqtt.publish(`freya/r1/${id}/cmd/voice/wake/restart`, "{}"),
      log,
    }),
  );
  // `R1_KWS_WAKE=Tessaya=0.9,...` ("" for none). W2 real cascade (15 Nov): the kws at 0.9 beats openWakeWord on
  // every row, 32 of his 41 held-out names against 16 at 0.63 against 0.84 false wakes/h; OR-ing both doubles them.
  const kwsWords = (text: string, also: boolean) =>
    text
      .split(",")
      .filter((pair) => pair.includes("="))
      .map((pair) => {
        const [word, threshold] = pair.split("=") as [string, string];
        return { word: word.trim(), threshold: Number(threshold), also };
      })
      .filter((w) => w.word !== "" && w.threshold > 0 && w.threshold <= 1);
  // `R1_KWS_ALSO` ("" for none): a kws pass also wakes these, beside openWakeWord. 18 Nov in the draft case, stage 2
  // caught 1 of his 2 Alfreds and 4 of 6 Freyas, a kws pass at 0.85 or stage 2 all 8.
  const kwsWake = [
    ...kwsWords(process.env["R1_KWS_WAKE"] ?? "Tessaya=0.9", false),
    ...kwsWords(process.env["R1_KWS_ALSO"] ?? "Alfred=0.85,Freya=0.85", true),
  ];
  // `R1_WAKE_GATE=min=64,x=2.5`: the Tessel's segment gate, sent with the kws settings; unset keeps the firmware's.
  const wakeGate = parseWakeGate(process.env["R1_WAKE_GATE"]);
  if (process.env["R1_WAKE_GATE"] && wakeGate === null)
    log(`R1_WAKE_GATE ignored: want min=32-450,x=1.5-6`);
  /** One clock for the wake stream and the room: a request's times in one are compared in the other. */
  const now = () => performance.timeOrigin + performance.now();
  /** The Tessels whose kws scorer says it is ready: its pass decides their wakes. */
  const kwsReady = new Set<string>();
  /** The R1s whose last word on `state/online` was "1": only then are the recognisers kept warm. */
  const online = new Set<string>();
  let room: ReturnType<typeof createRoomVoice> | null = null;
  // A Tessel silent on the hub but still answering ARP on this LAN gets the firmware's remote reset (netReset.ts).
  const resetKeys = ((): Record<string, string> => {
    try {
      return JSON.parse(secret("R1_RESET_KEYS_FILE")) as Record<string, string>;
    } catch {
      return {}; // an older server wrote none: the device key, which a claimed Tessel logs in with
    }
  })();
  const resetSocket = NodeDgram.createSocket("udp4");
  resetSocket.on("error", (e) => log(`remote reset socket: ${e.message}`));
  const linkWatch = createLinkWatch({
    now: Date.now,
    arp: () =>
      parseArp(
        NodeFS.existsSync("/proc/net/arp") ? NodeFS.readFileSync("/proc/net/arp", "utf8") : "",
      ),
    send: (ip, frame) => resetSocket.send(frame, 9, ip),
    report: (id, body) => mqtt.publish(`freya/r1/${id}/event/link/dead`, JSON.stringify(body)),
    log,
    keyFor: (id) => resetKeys[id] ?? deviceKey,
  });
  // Only while this loop's own bus has been up as long as a Tessel may stay silent: with the hub down she is on another
  // hub (the failover), not wedged, and is heard here again soon after it returns.
  let busUpAt: number | null = null;
  setInterval(() => {
    busUpAt = mqtt.connected() ? (busUpAt ?? Date.now()) : null;
    if (busUpAt !== null && Date.now() - busUpAt >= 150_000) linkWatch.tick();
  }, 30_000).unref();
  const buses = loopBuses(env("R1_BRAIN_URL"), process.env["R1_HUB_URL"]);
  const bus = buses.hub;
  log(`bus: ${bus}${buses.brain === null ? "" : `; brain's hub: ${buses.brain}`}`);
  const mqtt = connectMqtt({
    url: bus,
    clientId: `tessaya-room-${process.pid}`,
    // A short heartbeat: the hub drops a silent loop after 9 s, so a standby on the hub's server takes the room.
    keepAliveS: 6,
    user: env("R1_MQTT_USER"),
    pass: secret("R1_MQTT_PASS_FILE"),
    subscribe: [
      "freya/r1/+/voice/up",
      "freya/r1/+/cmd/voice/start",
      "freya/r1/+/cmd/voice/stop",
      "freya/r1/+/voice/enrol",
      "freya/r1/+/voice/say",
      "freya/r1/+/voice/ctl",
      "freya/r1/+/state/online",
      "freya/r1/+/event/session/start",
      "freya/r1/+/event/wake",
      "freya/r1/+/voice/wake",
      "freya/r1/+/voice/wake/end",
      "freya/r1/+/event/wake/kws",
      "freya/r1/+/event/wake/boot",
      "freya/r1/+/event/wake/stats",
      "freya/r1/+/state/voice/kws",
      "freya/r1/+/state/mic",
      "freya/r1/+/state/voice",
      "freya/r1/+/state/audio/output",
      "freya/r1/+/state/volume",
      "freya/r1/+/event/bt/stall",
      "freya/r1/+/event/key",
      "freya/r1/+/cmd/voice/earcons",
      "freya/r1/+/cmd/voice/talkover",
      "freya/r1/+/voice/persona",
      "freya/r1/+/voice/ask",
      ...(testMode ? ["freya/r1/+/voice/testmode"] : []),
      "freya/r1/+/event/session/end",
      "freya/r1/+/cmd/eye/#",
      "freya/r1/+/state/eye/#",
      "freya/r1/+/voice/pronounce",
      "freya/r1/+/voice/gate",
      "freya/r1/+/voice/breath",
      "freya/r1/+/voice/capture",
      "freya/r1/+/voice/forget",
      "freya/r1/+/voice/stepup",
      "freya/r1/+/voice/prefs/+",
      "freya/r1/+/voice/current/+",
      "freya/r1/+/voice/cast",
      "freya/r1/+/voice/languages",
      "freya/r1/+/voice/profile",
      "freya/r1/+/voice/profile/+",
      "freya/r1/+/voice/refine",
      "freya/r1/+/voice/intent/eye",
      "freya/r1/+/voice/intent/rest",
      "freya/r1/+/state/caps",
      "freya/r1/+/cmd/voice/no-reply",
      "freya/r1/+/voice/up/tainted",
      "freya/r1/+/event/voice/interrupt",
      "freya/r1/+/event/voice/flush",
      "freya/r1/+/event/test/playback",
      "freya/r1/+/cmd/voice/wakeinject",
    ],
    onMessage: (t, p) => {
      const fromDevice = /^freya\/r1\/([^/]+)\/(event\/|state\/|voice\/up$|voice\/wake)/.exec(t);
      // the hub's will for her (online 0) is not her talking
      if (fromDevice !== null && !(t.endsWith("/state/online") && String(p).trim() !== "1"))
        linkWatch.heard(fromDevice[1]!);
      if (PLAYBACK_TOPIC.test(t)) {
        const line = playback.message(t, String(p));
        if (line !== null) log(line);
        return;
      }
      const wakePath = /^freya\/r1\/([^/]+)\/(voice\/wake\/end|event\/wake\/stats)$/.exec(t);
      if (wakePath !== null) trace.report(wakePath[1]!, wakePath[2]!, String(p));
      const kwsPass = /^freya\/r1\/([^/]+)\/event\/wake\/kws$/.exec(t);
      if (kwsPass !== null && /"pass"\s*:\s*true/.test(String(p)))
        healthReport.attempt(kwsPass[1]!);
      const seen = /^freya\/r1\/([^/]+)\/state\/online$/.exec(t);
      if (seen !== null) {
        if (String(p).trim() === "1") {
          online.add(seen[1]!);
          publishLearning();
        } else online.delete(seen[1]!);
      }
      // Her early kws threshold and wake gate, which the Tessel loses on every boot: sent whenever it reports others.
      const kws = /^(freya\/r1\/[^/]+)\/state\/voice\/kws$/.exec(t);
      if (kws !== null) {
        const state = (() => {
          try {
            return JSON.parse(String(p)) as {
              early?: unknown;
              scorer?: unknown;
              gate_min?: unknown;
              gate_x10?: unknown;
            };
          } catch {
            return {};
          }
        })();
        const id = kws[1]!.slice("freya/r1/".length);
        if (state.scorer === "ready") kwsReady.add(id);
        else kwsReady.delete(id);
        const send = kwsSettingsCommand(state, kwsWake, wakeGate);
        if (send !== null) mqtt.publish(`${kws[1]}/cmd/voice/kws`, send);
        return;
      }
      const started = /^freya\/r1\/([^/]+)\/event\/session\/start$/.exec(t);
      if (started !== null) wakeLog.session(started[1]!);
      // voice/profile[/<member>]: a shared profile (retained); empty on a member's topic clears that member.
      const m = /^freya\/r1\/[^/]+\/voice\/profile(?:\/([^/]+))?$/.exec(t);
      if (m !== null) {
        const text = String(p).trim();
        if (text === "") {
          if (m[1] !== undefined) sharedProfiles.clear(m[1]);
        } else {
          const shared = parseShared(text);
          if (shared === null) log("voice profile: not a profile; ignored");
          else sharedProfiles.shared(shared);
        }
        return;
      }
      if (testMode && /^freya\/r1\/[^/]+\/voice\/testmode$/.test(t)) {
        const dir = (() => {
          try {
            return (JSON.parse(String(p)) as { enrol?: unknown }).enrol;
          } catch {
            return undefined;
          }
        })();
        if (typeof dir === "string") {
          void enrolTest(dir).then(log, (e: unknown) =>
            log(`test speaker not enrolled: ${String(e)}`),
          );
          return;
        }
      }
      const gateAsk = /^freya\/r1\/[^/]+\/voice\/gate$/.test(t)
        ? (() => {
            try {
              return (
                Number(
                  (JSON.parse(String(p)) as { forgetLearningAt?: unknown }).forgetLearningAt,
                ) || 0
              );
            } catch {
              return 0;
            }
          })()
        : 0;
      // "Forget recent voice learning" (Settings, or by voice through voiceIdGate): once per ask, on every Tessel here.
      if (gateAsk > forgotAt()) {
        NodeFS.mkdirSync(NodePath.dirname(forgotFile), { recursive: true });
        NodeFS.writeFileSync(forgotFile, JSON.stringify({ at: gateAsk }), { mode: 0o600 });
        forgot = gateAsk;
        sharedProfiles.reset();
        log("voice learning forgotten: back to his enrolled profile, his far voice cleared");
        publishLearning();
      }
      if (/^freya\/r1\/[^/]+\/voice\/refine$/.test(t)) {
        const ask = (() => {
          try {
            return JSON.parse(String(p)) as { on?: unknown; reset?: unknown };
          } catch {
            return {};
          }
        })();
        if (ask.reset === true) {
          sharedProfiles.reset();
          log("voice profile refinement on this R1: reset to the shared profiles");
          return;
        }
        const on = ask.on !== false;
        sharedProfiles.setRefining(on);
        log(`voice profile refinement on this R1: ${on ? "on" : "off"}`);
        return;
      }
      const to = /^freya\/r1\/([^/]+)\/(.+)$/.exec(t);
      if (to !== null && routeForDevice(to[2]!, online.has(to[1]!)) === "drop") return;
      room?.message(t, p);
    },
    log,
  });
  // Her reports copied to the brain's hub, and the brain's turn acts taken from it, when the brain is on another host.
  const bridge =
    buses.brain === null
      ? null
      : connectBrainBridge({
          hub: bus,
          hubLogin: { user: env("R1_MQTT_USER"), pass: secret("R1_MQTT_PASS_FILE") },
          brain: buses.brain,
          brainLogin: {
            user: env("R1_BRAIN_MQTT_USER", "tessaya-bus"),
            pass: secret("R1_BRAIN_MQTT_PASS_FILE"),
          },
          clientSuffix: String(process.pid),
          here: (id) => online.has(id),
          deliver: (t, p) => room?.message(t, p),
          log,
        });
  const inhouse = new Set(
    (process.env["R1_INHOUSE"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // The words a fresh desktop wakes to, from the one table; a word whose model is not in R1_MODELS is skipped, and said.
  const shipped = WAKE_WORDS.filter((w) => w.onByDefault)
    .map((w) => ({
      word: w.word,
      persona: w.persona,
      file: model(wakeModelFile(w.word)),
      threshold: w.threshold,
    }))
    .filter((w) => {
      const there = NodeFS.existsSync(w.file);
      if (!there) log(`wake: no ${NodePath.basename(w.file)} in R1_MODELS`);
      return there;
    });
  const wakeWords = async (): Promise<RoomWake[]> => [
    ...shipped,
    ...(await trainedWakes(
      env("R1_BRAIN_URL"),
      deviceKey,
      roster,
      new Set(shipped.map((w) => w.word.toLowerCase())),
    ).catch(() => [])),
  ];
  let words = await wakeWords();
  const scorerFor = (list: typeof words) => () =>
    createOpenWakeWordScorer({
      melspectrogram: model("melspectrogram.onnx"),
      embedding: model("embedding_model.onnx"),
      wakes: list.map((w) => ({ word: w.word, path: w.file, threshold: w.threshold })),
    });
  const heard = recognisers(
    () => online.size > 0,
    () =>
      recogniserTerms([
        ...vocabulary.entries,
        ...roster.map((p) => ({ phrase: p.name, replacement: null })),
      ]),
  );
  const personalConfirm = (process.env["R1_PERSONAL_RECOGNIZERS"] ?? "").trim() !== "";
  // The room's words get dictation's own correction: his dictionary and the personas he can call (one ear).
  let vocabulary: {
    readonly entries: ReadonlyArray<VocabularyEntry>;
    readonly ordinary: ReadonlySet<string>;
  } = { entries: [], ordinary: new Set() };
  const readVocabulary = async () => {
    vocabulary = (await servedVocabulary(env("R1_BRAIN_URL"), deviceKey)) ?? vocabulary;
  };
  void readVocabulary();
  setInterval(() => void readVocabulary(), VOCABULARY_EVERY_MS).unref();
  const fix = (text: string) =>
    biasTranscript(text, vocabulary.entries, {
      names: roster.map((p) => p.name),
      ordinary: vocabulary.ordinary,
    });
  const recognise = (who?: {
    readonly owner: boolean;
    readonly only?: boolean;
  }): RecogniserTurn => {
    const turn = heard(who?.owner, who?.only);
    return {
      ...turn,
      finish: async () => fix(await turn.finish()),
      onPartial: (listener) => turn.onPartial?.((text) => listener(fix(text))),
    };
  };
  // Test mode, on an internal host only (R1_TEST_MODE=1): the test clone's profile, kept here and never synced.
  const testFile = NodePath.join(state, "voice", "test-speaker.json");
  const readTest = (): SpeakerProfile | null => {
    try {
      const w = JSON.parse(NodeFS.readFileSync(testFile, "utf8")) as {
        centroid: string;
        samples: number;
        at: string;
      };
      const bytes = Buffer.from(w.centroid, "base64");
      return {
        id: TEST_SPEAKER_ID,
        name: "Test speaker",
        kind: "saved",
        model: SPEAKER_MODEL_ID,
        centroid: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
        samples: w.samples,
        sources: ["spoken"],
        enrolledAt: w.at,
      };
    } catch {
      return null;
    }
  };
  let testSpeaker = testMode ? readTest() : null;
  /** The clone's 16 kHz mono WAVs in `dir`, enrolled as the test speaker; what came of it, for the log. */
  const enrolTest = async (dir: string) => {
    const files = NodeFS.readdirSync(dir).filter((f) => f.endsWith(".wav"));
    const vectors = (
      await Promise.all(
        files.map((f) => embedder.embed(decodeWav(NodeFS.readFileSync(NodePath.join(dir, f))))),
      )
    ).filter((v) => v !== null);
    const made = enrol(vectors);
    if (made === null)
      return `test speaker not enrolled (${vectors.length} of ${files.length} clips embedded)`;
    NodeFS.mkdirSync(NodePath.dirname(testFile), { recursive: true });
    NodeFS.writeFileSync(
      testFile,
      JSON.stringify({
        centroid: vectorToBase64(made.centroid),
        samples: made.kept,
        at: new Date().toISOString(),
      }),
    );
    testSpeaker = readTest();
    return `test speaker enrolled from ${made.kept} clips (${made.dropped} dropped)`;
  };
  /** Her mic's profiles, each with this R1's room centroid and far voice for that person when it has learnt them. */
  const withRoom = () =>
    store.list().map((p) => {
      const room = sharedProfiles.room(p.id);
      const far = sharedProfiles.far(p.id);
      return {
        ...p,
        ...(room === undefined || room.length !== p.centroid.length ? {} : { room }),
        ...(far === undefined || far.length !== p.centroid.length ? {} : { far }),
      };
    });
  // His far voice, from his own verified turns since he last asked her to forget what she learnt (voiceIdGate).
  let farBuiltAt = 0;
  const rebuildFar = async () => {
    const owner = store.list().find((p) => p.kind === "owner");
    if (turnCapture === undefined || owner === undefined || Date.now() - farBuiltAt < 10 * 60_000)
      return;
    farBuiltAt = Date.now();
    const clips = turnCapture.ownerClips(forgotAt());
    const centroid = await farCentroid(clips, (pcm) => embedder.embed(pcm)).catch(() => null);
    if (centroid !== null) sharedProfiles.setFar(owner.id, centroid, clips.length, Date.now());
    publishLearning();
  };
  void rebuildFar();
  const speakerOf = async (pcm: Int16Array, input: VoiceInput = "mic") => {
    const at = Date.now();
    const live =
      input === "mic" ? (replayCheck?.logit(pcm).catch(() => null) ?? Promise.resolve(null)) : null;
    const vector = await embedder.embed(pcm);
    if (vector === null) return UNVERIFIED(at);
    const clips = [{ vector, ms: (pcm.length / 16_000) * 1000 }];
    const until = room?.testUntil() ?? 0;
    const mine = input === "mic" ? withRoom() : profilesFor(headsetStore.list(), store.list());
    const profiles = testSpeaker !== null && Date.now() < until ? [...mine, testSpeaker] : mine;
    const decide = (use: "steer" | "act") =>
      decideSpeaker({
        clips,
        model: SPEAKER_MODEL_ID,
        profiles,
        policy: input === "mic" ? roomPolicy : policy,
        use,
      });
    const judged = identityOf(decide("steer"), decide("act"), at);
    if (judged.personId === TEST_SPEAKER_ID) return trustTestSpeaker(judged, Date.now(), until);
    const own = ownerScoreOf(vector, profiles, SPEAKER_MODEL_ID);
    const owned =
      own === null
        ? judged
        : {
            ...judged,
            own: { score: own, ms: clips[0]!.ms, ...(input === "mic" ? { vector } : {}) },
          };
    const scored = live === null ? owned : replayChecked(owned, await live, REPLAY_CUT);
    // A guest's voice goes to her server's people graph, so she knows them next time: numbers, never audio.
    const identity =
      scored.kind === "guest" && clips[0]!.ms >= PRINT_MIN_MS
        ? {
            ...scored,
            print: { model: SPEAKER_MODEL_ID, vector: vectorToBase64(vector), ms: clips[0]!.ms },
          }
        : scored;
    // Only a turn it was sure of refines this R1's copy: verified, long enough to stand alone, well above the cut-off.
    if (
      input === "mic" &&
      identity.verified &&
      identity.personId !== null &&
      (pcm.length / 16_000) * 1000 >= ACT_SINGLE_MS &&
      (identity.confidence ?? 0) >= CAMPLUS_POLICY.single.act + 0.1
    )
      sharedProfiles.refine(identity.personId, vector);
    return identity;
  };
  // Voices she hears without her name tell her server who is near (M-123): who only, on this machine's Voice ID.
  const ambient = createAmbientPresence({
    voices: (pcm) =>
      voicesOf({ pcm, embed: embedder.embed, profiles: store.list(), policy, at: Date.now() }),
    speaker: (pcm) => speakerOf(pcm),
    herVoiceAt: (id) => room?.herVoiceAt(id) ?? null,
    send: async (deviceId, voices) => {
      const res = await fetch(
        env("R1_BRAIN_URL").replace(/\/chat\/completions$/, "/presence/heard"),
        {
          method: "POST",
          headers: { authorization: `Bearer ${deviceKey}`, "content-type": "application/json" },
          body: JSON.stringify({ device: deviceId, voices }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      return !res.ok || ((await res.json()) as { on?: unknown }).on !== false;
    },
    now: () => Date.now(),
    log,
  });
  /** Clips per person kept for a headset profile, from turns of sessions verified on her mic; memory only. */
  const learning = new Map<string, Array<Float32Array>>();
  const learnInput = async (input: VoiceInput, personId: string, pcm: Int16Array) => {
    if (input === "mic" || (pcm.length / 16_000) * 1000 < ACT_SINGLE_MS) return;
    const base = store
      .list()
      .find((p) => (personId === "owner" ? p.kind === "owner" : p.id === personId));
    if (base === undefined || base.model !== SPEAKER_MODEL_ID) return;
    const vector = await embedder.embed(pcm);
    if (vector === null) return;
    const clips = [...(learning.get(base.id) ?? []), vector].slice(-INPUT_ENROL_KEEP);
    learning.set(base.id, clips);
    const made = enrol(clips, INPUT_ENROL_MIN);
    if (made === null) return;
    headsetStore.save({
      id: base.id,
      name: base.name,
      kind: base.kind,
      model: base.model,
      centroid: made.centroid,
      samples: made.kept,
      sources: ["adapted"],
      enrolledAt: new Date().toISOString(),
    });
    log(`voice profile ${base.id} on the headset: ${made.kept} clips`);
  };
  const wake =
    words.length === 0 || !NodeFS.existsSync(model("melspectrogram.onnx"))
      ? undefined
      : createWakeStream({
          words,
          scorer: scorerFor(words),
          // His personal model beside the general one: the general one leaves some of his names empty. W2 cascade (15 Nov):
          // 31 of his 41 names against 27 behind the kws, the same false wakes on his speech and LibriSpeech (ML-001).
          confirm: (pcm, each) =>
            Promise.all(
              (personalConfirm ? [false, true] : [false]).map((owner) => {
                const turn = recognise({ owner, only: true });
                turn.feed(pcm);
                return turn.finish().then((text) => (each?.(text), text));
              }),
            ),
          onWake: (id, word, level, score, clip, request, voice, late) => {
            healthReport.accept(id);
            room?.woken(
              id,
              words.find((w) => w.word === word)?.persona ?? word,
              level,
              score,
              clip,
              request,
              voice,
              late,
            );
          },
          voice: (pcm) => speakerOf(pcm),
          ambient: (id, pcm) => void ambient.segment(id, pcm).catch(() => undefined),
          log,
          kwsWake,
          kwsReady: (id) => kwsReady.has(id),
          now,
          capture: wakeLog,
        });
  startCameraRelay();
  room = createRoomVoice(
    {
      ...(wake === undefined ? {} : { wake }),
      ...(turnCapture === undefined
        ? {}
        : {
            keepTurn: (id, pcm, meta) => {
              turnCapture.turn(id, pcm, meta);
              if (meta.speaker === "owner" && meta.verified !== false && !meta.overHer)
                void rebuildFar();
            },
          }),
      publish: (t, p) => {
        mqtt.publish(t, p);
        bridge?.answer(t, p);
        if (t.endsWith("/event/voice/metrics"))
          metricsIo.run(() => NodeFS.promises.appendFile(metricsFile, `${String(p)}\n`));
      },
      vad: () => {
        const scorer = createSileroScorer(silero);
        return { score: async (w) => (await scorer).score(w) };
      },
      smartTurn: (pcm) => smart.complete(pcm),
      recognise,
      warm: () => {
        const turn = recognise();
        turn.feed(WARM_CLIP);
        void turn.finish().catch(() => undefined);
      },
      speaker: speakerOf,
      learnInput: (input, personId, pcm) =>
        void learnInput(input, personId, pcm).catch((e: unknown) =>
          log(`headset voice profile not learnt: ${String(e)}`),
        ),
      learnRoom: (personId, vector, sample) => {
        const p = store
          .list()
          .find((p) => (personId === "owner" ? p.kind === "owner" : p.id === personId));
        if (p !== undefined && p.model === SPEAKER_MODEL_ID)
          sharedProfiles.learn(p.id, vector, sample);
      },
      ...(testMode ? { testMode: { ready: () => testSpeaker !== null } } : {}),
      playback: playback.run,
      voices: (pcm) =>
        voicesOf({ pcm, embed: embedder.embed, profiles: store.list(), policy, at: Date.now() }),
      ...(sense === null ? {} : { affect: (pcm: Int16Array) => sense.analyse(pcm) }),
      brain:
        buses.brain === null
          ? brain(env("R1_BRAIN_URL"), deviceKey)
          : brainOrLocal(
              brain(env("R1_BRAIN_URL"), deviceKey),
              brain(localBrainOf(bus), deviceKey),
              log,
            ),
      link: link(env("R1_BRAIN_URL")),
      played: turnSignal(env("R1_BRAIN_URL"), deviceKey, "played"),
      effect: (deviceId, nonverbal, face) =>
        void fetch(env("R1_BRAIN_URL").replace(/\/chat\/completions$/, "/turns/effect"), {
          method: "POST",
          headers: { authorization: `Bearer ${deviceKey}`, "content-type": "application/json" },
          body: JSON.stringify({ deviceId, nonverbal, face }),
          signal: AbortSignal.timeout(3_000),
        }).catch((error: unknown) => log(`effect ${nonverbal} not sent: ${String(error)}`)),
      forget: (personId) => {
        sharedProfiles.clear(personId);
        headsetStore.remove(personId);
      },
      preview: (pcm) => {
        const turn = recognise();
        turn.feed(pcm);
        return turn.finish();
      },
      arbiter: arbiter(env("R1_BRAIN_URL"), deviceKey),
      confirmed: turnSignal(env("R1_BRAIN_URL"), deviceKey, "confirm"),
      lines: createLines({
        fetch: async (ask) => {
          const res = await fetch(env("R1_BRAIN_URL").replace(/\/chat\/completions$/, "/lines"), {
            method: "POST",
            headers: { authorization: `Bearer ${deviceKey}`, "content-type": "application/json" },
            body: JSON.stringify(ask),
            signal: AbortSignal.timeout(5_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as LinesGot;
        },
        random: Math.random,
        hour: () => new Date().getHours(),
        log,
      }),
      // A bench's turns for regression cases, only while it set `cmd/voice/no-reply` with `keep` (never his).
      keep: (b) => {
        const dir = NodePath.join(state, "bench");
        NodeFS.mkdirSync(dir, { recursive: true });
        const pcm = (p: Int16Array) =>
          Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString("base64");
        NodeFS.writeFileSync(
          NodePath.join(
            dir,
            `${new Date().toISOString().replace(/[:.]/g, "-")}-${b.device}-${b.turn}.json`,
          ),
          JSON.stringify({
            ...b,
            mic: pcm(b.mic),
            played: b.played.map((f) => ({ at: f.at, pcm: pcm(f.pcm) })),
          }),
        );
      },
      speak,
      ...(sessionTap === undefined ? {} : { tap: sessionTap }),
      enrolOwner: async (windows) => {
        const vectors = (await Promise.all(windows.map((w) => embedder.embed(w)))).filter(
          (v) => v !== null,
        );
        const made = enrol(vectors);
        if (made === null)
          return {
            saved: false,
            said: "I couldn't get a clear enough voice print. Let's try again another time.",
          };
        store.save({
          id: "owner",
          name: "Owner",
          kind: "owner",
          model: SPEAKER_MODEL_ID,
          centroid: made.centroid,
          samples: made.kept,
          sources: ["spoken"],
          enrolledAt: new Date().toISOString(),
          consentNote: `Enrolled through the ${DEVICE} at his request; numbers only, no audio kept.`,
        });
        // To her server, which decides the member and shares it with his other devices (never the refinement).
        const saved = store.list().find((p) => p.id === "owner");
        if (saved !== undefined) uploadProfile(saved, true);
        // His speech itself, for training her wake words: her server keeps it only while his switch is on.
        void fetch(new URL("/api/tessaya/wake/enrolment", env("R1_BRAIN_URL")), {
          method: "POST",
          headers: { authorization: `Bearer ${deviceKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            clips: windows
              .slice(0, 20)
              .map((w) => Buffer.from(w.buffer, w.byteOffset, w.byteLength).toString("base64")),
          }),
        }).catch(() => undefined);
        return { saved: true, said: "Thanks. I know your voice now." };
      },
      embed: (pcm) => embedder.embed(pcm),
      member: async (pcm) => {
        const vector = await embedder.embed(pcm);
        const mine = withRoom().filter((p) => p.model === SPEAKER_MODEL_ID);
        return vector === null
          ? Number.NEGATIVE_INFINITY
          : Math.max(Number.NEGATIVE_INFINITY, ...mine.map((p) => profileScore(vector, p)));
      },
      members: () => store.list().some((p) => p.model === SPEAKER_MODEL_ID),
      now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    },
    {
      ...ROOM_CONFIG,
      personas: roster,
      inhouse,
      host: NodeOS.hostname(),
      // The household's languages (R1_LANGUAGES=en,ur); her server can change them per R1 on voice/languages.
      languages: (process.env["R1_LANGUAGES"] ?? "en")
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
      // Her name alone: a spoken "I'm here" (voice), a sound (tone) or only her look (off).
      acknowledge: ((v) => (v === "tone" || v === "off" ? v : "voice"))(process.env["R1_ACK"]),
      // A member's session opens on the persona they last talked to anywhere (R1_PERSONA_FOLLOWS=1; off by default).
      personaFollows: process.env["R1_PERSONA_FOLLOWS"] === "1",
    },
  );
  setInterval(() => room?.sweep(), 1_000);
  // A day's new interjections are heard from the next hour on.
  log(`interjections: ${loadInterjections()} cached clips`);
  setInterval(loadInterjections, 3_600_000);
  // His pack edits reach the room within a minute: new voices are fetched first, then the next session uses them.
  setInterval(() => {
    void servedPersonas(env("R1_BRAIN_URL"), deviceKey).then(async (next) => {
      if (next === null || JSON.stringify(next) === JSON.stringify(roster)) return;
      roster = next;
      await warm(next.map((p) => p.voice));
      room?.personas(next);
      log(`personas changed: ${next.map((p) => `${p.name} (${p.voice})`).join(", ")}`);
    });
  }, 60_000);
  // Her newly trained (or rolled back) words reach the room without a restart: when the signed list changes, each R1
  // listens for the new one from its next segment. Every 10 minutes, as each check asks her server for every word.
  // shortcut: a loop that started with no wake words at all still needs a restart to begin listening.
  setInterval(() => {
    void wakeWords().then((next) => {
      const key = (l: typeof words) =>
        JSON.stringify(l.map((w) => [w.word, w.version, w.threshold]));
      if (wake === undefined || key(next) === key(words)) return;
      words = next;
      wake.reload(next, scorerFor(next));
      log(
        `wake words changed: ${next.map((w) => `${w.word}${w.version === undefined ? "" : ` v${w.version}`}`).join(", ")}`,
      );
    });
  }, 10 * 60_000);
  // Her health model's room part, each minute, retained so a restarted server has it at once; an old `at` is a
  // stopped loop. Only for Tessels online now: nothing goes out while the room is empty.
  setInterval(() => {
    if (online.size === 0) return;
    const pocket = `http://127.0.0.1:${env("R1_POCKET_PORT", "58232")}/health`;
    void fetch(pocket, { signal: AbortSignal.timeout(2_000) })
      .then(
        (r) => r.ok,
        () => false,
      )
      .then((pocketUp) => {
        const host = readHost(Date.now());
        const services = [
          { name: "room loop", host: host.host, up: true, startedAt },
          { name: "pocket-tts", host: host.host, up: pocketUp, startedAt },
          ...heard.status().map((r) => ({
            name: `recogniser ${r.url.replace(/^wss?:\/\//, "")}`,
            host: host.host,
            up: r.up,
            startedAt: null,
          })),
        ];
        const degraded = "degraded" in replay.status && replay.status.degraded;
        for (const id of online)
          mqtt.publish(
            `freya/r1/${id}/state/voicehost`,
            JSON.stringify(
              healthReport.report(id, {
                host,
                services,
                replay: { line: replayStatusLine(replay.status), degraded },
                fingerprint: loopFingerprint(host.host, store.list()),
              }),
            ),
            true,
          );
      });
  }, 60_000);
  const stop = () => {
    room?.close();
    mqtt.close();
    bridge?.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  log(`room loop ready; ${replayStatusLine(replay.status)}`);
};

void main().catch((error: unknown) => {
  fail(
    `room loop failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
});
