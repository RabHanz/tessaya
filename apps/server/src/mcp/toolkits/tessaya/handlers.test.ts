import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import type { BatonMemoryQuery } from "@t3tools/baton-contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layerMemory as SqlitePersistenceMemory } from "../../../baton/BatonDatabase.ts";
import { BatonMemoryService, MemoryViewer } from "../../../baton/BatonMemoryService.ts";
import { BatonPhoneInbox, layer as inboxLayer } from "../../../baton/BatonPhoneInbox.ts";
import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { BatonSessionCatalogService } from "../../../baton/BatonSessionCatalogService.ts";
import { BatonWeaveService } from "../../../baton/BatonWeaveService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as TessayaHandlers from "./handlers.ts";
import { TessayaToolkit } from "./tools.ts";

const thread = ThreadId.make("thread:tessaya");

/** One tool call by an outside agent with this access, or by a T3 thread agent when access is "thread". */
const callTool = (
  caller: AuthMcpClientAccess | "thread",
  runtime: Context.Context<never>,
  name: keyof (typeof TessayaToolkit)["tools"],
  input: unknown,
  sessionId = "agent-1",
) =>
  Effect.gen(function* () {
    const toolkit = yield* TessayaToolkit;
    const result = yield* toolkit
      .handle(name, input as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return result.at(-1)!;
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(TessayaHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:tessaya"),
              requestNamespace: "client:tessaya",
              thread:
                caller === "thread"
                  ? {
                      threadId: thread,
                      providerSessionId: "provider:tessaya",
                      providerInstanceId: ProviderInstanceId.make("codex"),
                    }
                  : undefined,
              client:
                caller === "thread"
                  ? undefined
                  : { sessionId, label: "Claude Code", access: caller },
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(thread)),
            }),
            Layer.succeed(BatonRuntime, runtime as never),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(7)),
            ),
          ),
        ),
      ),
    ),
  );

it.effect(
  "an outside agent searches memory as a client, so walls hold and it names no persona",
  () =>
    Effect.gen(function* () {
      const asked: Array<[BatonMemoryQuery, string]> = [];
      const memory = BatonMemoryService.of({
        search: (query: BatonMemoryQuery) =>
          Effect.gen(function* () {
            asked.push([query, yield* MemoryViewer]);
            return [];
          }),
      } as never);
      const result = yield* callTool(
        "read-only",
        Context.make(BatonMemoryService, memory) as never,
        "tessaya_memory_search",
        { text: "deploy key" },
      );
      expect(result.isFailure).toBe(false);
      expect(asked).toEqual([[{ text: "deploy key", limit: 10 }, "client"]]);
    }),
);

it.effect(
  "an outside agent can ask whether anything is mid-turn before it updates or installs (SESS-SURVIVE)",
  () =>
    Effect.gen(function* () {
      const found = { threads: [{ threadId: "t1", title: "Fix the build" }], live: [] };
      const catalog = BatonSessionCatalogService.of({
        inFlight: () => Effect.succeed(found),
      } as never);
      const result = yield* callTool(
        "read-only",
        Context.make(BatonSessionCatalogService, catalog) as never,
        "tessaya_in_flight",
        {},
      );
      expect(result.isFailure).toBe(false);
      expect(result.result).toEqual(found);
    }),
);

it.effect(
  "refuses T3's own thread agents: Tessaya's tools are for agents signed in from outside",
  () =>
    Effect.gen(function* () {
      const memory = BatonMemoryService.of({ search: () => Effect.succeed([]) } as never);
      const result = yield* callTool(
        "thread",
        Context.make(BatonMemoryService, memory) as never,
        "tessaya_memory_search",
        { text: "deploy key" },
      );
      expect(result.result).toMatchObject({ code: "capability_denied" });
    }),
);

it.effect(
  "an outside agent's ask reaches the desktop as a device's words; read-only agents cannot ask, and only its own asks can be read",
  () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      // The desktop has taken from the queue, so it counts as connected.
      yield* inbox.take;
      const runtime = Context.make(BatonPhoneInbox, inbox) as never;

      const refused = yield* callTool("read-only", runtime, "tessaya_ask", { text: "stop job 3" });
      expect(refused.isFailure).toBe(true);
      expect(yield* inbox.take).toBeNull();

      const made = yield* callTool("auto", runtime, "tessaya_ask", { text: "stop job 3" });
      const id = (made.result as { id: string }).id;
      expect(id).toMatch(/^mcp-/);
      expect(yield* inbox.take).toMatchObject({ id, text: "stop job 3", source: "device" });

      const status = yield* callTool("read-only", runtime, "tessaya_ask_status", { id });
      expect(status.result).toMatchObject({ id, status: "taken" });

      yield* inbox.post({ id: "web-aaaa-0001", text: "his own words" });
      const other = yield* callTool("read-only", runtime, "tessaya_ask_status", {
        id: "web-aaaa-0001",
      });
      expect(other.result).toMatchObject({ id: null, line: "No such request." });
    }).pipe(Effect.provide(inboxLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

it.effect(
  "an agent has one request open at a time, agents three in all, and none reads another's",
  () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      yield* inbox.take;
      const runtime = Context.make(BatonPhoneInbox, inbox) as never;
      const ask = (sessionId: string) =>
        callTool("auto", runtime, "tessaya_ask", { text: "stop job 3" }, sessionId).pipe(
          Effect.map((r) => r.result as { id: string | null; line: string }),
        );

      const first = yield* ask("agent-1");
      expect(first.id).not.toBeNull();
      expect((yield* ask("agent-1")).line).toContain("still waiting");

      const theirs = yield* callTool(
        "read-only",
        runtime,
        "tessaya_ask_status",
        { id: first.id },
        "agent-2",
      );
      expect(theirs.result).toMatchObject({ id: null, status: "unknown" });

      expect((yield* ask("agent-2")).id).not.toBeNull();
      expect((yield* ask("agent-3")).id).not.toBeNull();
      expect((yield* ask("agent-4")).line).toContain("three requests waiting");
    }).pipe(Effect.provide(inboxLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

const weaveFrom = (
  client: {
    label: string;
    access: "full-access" | "auto";
    linked?: boolean;
    narrowedTo?: { runtimeMode: "auto"; interactionMode: "default" };
    sessionId?: string;
  },
  times = 1,
) =>
  Effect.gen(function* () {
    const sent: unknown[] = [];
    const weave = BatonWeaveService.of({
      send: (input: unknown) =>
        Effect.sync(() => {
          sent.push(input);
          return {
            id: "w1",
            from: "x",
            toLabel: "build",
            toPane: "p1",
            text: "rerun the tests",
            status: "delivered",
            reason: null,
            job: null,
            tries: 1,
            createdAt: 0,
            deliveredAt: 0,
            repliedAt: null,
            reply: null,
          } as const;
        }),
      tick: Effect.succeed({ delivered: 0, replied: 0 }),
    } as never);
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:tessaya"),
        requestNamespace: "client:tessaya",
        thread: undefined,
        client: { sessionId: "link-1", ...client },
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.succeed(BatonRuntime, Context.make(BatonWeaveService, weave) as never),
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(7)),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* TessayaToolkit;
      const results = [];
      for (let i = 0; i < times; i += 1)
        results.push(
          yield* toolkit
            .handle("weave_send", {
              to: "build",
              text: "rerun the tests",
              from: "Tessaya",
            } as never)
            .pipe(Stream.unwrap, Stream.runCollect),
        );
      return results.at(-1)!;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(TessayaHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
    return { failed: result.at(-1)?.isFailure, sent };
  });

it.effect(
  "weave_send from a full-access link goes through, named by its link, whatever `from` it passes",
  () =>
    Effect.gen(function* () {
      const { failed, sent } = yield* weaveFrom({
        label: "Codex on the laptop",
        linked: true,
        access: "full-access",
      });
      expect(failed).toBe(false);
      // The session reads who sent it, quoted, before the text.
      expect(sent).toEqual([
        {
          to: "build",
          text: 'From an agent on "Codex on the laptop", via Tessaya. It is another agent, not the user.\n\nrerun the tests',
          from: "Codex on the laptop",
        },
      ]);
    }),
);

it.effect("weave_send from a link below full access is refused, and nothing is typed", () =>
  Effect.gen(function* () {
    const { failed, sent } = yield* weaveFrom({
      label: "Ann's laptop",
      access: "auto",
      linked: true,
    });
    expect(failed).toBe(true);
    expect(sent).toEqual([]);
  }),
);

it.effect(
  "weave_send needs full access from any outside agent, and within modes it narrowed itself",
  () =>
    Effect.gen(function* () {
      const auto = yield* weaveFrom({ label: "Codex", access: "auto" });
      expect(auto).toEqual({ failed: true, sent: [] });
      const narrowed = yield* weaveFrom({
        label: "Codex",
        access: "full-access",
        linked: true,
        narrowedTo: { runtimeMode: "auto", interactionMode: "default" },
      });
      expect(narrowed).toEqual({ failed: true, sent: [] });
    }),
);

it.effect("weave_send holds one client session to 30 messages a minute", () =>
  Effect.gen(function* () {
    const { failed, sent } = yield* weaveFrom(
      { label: "Codex", access: "full-access", sessionId: "client-flood" },
      31,
    );
    expect(failed).toBe(true);
    expect(sent).toHaveLength(30);
  }),
);

it.effect(
  "tells an agent how she is set up, one section at a time, and says so when her desktop is away",
  () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      const runtime = Context.make(BatonPhoneInbox, inbox) as never;
      const away = yield* callTool("read-only", runtime, "tessaya_state", { section: "voice" });
      expect(away.result).toMatchObject({ connected: false, section: "voice" });
      expect(String((away.result as { value: unknown }).value)).toContain("isn't connected");
      expect((away.result as { server: { version: string } }).server.version).not.toBe("");

      yield* inbox.take;
      yield* inbox.publishState({
        settings: {
          output: "spoken",
          captureApproval: "ask",
          actWithoutAsking: false,
          socialOn: true,
          browserChrome: false,
          remoteHands: false,
          assistantModel: "auto",
          assistantEffort: "auto",
        },
        voice: {
          enabled: true,
          voice: "anna",
          recognition: "local",
          cloudProvider: "openai",
          cloudModel: null,
          languages: ["en"],
          wakeWords: ["freya"],
          dictationCleanup: "claude",
        },
        personas: [],
        skills: [],
        diagnostics: {
          appVersion: "1.2.3",
          brain: "opus",
          voiceEngine: "kokoro",
          recognition: "local",
          environments: [],
          errors: [],
        },
      });
      const here = yield* callTool("read-only", runtime, "tessaya_state", { section: "voice" });
      expect(here.result).toMatchObject({
        connected: true,
        value: { recognition: "local", wakeWords: ["freya"] },
      });
    }).pipe(Effect.provide(inboxLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

it.effect(
  "an agent's move reaches the same service guard: no approval of its own, and a thread agent may ask",
  () =>
    Effect.gen(function* () {
      const asked: Array<unknown> = [];
      const catalog = BatonSessionCatalogService.of({
        moveIntoTessaya: (input: { providerChangeApproved?: boolean }) =>
          Effect.sync(() => {
            asked.push(input);
            return input.providerChangeApproved === true
              ? { state: "moved", detail: "ok", instanceId: "claudeAgent" }
              : { state: "refused", detail: "needs approval", instanceId: null };
          }),
      } as never);
      const runtime = Context.make(BatonSessionCatalogService, catalog) as never;
      const refused = yield* callTool("thread", runtime, "tessaya_move_into_tessaya", {
        threadId: thread,
      });
      expect(refused.result).toMatchObject({ state: "refused" });
      expect(asked).toEqual([{ threadId: thread }]);
      const moved = yield* callTool("full-access", runtime, "tessaya_move_into_tessaya", {
        threadId: thread,
        providerChangeApproved: true,
      });
      expect(moved.result).toMatchObject({ state: "moved" });
    }),
);

it.effect(
  "an agent opens a thread's session in a terminal through the service, busy refusal included",
  () =>
    Effect.gen(function* () {
      const catalog = BatonSessionCatalogService.of({
        openInTerminal: () =>
          Effect.succeed({ state: "busy", pane: null, detail: "A turn is running." }),
      } as never);
      const result = yield* callTool(
        "thread",
        Context.make(BatonSessionCatalogService, catalog) as never,
        "tessaya_open_in_terminal",
        { threadId: thread },
      );
      expect(result.result).toMatchObject({ state: "busy" });
    }),
);

it.effect(
  "an agent marks the main session through the service and reads the defaults, but cannot set them",
  () =>
    Effect.gen(function* () {
      let mainThreadId: string | null = null;
      const catalog = BatonSessionCatalogService.of({
        mainSession: (input: { threadId: string; main: boolean }) =>
          Effect.sync(() => {
            mainThreadId = input.main ? input.threadId : null;
            return { newSessionsRun: "tessaya", mainThreadId };
          }),
        sessionDefaults: Effect.sync(() => ({ newSessionsRun: "tessaya", mainThreadId })),
      } as never);
      const runtime = Context.make(BatonSessionCatalogService, catalog) as never;
      const marked = yield* callTool("thread", runtime, "tessaya_main_session", {
        threadId: thread,
        main: true,
      });
      expect(marked.result).toMatchObject({ mainThreadId: thread });
      const read = yield* callTool("read-only", runtime, "tessaya_session_defaults", {});
      expect(read.result).toEqual({ newSessionsRun: "tessaya", mainThreadId: thread });
      expect(Object.keys(TessayaToolkit.tools)).not.toContain("tessaya_session_defaults_update");
    }),
);
