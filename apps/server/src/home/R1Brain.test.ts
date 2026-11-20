import { it as effectIt } from "@effect/vitest";
import { expect, it } from "vite-plus/test";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { BrainUsage } from "../tessaya/BrainUsage.ts";
import {
  DictationCleanupApi,
  converseReader,
  withToolSearch,
  type ConversePart,
  type ConverseRequest,
  type StreamUsage,
} from "../speech/DictationCleanupApi.ts";
import { MAX_ROUNDS, make, readLine, toolLoop, type ToolTurn } from "./R1Brain.ts";
import { toolIndex } from "@t3tools/tessaya-shared/toolIndex";

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
    data({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    data({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "" },
    }),
    data({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig" },
    }),
    data({ type: "content_block_stop", index: 0 }),
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
    // Tool search found a deferred tool: its call and result go back whole, so what it loaded stays loaded.
    data({
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "server_tool_use",
        id: "s1",
        name: "tool_search_tool_bm25",
        input: {},
      },
    }),
    data({
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"query":"device_watch"}' },
    }),
    data({ type: "content_block_stop", index: 2 }),
    data({
      type: "content_block_start",
      index: 3,
      content_block: {
        type: "tool_search_tool_result",
        tool_use_id: "s1",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "device_watch" }],
        },
      },
    }),
    data({ type: "content_block_stop", index: 3 }),
    "event: content_block_delta",
    "data: {broken",
    data({ type: "message_delta", usage: { output_tokens: 22 } }),
  ];
  expect(lines.flatMap(read)).toEqual([
    { type: "thinking", block: { type: "thinking", thinking: "", signature: "sig" } },
    { type: "text", text: "Let me check." },
    { type: "tool", id: "t1", name: "home_state", input: { entityId: "light.study" } },
    {
      type: "server",
      block: {
        type: "server_tool_use",
        id: "s1",
        name: "tool_search_tool_bm25",
        input: { query: "device_watch" },
      },
    },
    {
      type: "server",
      block: {
        type: "tool_search_tool_result",
        tool_use_id: "s1",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "device_watch" }],
        },
      },
    },
  ]);
  // Its usage row's counts: the start's input, the last delta's output.
  expect(seen).toEqual({
    model: "claude-haiku-5-5",
    usage: { input_tokens: 40, output_tokens: 22 },
  });
});

it("sends the core tools loaded and cached, and every other tool deferred behind tool search", () => {
  const tool = (name: string) => ({ name, description: name, input_schema: {} });
  const sent = withToolSearch([
    tool("device_watch"),
    tool("home_find"),
    tool("home_do"),
  ]) as ReadonlyArray<Record<string, unknown>>;
  expect(
    sent.map((t) => [t["name"], t["defer_loading"] ?? false, t["cache_control"] !== undefined]),
  ).toEqual([
    ["tool_search_tool_bm25", false, false],
    ["home_find", false, false],
    ["home_do", false, true],
    ["device_watch", true, false],
  ]);
  // Only core or only deferred: no search tool, sent as before.
  expect(withToolSearch([tool("home_find")])).toEqual([
    { ...tool("home_find"), cache_control: { type: "ephemeral" } },
  ]);
  // Her index names only the deferred ones, by family.
  expect(
    toolIndex(["home_find", "home_undo", "device_watch", "tessaya_cast_set"]).split("\n").slice(1),
  ).toEqual(["device: device_watch", "home: home_undo", "cast: tessaya_cast_set"]);
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
      const thought = { type: "thinking", thinking: "", signature: "sig" };
      const model = scripted([
        [{ type: "thinking", block: thought }, { type: "text", text: "Let me check." }, call("a")],
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
      // Its thinking goes back unchanged, where it was: the API may refuse a tool round without it.
      expect(model.requests[1]!.messages.at(-2)).toEqual({
        role: "assistant",
        content: [
          thought,
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "a", name: "home_state", input: {} },
        ],
      });
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

effectIt.effect(
  "a hand-off to Opus goes on his key when his deep row says so, not to a subscription session",
  () =>
    Effect.gen(function* () {
      const roles: Array<string> = [];
      const brain = yield* make("s").pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({
              brainCredentials: { deep: { use: "apiKey:anthropic" } },
            }),
            Layer.mock(DictationCleanupApi)({
              converse: (route) => {
                roles.push(`${route.role}:${route.model}`);
                return Stream.make({ type: "text", text: "Here is the plan." } as const);
              },
            }),
            Layer.mock(BrainUsage)({}),
          ),
        ),
      );
      const said = yield* brain
        .session({
          ...turn(() => Effect.succeed({ text: "", isError: false })),
          vessel: "r1",
          role: "deep",
          cue: () => undefined,
        })
        .pipe(Stream.mkString);
      expect(said).toBe("Here is the plan.");
      expect(roles).toEqual(["deep:opus"]);
    }).pipe(Effect.scoped),
);
