import { describe, expect, it } from "vite-plus/test";

import {
  cueFor,
  islandFaceShows,
  jobMoments,
  momentOf,
  wanders,
  type JobSnapshot,
} from "./companion.ts";

describe("companion cues", () => {
  it("leaves dictation to him: her face does not change while he dictates", () => {
    expect(momentOf("dictating")).toBeNull();
    expect(momentOf("done")).toBeNull();
    expect(momentOf("working")).toBe("thinking");
  });

  it("scales reactions with his motion level", () => {
    expect(cueFor("listening", "lively")).toEqual({ expression: "attentive", clip: "leanIn" });
    expect(cueFor("listening", "calm")).toEqual({ expression: "attentive" });
    expect(cueFor("listening", "important")).toBeNull();
    expect(cueFor("thinking", "important")).toBeNull();
    expect(cueFor("done", "important")).toEqual({
      expression: "proud",
      clip: "hop",
      fx: "sparkle",
    });
    expect(cueFor("failed", "calm")).toEqual({ expression: "concerned", fx: "sweat" });
    expect(cueFor("failed", "important")).toEqual({ expression: "concerned" });
    expect(cueFor("speaking", "important")).toEqual({ expression: "happy" });
    expect([wanders("lively"), wanders("calm"), wanders("important")]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("shows her face in the pill only while he talks to her and the mascot is off", () => {
    const shows = (phase: Parameters<typeof islandFaceShows>[0]["phase"], mascotOn = false) =>
      islandFaceShows({ phase, faceOn: true, mascotOn });
    expect(["listening", "thinking", "speaking"].map((p) => shows(p as "listening"))).toEqual([
      true,
      true,
      true,
    ]);
    expect(shows("dictating")).toBe(false);
    expect(shows("idle")).toBe(false);
    expect(shows("speaking", true)).toBe(false);
    expect(islandFaceShows({ phase: "speaking", faceOn: false, mascotOn: false })).toBe(false);
  });
});

describe("jobMoments", () => {
  const job = (id: string, state: JobSnapshot["state"]): JobSnapshot => ({
    id,
    title: `Job ${id}`,
    state,
  });

  it("says nothing about what was already there on the first read", () => {
    expect(jobMoments(null, [job("a", "failed")])).toEqual([]);
  });

  it("reacts once to a job that finishes, fails or starts waiting for him", () => {
    const prev = [
      job("a", "working"),
      job("b", "working"),
      job("c", "working"),
      job("d", "failed"),
    ];
    const next = [
      job("a", "done_unseen"),
      job("b", "failed"),
      job("c", "needs_input"),
      job("d", "failed"),
    ];
    expect(jobMoments(prev, next)).toEqual([
      { moment: "done", title: "Job a" },
      { moment: "failed", title: "Job b" },
      { moment: "needs", title: "Job c" },
    ]);
    expect(jobMoments(next, next)).toEqual([]);
  });

  it("treats a job that waits for approval and then for input as one wait", () => {
    expect(jobMoments([job("a", "needs_approval")], [job("a", "needs_input")])).toEqual([]);
    expect(jobMoments([], [job("n", "done_unseen")])).toEqual([{ moment: "done", title: "Job n" }]);
  });
});
