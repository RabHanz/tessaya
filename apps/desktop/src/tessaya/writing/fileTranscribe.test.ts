import { describe, expect, it } from "vite-plus/test";

import { transcribeFile, type FilePorts } from "./fileTranscribe.ts";

const wav = (samples: number, rate = 16_000): Uint8Array => {
  const bytes = new Uint8Array(44 + samples * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples * 2, true);
  return bytes;
};

const ports = (over: Partial<FilePorts> = {}): FilePorts => ({
  readFile: async () => wav(16_000 * 130),
  toWav: async () => null,
  transcribe: async () => "hello",
  ...over,
});

describe("transcribing a file", () => {
  it("reads a wav a minute at a time and joins what was heard", async () => {
    const heard: number[] = [];
    const out = await transcribeFile(
      "C:\\talk.wav",
      ports({ transcribe: async (pcm) => (heard.push(pcm.length), `part${heard.length}`) }),
    );
    expect(out).toEqual({ ok: true, text: "part1 part2 part3" });
    expect(heard).toEqual([960_000, 960_000, 160_000]);
  });
  it("says plainly what it cannot do", async () => {
    expect(await transcribeFile("notes.docx", ports())).toMatchObject({ ok: false });
    const noFfmpeg = await transcribeFile("memo.mp3", ports());
    expect(noFfmpeg).toMatchObject({ ok: false });
    expect(!noFfmpeg.ok && noFfmpeg.why).toContain("ffmpeg");
    expect(
      await transcribeFile("x.wav", ports({ readFile: async () => new Uint8Array(10) })),
    ).toMatchObject({ ok: false });
    expect(await transcribeFile("x.wav", ports({ transcribe: async () => "  " }))).toMatchObject({
      ok: false,
      why: "No speech was recognised in that file.",
    });
  });
  it("sends a converted file through the same path, and stops at a failed minute", async () => {
    const ok = await transcribeFile("memo.m4a", ports({ toWav: async () => wav(16_000 * 5) }));
    expect(ok).toEqual({ ok: true, text: "hello" });
    let n = 0;
    const stopped = await transcribeFile(
      "x.wav",
      ports({
        transcribe: async () => {
          if (++n === 2) throw new Error("boom");
          return "a";
        },
      }),
    );
    expect(stopped).toEqual({
      ok: false,
      why: "Recognition stopped at minute 2. Nothing was saved.",
    });
  });
});
