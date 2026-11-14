import { describe, expect, it } from "vite-plus/test";

import {
  claudeProjectSlug,
  isComposerEcho,
  liveLimitHit,
  stripT3Wrappers,
  labelAttachmentPaths,
  parseLiveToolSteps,
  parseLiveTranscriptLine,
  splitTranscriptChunk,
} from "./liveTranscript.ts";

const line = (record: Record<string, unknown>) => JSON.stringify(record);

describe("a live transcript read as messages", () => {
  it("keeps user and assistant text with Claude Code's uuid", () => {
    expect(
      parseLiveTranscriptLine(
        line({
          type: "assistant",
          uuid: "u1",
          timestamp: "2026-10-27T01:00:00.000Z",
          message: { content: [{ type: "text", text: " hello " }, { type: "tool_use" }] },
        }),
      ),
    ).toEqual({
      uuid: "u1",
      role: "assistant",
      text: "hello",
      createdAt: "2026-10-27T01:00:00.000Z",
    });
    expect(
      parseLiveTranscriptLine(line({ type: "user", uuid: "u2", message: { content: "do it" } })),
    ).toMatchObject({ role: "user", text: "do it" });
  });

  it("keeps pasted images and the files a session sent, not images inside tool results", () => {
    const png = { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" };
    expect(
      parseLiveTranscriptLine(
        line({
          type: "user",
          uuid: "p",
          message: {
            content: [
              { type: "image", source: png },
              { type: "text", text: "look" },
            ],
          },
        }),
      ),
    ).toMatchObject({ text: "look", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] });
    expect(
      parseLiveTranscriptLine(
        line({
          type: "user",
          uuid: "t",
          message: {
            content: [{ type: "tool_result", content: [{ type: "image", source: png }] }],
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseLiveTranscriptLine(
        line({
          type: "assistant",
          uuid: "s",
          message: {
            content: [
              {
                type: "tool_use",
                name: "SendUserFile",
                input: { files: ["/tmp/a.png", "/tmp/b.pdf"], caption: "Two files" },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ role: "assistant", text: "Two files", files: ["/tmp/a.png", "/tmp/b.pdf"] });
  });

  it("drops tool results, side chains, meta, summaries and other record types", () => {
    const toolResult = { type: "user", uuid: "a", message: { content: [{ type: "tool_result" }] } };
    expect(parseLiveTranscriptLine(line(toolResult))).toBeNull();
    for (const flag of ["isSidechain", "isMeta", "isCompactSummary"]) {
      expect(
        parseLiveTranscriptLine(
          line({ type: "user", uuid: "b", [flag]: true, message: { content: "x" } }),
        ),
      ).toBeNull();
    }
    expect(parseLiveTranscriptLine(line({ type: "system", uuid: "c" }))).toBeNull();
    expect(
      parseLiveTranscriptLine(line({ type: "user", message: { content: "no uuid" } })),
    ).toBeNull();
    expect(parseLiveTranscriptLine("{not json")).toBeNull();
    for (const internal of [
      "<task-notification> <task-id>b1</task-id> </task-notification>",
      "<local-command-stdout>ok</local-command-stdout>",
      "<command-name>/clear</command-name>",
    ]) {
      expect(
        parseLiveTranscriptLine(line({ type: "user", uuid: "i", message: { content: internal } })),
      ).toBeNull();
    }
  });

  it("holds back a record cut mid-line until the rest arrives", () => {
    expect(splitTranscriptChunk('{"a":1}\n{"b":')).toEqual({ lines: ['{"a":1}'], rest: '{"b":' });
    expect(splitTranscriptChunk("partial")).toEqual({ lines: [], rest: "partial" });
  });

  it("names Claude Code's project folder the way Claude Code does", () => {
    expect(claudeProjectSlug("/srv/work/projects-00001/dev/baton-autosync")).toBe(
      "-srv-work-projects-00001-dev-baton-autosync",
    );
    expect(claudeProjectSlug("/home/orbit/VantageOS/.worktrees/x")).toBe(
      "-home-orbit-VantageOS--worktrees-x",
    );
  });

  it("strips T3's own wrappers and matches the terminal's echo of a phone message", () => {
    const echo =
      '<pasted_content id="711a"> [Image: IMG_9489.png; ref=9e6a1b68] why is it saying this? <t3_context version="1"><context kind="image" id="x"/></t3_context> @/home/u/att/x.png';
    expect(stripT3Wrappers(echo)).toBe("why is it saying this?");
    expect(isComposerEcho(echo, "why is it saying this?")).toBe(true);
    expect(stripT3Wrappers("see @/etc/hosts for details")).toBe("see @/etc/hosts for details");
  });

  it("shows an inbox path as a short label", () => {
    const old =
      "@/srv/work/projects-00001/dev/t3code/.baton/inbox/2026-11-02T11-13-47-490Z-baton-live4-5ab4ae0c-3cf4-4d50-aae3-94117d982204-6c567ac6-f2d7-4b0c-9541-41a0a052d316.png";
    expect(labelAttachmentPaths(`Look at ${old}`)).toBe("Look at \u{1F4CE} image, 11:13");
    expect(
      labelAttachmentPaths(
        "He attached image IMG_9489.png:\n@/w/.baton/inbox/2026-11-02/IMG_9489-a3f9.png",
      ),
    ).toBe("\u{1F4CE} IMG_9489-a3f9.png");
    expect(
      stripT3Wrappers(
        "why?\nHe attached image IMG_9489.png:\n@/w/.baton/inbox/2026-11-02/IMG_9489-a3f9.png",
      ),
    ).toBe("why?");
  });

  it("recognises the composer's message when attachments were appended to it", () => {
    expect(isComposerEcho("say  ALPHA\n@/w/.baton/inbox/a.png", "say ALPHA")).toBe(true);
    expect(isComposerEcho("something else", "say ALPHA")).toBe(false);
    expect(isComposerEcho("anything", "  ")).toBe(false);
  });

  it("keeps a screenshot a tool returned inline, beside the result's text", () => {
    const steps = parseLiveToolSteps(
      line({
        type: "user",
        timestamp: "2026-10-29T10:00:00.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t9",
              content: [
                { type: "text", text: "Took a screenshot" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aGk=" },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(steps).toMatchObject([
      { kind: "result", output: "Took a screenshot\n[image]", images: [{ mimeType: "image/png" }] },
    ]);
  });

  it("reads tool calls and their results as steps, without the file sends", () => {
    const at = "2026-10-29T10:00:00.000Z";
    expect(
      parseLiveToolSteps(
        line({
          type: "assistant",
          timestamp: at,
          message: {
            content: [
              { type: "text", text: "checking" },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
              { type: "tool_use", id: "t2", name: "SendUserFile", input: { files: [] } },
            ],
          },
        }),
      ),
    ).toEqual([{ kind: "use", id: "t1", name: "Bash", input: { command: "ls" }, createdAt: at }]);
    expect(
      parseLiveToolSteps(
        line({
          type: "user",
          timestamp: at,
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a b" }] },
            ],
          },
        }),
      ),
    ).toEqual([{ kind: "result", id: "t1", output: "a b", isError: false, createdAt: at }]);
    expect(
      parseLiveToolSteps(line({ type: "user", isSidechain: true, message: { content: [] } })),
    ).toEqual([]);
  });
});

describe("a message sent from a T3 composer with a pasted image", () => {
  // The composer records its text with the image as a markdown token; the session's transcript holds the words only
  // (the picture arrives as an image block). Seen on a real thread: the same message mirrored a second time, 5 s later.
  const composer =
    "![IMG_9498.png](t3-context://v1/image/d774e4af-562e-480d-8e72-8afecc450daf) The duplicated image and media bug is still not resolved.";
  it("is still the composer's own message when the transcript lacks the image token", () => {
    expect(
      isComposerEcho("The duplicated image and media bug is still not resolved.", composer),
    ).toBe(true);
    expect(
      isComposerEcho(
        "The duplicated image and media bug is still not resolved.\n@/w/.baton/inbox/a.png",
        composer,
      ),
    ).toBe(true);
  });
  it("is not an echo of a different message, and an image alone is not a message to match on words", () => {
    expect(isComposerEcho("Something else entirely.", composer)).toBe(false);
    expect(isComposerEcho("anything", "![a.png](t3-context://v1/image/x)")).toBe(false);
  });
});

describe("liveLimitHit", () => {
  const line = (entry: object) => JSON.stringify(entry);
  const hit = line({
    type: "assistant",
    timestamp: "2026-11-14T13:55:59.191Z",
    isApiErrorMessage: true,
    error: "rate_limit",
    apiErrorStatus: 429,
    message: {
      content: [{ type: "text", text: "You've hit your weekly limit · resets Nov 16, 6pm" }],
    },
  });
  it("reads the 429 a session stopped on, and nothing once it went on", () => {
    expect(
      liveLimitHit(`{"cut":\n${line({ type: "user", message: { content: "go" } })}\n${hit}\n`),
    ).toEqual({
      text: "You've hit your weekly limit · resets Nov 16, 6pm",
      at: "2026-11-14T13:55:59.191Z",
    });
    const later = line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    expect(liveLimitHit(`${hit}\n${later}`)).toBeNull();
    // Another API error is not a limit.
    expect(
      liveLimitHit(
        line({
          type: "assistant",
          isApiErrorMessage: true,
          error: "overloaded",
          message: { content: [{ type: "text", text: "Overloaded" }] },
        }),
      ),
    ).toBeNull();
  });
});
