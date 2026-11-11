// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  enrolOwner,
  pcmOfWav,
  pickSeedClips,
  speechWindows,
  type SeedRow,
} from "./speakerEnrolment.ts";

const wav = (samples: Int16Array, rate = 16_000) => {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer).copy(b, 44);
  return new Uint8Array(b);
};
const loud = (seconds: number, tone = 1000) =>
  Int16Array.from({ length: seconds * 16_000 }, (_, i) => Math.round(tone * Math.sin(i / 7)));

describe("the Wispr seed", () => {
  it("takes one clip from each microphone and day in turn, newest first, and only usable lengths", () => {
    const rows: SeedRow[] = [
      { id: "a1", mic: "Scarlett", at: "2026-11-07 10:00", seconds: 10 },
      { id: "a2", mic: "Scarlett", at: "2026-11-07 09:00", seconds: 10 },
      { id: "b1", mic: "Realtek", at: "2026-11-07 08:00", seconds: 10 },
      { id: "c1", mic: "Scarlett", at: "2026-10-01 10:00", seconds: 10 },
      { id: "short", mic: "Scarlett", at: "2026-11-08 10:00", seconds: 2 },
      { id: "long", mic: "Scarlett", at: "2026-11-08 11:00", seconds: 60 },
    ];
    expect(pickSeedClips(rows, 3)).toEqual(["a1", "b1", "c1"]);
    expect(pickSeedClips(rows)).toEqual(["a1", "b1", "c1", "a2"]);
  });

  it("reads only 16 kHz mono 16-bit recordings", () => {
    expect(pcmOfWav(wav(Int16Array.from([1, 2, 3])))).toEqual(Int16Array.from([1, 2, 3]));
    expect(pcmOfWav(wav(Int16Array.from([1, 2, 3]), 44_100))).toBeNull();
    expect(pcmOfWav(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

it("leaves silent windows out of the spoken enrolment", () => {
  const pcm = new Int16Array(12 * 16_000);
  pcm.set(loud(4), 0);
  pcm.set(loud(4), 8 * 16_000);
  expect(speechWindows(pcm)).toHaveLength(2);
});

describe("enrolOwner", () => {
  const embedder = {
    model: "m",
    // Every clip of him points the same way, give or take: a stand-in for the real model.
    embed: async (pcm: Int16Array) => Float32Array.from([1, (pcm.length % 7) / 100, 0]),
  };
  const saved: unknown[] = [];
  const base = {
    name: "Robin",
    embedder,
    appData: undefined,
    save: (p: unknown) => saved.push(p),
    now: new Date("2026-11-08T12:00:00Z"),
  };

  it("makes his profile from the spoken enrolment alone when he does not share his Wispr recordings", async () => {
    const result = await enrolOwner({ ...base, useWispr: false, spoken: loud(20) });
    expect(result).toMatchObject({ saved: true, wisprClips: 0, spokenSeconds: 20, samples: 5 });
    expect(saved.at(-1)).toMatchObject({
      id: "owner",
      kind: "owner",
      model: "m",
      sources: ["spoken"],
    });
  });

  it("reads his Wispr recordings only after his yes, and then uses them", async () => {
    const appData = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wispr-"));
    NodeFS.mkdirSync(NodePath.join(appData, "Wispr Flow"));
    const db = new NodeSqlite.DatabaseSync(NodePath.join(appData, "Wispr Flow", "flow.sqlite"));
    db.exec(
      "CREATE TABLE History (transcriptEntityId TEXT, micDevice TEXT, timestamp TEXT, duration REAL, audio BLOB)",
    );
    const insert = db.prepare("INSERT INTO History VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < 5; i += 1)
      insert.run(`c${i}`, "Scarlett", `2026-11-0${i + 1} 10:00`, 4, wav(loud(4)));
    db.close();
    const without = await enrolOwner({
      ...base,
      appData,
      useWispr: false,
      spoken: new Int16Array(0),
    });
    expect(without).toMatchObject({ saved: false, wisprClips: 0, why: "too-little" });
    const withSeed = await enrolOwner({
      ...base,
      appData,
      useWispr: true,
      spoken: new Int16Array(0),
    });
    expect(withSeed).toMatchObject({ saved: true, wisprClips: 5, samples: 5 });
    expect(saved.at(-1)).toMatchObject({ sources: ["wispr"] });
    NodeFS.rmSync(appData, { recursive: true, force: true });
  });

  it("saves nothing without the model, or with too little of his voice", async () => {
    expect(
      await enrolOwner({ ...base, embedder: null, useWispr: false, spoken: loud(20) }),
    ).toMatchObject({
      saved: false,
      why: "no-model",
    });
    expect(await enrolOwner({ ...base, useWispr: false, spoken: loud(8) })).toMatchObject({
      saved: false,
      why: "too-little",
    });
  });
});
