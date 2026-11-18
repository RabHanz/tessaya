// @effect-diagnostics unsafeEffectTypeAssertion:off
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { MEMORY_UNLEARN_CLIENT } from "@t3tools/tessaya-shared/memory";
import { McpSchema, McpServer, Tool } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DeviceToolkit } from "../device/tools.ts";
import { JobTools } from "../jobs/tools.ts";
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
    // One /mcp serves both: a shared name hid one of them (Tessaya's device registry behind T3's simulators).
    const upstream = Object.keys(DeviceToolkit.tools);
    expect(registered.filter((name) => upstream.includes(name))).toEqual([]);
  }),
);

// An agent signed in from outside never sees the acts a vessel runs for him (stop a job, run a schedule): it asks
// through tessaya_ask, and the job handlers refuse it too (jobs/handlers.ts roomOnly).
it.effect("an outside agent is not shown the job and schedule acts; the room is", () =>
  Effect.gen(function* () {
    const shown = (sessionId: string, label = "an agent") =>
      Effect.sync(() =>
        Object.values(TessayaToolkit.tools)
          .filter((tool: Tool.Any) => {
            const enabled = Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);
            return enabled === undefined || enabled({ protocolVersion: "", capabilities: {} });
          })
          .map((tool) => tool.name),
      ).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          client: { sessionId, label, access: "full-access" },
        } as McpInvocationContext.McpInvocationContext["Service"]),
      );
    const outside = yield* shown("outside-agent");
    const room = yield* shown("r1-room");
    const acts = JobTools.map((tool) => tool.name);
    expect(acts.filter((name) => outside.includes(name))).toEqual([]);
    expect(acts.filter((name) => !room.includes(name))).toEqual([]);
    expect(outside).toContain("tessaya_ask");
    // Unlearning is the owner's own `t3 memory` command's alone: no agent, not even the room, sees it.
    expect([...outside, ...room]).not.toContain("tessaya_memory_unlearn");
    expect(yield* shown("cli", MEMORY_UNLEARN_CLIENT)).toContain("tessaya_memory_unlearn");
  }),
);
