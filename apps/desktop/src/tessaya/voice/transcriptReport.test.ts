import { describe, expect, it } from "vite-plus/test";

import { buildTranscriptReport } from "./transcriptReport.ts";

const turn = {
  id: "t1",
  at: "2026-11-02T10:00:00.000Z",
  kind: "dictation" as const,
  app: "notepad.exe",
  raw: "there is still many",
  cleaned: "There are still many." as string | null,
  status: "ok" as const,
  model: "haiku" as string | null,
  delivery: "oneshot" as string | null,
  audio: "C:/clip.opus" as string | null,
  seconds: 3.24 as number | null,
  error: null as string | null,
  versions: [] as Array<{ at: string; raw: string; cleaned: string | null; model: string | null }>,
  corrected: false,
};

describe("the transcript report", () => {
  it("holds the words and how they were made, says the recording is not included, and leaves room for what was wrong", () => {
    const text = buildTranscriptReport(turn, { version: "0.1.40", platform: "win32" });
    expect(text).toContain("Tessaya 0.1.40 on win32");
    expect(text).toContain("there is still many");
    expect(text).toContain("There are still many.");
    expect(text).toContain("Recording kept: yes (not included in this file)");
    expect(text).toContain("Length: 3.2 s");
    expect(text).toContain("## What was wrong");
    expect(text).not.toContain("clip.opus");
  });
  it("lists every version and cannot be broken out of its fence", () => {
    const text = buildTranscriptReport(
      {
        ...turn,
        raw: "a ``` b",
        versions: [
          { at: "x", raw: "1", cleaned: null, model: null },
          { at: "y", raw: "2", cleaned: "Two.", model: null },
        ],
      },
      { version: "v", platform: "p" },
    );
    expect(text).toContain("### 2 (y)");
    expect(text).not.toContain("a ``` b");
  });
});
