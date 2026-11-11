import { expect, it } from "vite-plus/test";

import { readLine } from "./R1Brain.ts";

it("takes text deltas and the end of the turn from Claude Code's stream-json, and nothing else", () => {
  const delta = (text: string) =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
  expect(readLine(delta("Hello"))).toEqual({ delta: "Hello" });
  expect(readLine(JSON.stringify({ type: "result", is_error: false, result: "Hello" }))).toEqual({
    done: true,
  });
  expect(
    readLine(JSON.stringify({ type: "result", is_error: true, result: "rate limited" })),
  ).toEqual({
    error: "rate limited",
  });
  expect(readLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual({});
  expect(readLine("not json")).toEqual({});
});
