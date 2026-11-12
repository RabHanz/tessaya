import { describe, expect, it } from "vite-plus/test";

import {
  FRAME_SAMPLES,
  createFramer,
  createUplink,
  expressionOfMood,
  pcmToBase64,
  satelliteMoment,
} from "./satellite.ts";

const quiet = () => new Int16Array(FRAME_SAMPLES).fill(20);
const voice = () => new Int16Array(FRAME_SAMPLES).map((_, i) => (i % 2 === 0 ? 4000 : -4000));
const topics = (msgs: ReadonlyArray<{ readonly topic: string }>) => msgs.map((m) => m.topic);

describe("uplink between sessions", () => {
  it("sends nothing while the room is quiet", () => {
    const up = createUplink();
    for (let t = 0; t < 20; t++) expect(up.push(quiet(), t * 60)).toEqual([]);
  });

  it("sends a voiced segment with 300 ms before it, then ends it after half a second of quiet", () => {
    const up = createUplink();
    for (let t = 0; t < 10; t++) up.push(quiet(), t * 60);
    const first = up.push(voice(), 600);
    expect(topics(first)).toEqual(["voice/wake"]);
    expect(first[0]!.pcm!.length).toBe(5 * FRAME_SAMPLES);
    expect(topics(up.push(voice(), 660))).toEqual(["voice/wake"]);
    const tail = Array.from({ length: 8 }, (_, i) => up.push(quiet(), 720 + i * 60)).flat();
    expect(topics(tail).at(-1)).toBe("voice/wake/end");
    expect(topics(tail).filter((t) => t === "voice/wake/end")).toHaveLength(1);
  });

  it("caps a segment at six seconds", () => {
    const up = createUplink();
    const all = Array.from({ length: 120 }, (_, i) => up.push(voice(), i * 60)).flat();
    expect(topics(all).indexOf("voice/wake/end")).toBeGreaterThan(0);
    expect(topics(all).filter((t) => t === "voice/wake").length).toBeGreaterThan(100);
  });
});

describe("uplink in a session", () => {
  it("ends a wake segment in flight and then streams every frame", () => {
    const up = createUplink();
    up.push(voice(), 0);
    expect(topics(up.session(true))).toEqual(["voice/wake/end"]);
    expect(topics(up.push(quiet(), 60))).toEqual(["voice/up"]);
    expect(topics(up.push(voice(), 120))).toEqual(["voice/up"]);
  });

  it("keeps the microphone shut while she speaks and for 300 ms after", () => {
    const up = createUplink();
    up.session(true);
    up.playing(true, 0);
    expect(up.push(voice(), 60)).toEqual([]);
    up.playing(false, 1000);
    expect(up.push(voice(), 1200)).toEqual([]);
    expect(topics(up.push(voice(), 1301))).toEqual(["voice/up"]);
  });
});

describe("framer", () => {
  it("resamples to 16 kHz and cuts 60 ms frames across buffers", () => {
    const frame = createFramer();
    const rate = 48_000;
    const got = [
      ...frame(new Int16Array(1000).fill(100), rate),
      ...frame(new Int16Array(2000).fill(100), rate),
    ];
    // 3000 samples at 48 kHz is about 1000 at 16 kHz: one full frame.
    expect(got).toHaveLength(1);
    expect(got[0]!.length).toBe(FRAME_SAMPLES);
    expect(got[0]!.every((s) => s === 100)).toBe(true);
    expect(frame(new Int16Array(FRAME_SAMPLES * 2), 16_000)).toHaveLength(2);
  });
});

describe("satellite face", () => {
  it("shows what it can see", () => {
    const at = { session: true, playing: false, hearing: false, sinceVoiceMs: null };
    expect(satelliteMoment({ ...at, session: false })).toBe("rest");
    expect(satelliteMoment({ ...at, playing: true })).toBe("speaking");
    expect(satelliteMoment({ ...at, hearing: true })).toBe("listening");
    expect(satelliteMoment({ ...at, sinceVoiceMs: 1200 })).toBe("thinking");
    expect(satelliteMoment({ ...at, sinceVoiceMs: 20_000 })).toBe("listening");
    expect([expressionOfMood("worried"), expressionOfMood("nonsense")]).toEqual([
      "concerned",
      "neutral",
    ]);
  });

  it("carries PCM as little-endian base64", () => {
    expect(pcmToBase64(new Int16Array([1, -1]))).toBe("AQD//w==");
  });
});
