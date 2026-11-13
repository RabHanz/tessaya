import { it as effectIt } from "@effect/vitest";
import { expect, it } from "vite-plus/test";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  converseReader,
  type ConversePart,
  type ConverseRequest,
  type StreamUsage,
} from "../speech/DictationCleanupApi.ts";
import { MAX_ROUNDS, readLine, toolLoop, type ToolTurn } from "./R1Brain.ts";

it("takes text deltas and the end of the turn from Claude Code's stream-json, and nothing else", () => {
  const delta = (text: string) =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
  expect(readLine(delta("Hello"))).toEqual({ delta: "Hello" });
  expect(
    readLine(JSON.stringify({ type: "result", is_error: false, result: "Hello" })),
  ).toMatchObject({
    done: true,
  });
  expect(
    readLine(JSON.stringify({ type: "result", is_error: true, result: "rate limited" })),
  ).toMatchObject({
    error: "rate limited",
  });
  expect(readLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual({});
  expect(readLine("not json")).toEqual({});
});

it("reads a Messages API turn: words as they come, each tool call once its input is whole", () => {
  const data = (event: object) => `data: ${JSON.stringify(event)}`;
  const seen: StreamUsage = {};
  const read = converseReader(seen);
  const lines = [
    data({
      type: "message_start",
      message: { model: "claude-haiku-5-5", usage: { input_tokens: 40, output_tokens: 1 } },
    }),
    data({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Let me check." },
    }),
    data({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t1", name: "home_state" },
    }),
    data({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"entityId":' },
    }),
    data({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"light.study"}' },
    }),
    data({ type: "content_block_stop", index: 1 }),
    "event: content_block_delta",
    "data: {broken",
    data({ type: "message_delta", usage: { output_tokens: 22 } }),
  ];
  expect(lines.flatMap(read)).toEqual([
    { type: "text", text: "Let me check." },
    { type: "tool", id: "t1", name: "home_state", input: { entityId: "light.study" } },
  ]);
  // Its usage row's counts: the start's input, the last delta's output.
  expect(seen).toEqual({
    model: "claude-haiku-5-5",
    usage: { input_tokens: 40, output_tokens: 22 },
  });
});

/** A model that plays its rounds in order and records every request it was sent. */
const scripted = (rounds: ReadonlyArray<ReadonlyArray<ConversePart>>) => {
  const requests: Array<ConverseRequest> = [];
  const converse = (request: ConverseRequest) => {
    requests.push(structuredClone(request));
    return Stream.fromIterable(rounds[Math.min(requests.length - 1, rounds.length - 1)]!);
  };
  return { requests, converse };
};
const call = (id: string): ConversePart => ({ type: "tool", id, name: "home_state", input: {} });
const turn = (run: ToolTurn["run"]): ToolTurn => ({ system: "s", user: "u", tools: [], run });

effectIt.effect("stops calling tools at the round cap: the last round may only speak", () =>
  Effect.gen(function* () {
    const model = scripted([
      [call("a")],
      [call("b")],
      [call("c")],
      [{ type: "text", text: "It's on." }],
    ]);
    const ran: Array<string> = [];
    const said = yield* toolLoop(
      model.converse,
      turn((name) => Effect.sync(() => (ran.push(name), { text: "on", isError: false }))),
    ).pipe(Stream.mkString);
    expect(said).toBe("It's on.");
    expect(ran).toHaveLength(MAX_ROUNDS - 1);
    expect(model.requests.map((r) => r.toolChoice)).toEqual(["auto", "auto", "auto", "none"]);
  }),
);

effectIt.effect(
  "hands a tool's failure back as an error in its own words, and speaks only the outcome, never the words before a tool call",
  () =>
    Effect.gen(function* () {
      const model = scripted([
        [{ type: "text", text: "Let me check." }, call("a")],
        [{ type: "text", text: "The house isn't answering." }],
      ]);
      const said = yield* toolLoop(
        model.converse,
        turn(() =>
          Effect.succeed({
            text: "Home is offline: Home Assistant is not reachable.",
            isError: true,
          }),
        ),
      ).pipe(Stream.mkString);
      expect(said).toBe("The house isn't answering.");
      expect(model.requests[1]!.messages.at(-1)).toEqual({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            content: "Home is offline: Home Assistant is not reachable.",
            is_error: true,
          },
        ],
      });
    }),
);
