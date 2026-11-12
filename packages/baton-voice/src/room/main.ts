// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalConsole:off
/**
 * The R1 room loop as a program on the voice host (next to the R1 on his LAN). Everything it needs comes from
 * the environment; secrets are read from files, never from variables or arguments. See deploy/r1-voice/README.md.
 *
 * @module baton-voice/room/main
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { pocketVoiceUrl } from "@t3tools/baton-shared/voiceLibrary";

import { createOpenWakeWordScorer, createSileroScorer } from "../providers/onnx.ts";
import { createSpeakerEmbedder } from "../providers/speakerOnnx.ts";
import { CAMPLUS_POLICY, decideSpeaker, enrol, identityOf, UNVERIFIED } from "../speaker.ts";
import { createSpeakerStore } from "../speakerStore.ts";
import { createResampler24to16, createWavReader } from "./audio.ts";
import { connectMqtt } from "./mqtt.ts";
import { noteTime, pickRecogniser, type RecogniserState } from "./recognisers.ts";
import { createRoomVoice, ROOM_CONFIG, type RecogniserTurn, type RoomDeps } from "./roomVoice.ts";
import { createSenseVoice } from "./senseVoice.ts";
import { createSmartTurn } from "./smartTurn.ts";
import { createWakeStream } from "./wakeStream.ts";

const env = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${key} is not set`);
  return v;
};
const secret = (key: string) => NodeFS.readFileSync(env(key), "utf8").trim();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

/** CAM++ as the desktop ships it: a profile made with another model is never compared. */
const SPEAKER_MODEL_ID = "campplus-voxceleb-357a834f";

const models = env("R1_MODELS");
const state = env("R1_STATE");
const model = (file: string) => NodePath.join(models, file);

/** Tessaya's recogniser (native/tessaya-recognizer) over its WebSocket protocol: words stream in, the text at the end. */
const recogniserTurn = (url: string, token: string): RecogniserTurn => {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const queued: Uint8Array<ArrayBuffer>[] = [];
  let open = false;
  let ended = false;
  let settle: ((text: string) => void) | null = null;
  const result = new Promise<string>((resolve, reject) => {
    settle = resolve;
    ws.addEventListener("error", () => reject(new Error("recogniser unreachable")));
    ws.addEventListener("close", () => resolve(""));
  });
  ws.addEventListener("open", () => {
    open = true;
    ws.send(JSON.stringify({ cmd: "begin", language: "en" }));
    for (const q of queued.splice(0)) ws.send(q);
    if (ended) ws.send(JSON.stringify({ cmd: "end" }));
  });
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data) as { ev?: string; text?: string; message?: string };
    if (m.ev === "text") settle?.(m.text ?? "");
    if (m.ev === "error") settle?.("");
    if (m.ev === "text" || m.ev === "error") ws.close();
  });
  return {
    feed: (pcm) => {
      const bytes = new Uint8Array(pcm.byteLength);
      bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      if (open) ws.send(bytes);
      else queued.push(bytes);
    },
    finish: () => {
      ended = true;
      if (open) ws.send(JSON.stringify({ cmd: "end" }));
      return result;
    },
    cancel: () => ws.close(),
  };
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

/** His recognisers (`R1_RECOGNIZERS=url=tokenfile,...`), each turn to the quickest lately (recognisers.ts). */
const recognisers = () => {
  const list = (
    process.env["R1_RECOGNIZERS"] ??
    `${env("R1_RECOGNIZER_URL")}=${env("R1_RECOGNIZER_TOKEN_FILE")}`
  )
    .split(",")
    .map((pair) => {
      const [url, file] = pair.split("=") as [string, string];
      return { url: url.trim(), token: NodeFS.readFileSync(file.trim(), "utf8").trim() };
    });
  let states: RecogniserState[] = list.map((r) => ({ url: r.url, queue: 0, recent: [] }));
  const refresh = async () => {
    const queues = await Promise.all(list.map((r) => health(r.url, r.token)));
    states = states.map((s, i) => ({ ...s, queue: queues[i] ?? null }));
  };
  void refresh();
  setInterval(() => void refresh(), 2_000);
  return (): RecogniserTurn => {
    const chosen = pickRecogniser(states, Date.now()) ?? states[0]!;
    const token = list.find((r) => r.url === chosen.url)!.token;
    const turn = recogniserTurn(chosen.url, token);
    return {
      ...turn,
      finish: async () => {
        const started = performance.now();
        const text = await turn.finish();
        const ms = performance.now() - started;
        states = states.map((s) =>
          s.url === chosen.url ? { ...s, recent: noteTime(s.recent, ms, Date.now()) } : s,
        );
        log(`recogniser ${chosen.url.replace(/^ws:\/\//, "")} ${Math.round(ms)} ms`);
        return text;
      },
    };
  };
};

/** Pocket TTS's own server, kept running beside the loop (her voice, as on the desktop). */
const startPocket = async () => {
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
  proc.on("exit", (code) => {
    log(`pocket exited (${code}); the loop restarts with it`);
    process.exit(1);
  });
  for (let i = 0; ; i += 1) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (i > 300) throw new Error("pocket did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
  const tts = (text: string, signal: AbortSignal, voice?: string) =>
    fetch(`http://127.0.0.1:${port}/tts`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        text,
        ...(voice === undefined ? {} : { voice_url: pocketVoiceUrl(voice) }),
      }).toString(),
      signal,
    });
  // Pocket fetches a voice on its first use (about 8 s on the voice host), so every persona's is fetched now, not mid-reply.
  for (const p of ROOM_CONFIG.personas)
    await tts("Ready.", AbortSignal.timeout(60_000), p.voice).then(
      (r) => r.arrayBuffer(),
      (e: unknown) => log(`voice ${p.voice} not ready: ${String(e)}`),
    );
  return async function* (text: string, signal: AbortSignal, voice?: string) {
    const res = await tts(text, signal, voice);
    if (!res.ok || res.body === null) throw new Error(`voice answered ${res.status}`);
    const read = createWavReader();
    const down = createResampler24to16();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const pcm = down(read(chunk));
      if (pcm.length > 0) yield pcm;
    }
  };
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

/** Tessaya's turn on her server, OpenAI chat-completions shape, streamed. */
const brain = (url: string, key: string): RoomDeps["brain"] =>
  async function* (input, signal) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: input.messages, stream: true, tessaya: input.tessaya }),
      signal,
    });
    if (!res.ok || res.body === null) throw new Error(`Tessaya answered ${res.status}`);
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

const main = async () => {
  const threads = Number(env("R1_ONNX_THREADS", "2"));
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
  const store = createSpeakerStore(state);
  const policy = { ...CAMPLUS_POLICY, model: SPEAKER_MODEL_ID };
  const speak = await startPocket();
  const deviceKey = secret("R1_DEVICE_KEY_FILE");
  const metricsFile = NodePath.join(state, "metrics.ndjson");

  let room: ReturnType<typeof createRoomVoice> | null = null;
  const mqtt = connectMqtt({
    host: env("R1_MQTT_HOST"),
    port: Number(env("R1_MQTT_PORT", "1883")),
    clientId: `tessaya-room-${process.pid}`,
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
      "freya/r1/+/state/mic",
      "freya/r1/+/state/voice",
      "freya/r1/+/event/key",
      "freya/r1/+/cmd/voice/earcons",
      "freya/r1/+/event/session/end",
    ],
    onMessage: (t, p) => room?.message(t, p),
    log,
  });
  const inhouse = new Set(
    (process.env["R1_INHOUSE"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // His wake words as the desktop ships them (wakeDefaults.ts); a word whose model is not on this host is skipped.
  const words = [
    { word: "Tessaya", file: "tessaya.onnx", threshold: 0.99 },
    { word: "Alfred", file: "alfred.onnx", threshold: 0.95 },
    { word: "Freya", file: "freya.onnx", threshold: 0.95 },
  ].filter((w) => NodeFS.existsSync(model(w.file)));
  const confirmWith = recognisers();
  const wake =
    words.length === 0 || !NodeFS.existsSync(model("melspectrogram.onnx"))
      ? undefined
      : createWakeStream({
          words,
          scorer: () =>
            createOpenWakeWordScorer({
              melspectrogram: model("melspectrogram.onnx"),
              embedding: model("embedding_model.onnx"),
              wakes: words.map((w) => ({
                word: w.word,
                path: model(w.file),
                threshold: w.threshold,
              })),
            }),
          confirm: (pcm) => {
            const turn = confirmWith();
            turn.feed(pcm);
            return turn.finish();
          },
          onWake: (id, word) => room?.woken(id, word),
          log,
        });
  startCameraRelay();
  room = createRoomVoice(
    {
      ...(wake === undefined ? {} : { wake }),
      publish: (t, p) => {
        mqtt.publish(t, p);
        if (t.endsWith("/event/voice/metrics"))
          NodeFS.appendFileSync(metricsFile, `${String(p)}\n`);
      },
      vad: () => {
        const scorer = createSileroScorer(silero);
        return { score: async (w) => (await scorer).score(w) };
      },
      smartTurn: (pcm) => smart.complete(pcm),
      recognise: recognisers(),
      speaker: async (pcm) => {
        const at = Date.now();
        const vector = await embedder.embed(pcm);
        if (vector === null) return UNVERIFIED(at);
        const clips = [{ vector, ms: (pcm.length / 16_000) * 1000 }];
        const profiles = store.list();
        const decide = (use: "steer" | "act") =>
          decideSpeaker({ clips, model: SPEAKER_MODEL_ID, profiles, policy, use });
        return identityOf(decide("steer"), decide("act"), at);
      },
      ...(sense === null ? {} : { affect: (pcm: Int16Array) => sense.analyse(pcm) }),
      brain: brain(env("R1_BRAIN_URL"), deviceKey),
      speak,
      enrolOwner: async (windows) => {
        const vectors = (await Promise.all(windows.map((w) => embedder.embed(w)))).filter(
          (v) => v !== null,
        );
        const made = enrol(vectors);
        if (made === null)
          return "I couldn't get a clear enough voice print. Let's try again another time.";
        store.save({
          id: "owner",
          name: "Owner",
          kind: "owner",
          model: SPEAKER_MODEL_ID,
          centroid: made.centroid,
          samples: made.kept,
          sources: ["spoken"],
          enrolledAt: new Date().toISOString(),
          consentNote: "Enrolled through the R1 at his request; numbers only, no audio kept.",
        });
        return "Thanks. I know your voice now.";
      },
      now: () => performance.timeOrigin + performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    },
    { ...ROOM_CONFIG, inhouse },
  );
  setInterval(() => room?.sweep(), 1_000);
  const stop = () => {
    room?.close();
    mqtt.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  log("room loop ready");
};

void main().catch((error: unknown) => {
  log(`room loop failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
