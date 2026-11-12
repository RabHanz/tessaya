import { describe, expect, it } from "vite-plus/test";

import {
  deniedReason,
  judgeMedia,
  pathsInto,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
} from "./mediaPolicy.ts";

const roots = ["/home/orbit/VantageOS", "/tmp"];
const judge = (real: string, over: Partial<Parameters<typeof judgeMedia>[0]> = {}) =>
  judgeMedia({ real, size: 1_000, touched: false, roots, ...over });

describe("what media may be shown", () => {
  it("shows images and videos under the folders the thread owns, and nowhere else unless the session touched them", () => {
    expect(judge("/home/orbit/VantageOS/.baton/outbox/baton-logo-concepts.png")).toEqual({
      verdict: "attach",
      kind: "image",
    });
    expect(judge("/tmp/shot/out.mp4")).toEqual({ verdict: "attach", kind: "video" });
    expect(judge("/srv/work/projects-00001/dev/baton-frames/a.png")).toMatchObject({
      verdict: "skip",
    });
    expect(judge("/srv/work/projects-00001/dev/baton-frames/a.png", { touched: true })).toEqual({
      verdict: "attach",
      kind: "image",
    });
    expect(judge("/home/orbit/VantageOS/notes.txt")).toMatchObject({
      verdict: "skip",
      reason: "not an image or video",
    });
    expect(judge("/home/orbit/VantageOS/empty.png", { size: 0 })).toMatchObject({
      verdict: "skip",
    });
  });

  it("links what is over the limit and never copies a secret, touched or not", () => {
    expect(judge("/tmp/a.png", { size: MAX_IMAGE_BYTES + 1 })).toEqual({
      verdict: "link",
      kind: "image",
      size: MAX_IMAGE_BYTES + 1,
    });
    expect(judge("/tmp/a.mp4", { size: MAX_IMAGE_BYTES + 1 })).toEqual({
      verdict: "attach",
      kind: "video",
    });
    expect(judge("/tmp/a.mp4", { size: MAX_VIDEO_BYTES + 1 })).toMatchObject({
      verdict: "link",
      kind: "video",
    });
    for (const secret of [
      "/home/dev/.ssh/diagram.png",
      "/home/dev/.aws/x.png",
      "/home/dev/.claude-b/shots/a.png",
      "/home/dev/.t3/userdata/secrets/a.png",
      "/home/dev/.config/google-chrome/Default/a.png",
      "/work/.env.png",
      "/work/id_rsa.png",
      "/work/server.pem.png",
      "/work/credentials.png",
      "/work/api-token-screenshot.png",
      "/work/proj/.git/a.png",
      "/work/proj/node_modules/pkg/logo.png",
    ]) {
      expect(deniedReason(secret), secret).not.toBeNull();
      expect(judge(secret, { touched: true, roots: ["/"] }), secret).toMatchObject({
        verdict: "skip",
      });
    }
    expect(deniedReason("/home/orbit/VantageOS/.baton/outbox/a.png")).toBeNull();
  });

  it("finds media paths in a tool call's nested input and output", () => {
    const found = pathsInto({
      command: "ffmpeg -i in.mov /tmp/out/clip.mp4 && echo done",
      filename: "shots/a.png",
      nested: [{ file_path: "/x/y.jpg" }, "notes.md"],
    });
    expect([...found].sort()).toEqual(
      ["/tmp/out/clip.mp4", "/x/y.jpg", "in.mov", "shots/a.png"].sort(),
    );
    // A long unbroken run once backtracked quadratically and froze the server for minutes.
    const long = pathsInto({ output: `saved out/shot.png ${"a".repeat(200_000)}` });
    expect([...long]).toEqual(["out/shot.png"]);
  });
});
