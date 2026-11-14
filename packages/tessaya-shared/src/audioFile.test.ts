import { describe, expect, it } from "vite-plus/test";

import {
  baseName,
  chunkRanges,
  ffmpegArgs,
  isAcceptedAudio,
  isWavFile,
  transcriptTitle,
} from "./audioFile.ts";

describe("audio files", () => {
  it("accepts wav as it is and common formats through ffmpeg, and nothing else", () => {
    expect(isWavFile("C:\\a\\Talk.WAV")).toBe(true);
    expect(isAcceptedAudio("memo.m4a")).toBe(true);
    expect(isAcceptedAudio("notes.docx")).toBe(false);
    expect(isAcceptedAudio("noextension")).toBe(false);
  });
  it("splits a recording into whole minutes covering every sample", () => {
    const r = chunkRanges(16_000 * 150, 16_000);
    expect(r).toEqual([
      [0, 960_000],
      [960_000, 1_920_000],
      [1_920_000, 2_400_000],
    ]);
    expect(chunkRanges(0, 16_000)).toEqual([]);
  });
  it("names the transcript after the file and builds the ffmpeg call", () => {
    expect(baseName("C:\\Users\\x\\memo.mp3")).toBe("memo.mp3");
    expect(transcriptTitle("/home/x/memo.mp3")).toBe("Transcript of memo.mp3");
    expect(ffmpegArgs("in.mp3", "out.wav").slice(-5)).toEqual(["-ac", "1", "-f", "wav", "out.wav"]);
  });
});
