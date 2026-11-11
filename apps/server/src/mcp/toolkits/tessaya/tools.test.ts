// @effect-diagnostics unsafeEffectTypeAssertion:off
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpServer } from "effect/ai";

import { TessayaToolkit } from "./tools.ts";

// The server's own registration, not a copy of its rule: a tool whose parameters do not encode to an object schema
// crashed the server at start ("Does the server start?").
it.effect("every Tessaya tool registers with the MCP server", () =>
  Effect.gen(function* () {
    const registered: string[] = [];
    const recording = McpServer.McpServer.of({
      addTool: (registration: { readonly tool: { readonly name: string } }) =>
        Effect.sync(() => void registered.push(registration.tool.name)),
    } as never);
    const handlers = Object.fromEntries(
      Object.keys(TessayaToolkit.tools).map((name) => [name, () => Effect.die("not called")]),
    );
    // Registration only: no tool is called, so the per-request services a call needs are not provided.
    // oxlint-disable-next-line t3code/no-raw-mcp-registration -- a test of the schema check itself; no tool is served.
    const registration = McpServer.registerToolkit(TessayaToolkit).pipe(
      Effect.provide(TessayaToolkit.toLayer(handlers as never)),
      Effect.provideService(McpServer.McpServer, recording),
    ) as Effect.Effect<void>;
    yield* registration;
    expect(registered.toSorted()).toEqual(Object.keys(TessayaToolkit.tools).toSorted());
  }),
);
