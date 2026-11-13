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
import { HomeAssistantService, type HomeActor } from "../../../home/HomeAssistantService.ts";
import { ROOM_CLIENT } from "../home/handlers.ts";
import * as TessayaHandlers from "./handlers.ts";
import { TessayaToolkit } from "./tools.ts";

const thread = ThreadId.make("thread:tessaya");

/**
 * One tool call by an outside agent with this access, a T3 thread agent ("thread"), the R1's room ("room"), or
 * another server of his over an approval-required peer link ("linked").
 */
const callTool = (
  caller: AuthMcpClientAccess | "thread" | "room" | "linked",
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
                  : caller === "room"
                    ? ROOM_CLIENT
                    : caller === "linked"
                      ? {
                          sessionId,
                          label: "T3 Code · home server",
                          access: "approval-required",
                          linked: true,
                        }
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

it("gives an outside agent no tool that reaches a private memory store", () => {
  for (const name of Object.keys(TessayaToolkit.tools))
    expect(name).not.toMatch(/private|vault|personal/i);
});

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

      // A linked server's session id is a whole uuid (the R1 asking his laptop, 13 Nov): its ask still gets an id.
      const made = yield* callTool(
        "auto",
        runtime,
        "tessaya_ask",
        { text: "stop job 3" },
        "3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c",
      );
      const id = (made.result as { id: string }).id;
      expect(id).toMatch(/^mcp-/);
      expect(yield* inbox.take).toMatchObject({ id, text: "stop job 3", source: "device" });

      const status = yield* callTool(
        "read-only",
        runtime,
        "tessaya_ask_status",
        { id },
        "3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c",
      );
      expect(status.result).toMatchObject({ id, status: "taken" });

      yield* inbox.post({ id: "web-aaaa-0001", text: "his own words" });
      const other = yield* callTool("read-only", runtime, "tessaya_ask_status", {
        id: "web-aaaa-0001",
      });
      expect(other.result).toMatchObject({ id: null, line: "No such request." });
    }).pipe(Effect.provide(inboxLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

it.effect(
  "a linked server's ask is taken as a device's words, which the desktop's gate asks him to act on; it still cannot move his threads",
  () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      yield* inbox.take;
      const runtime = Context.make(BatonPhoneInbox, inbox) as never;

      const asked = yield* callTool("linked", runtime, "tessaya_ask", {
        text: "what's on my screen?",
      });
      expect(asked.isFailure).toBe(false);
      const id = (asked.result as { id: string }).id;
      expect(yield* inbox.take).toMatchObject({
        id,
        text: "what's on my screen?",
        source: "device",
      });

      const moved = yield* callTool("linked", runtime, "tessaya_move_into_tessaya", {
        threadId: "thread:his-own",
      });
      expect(moved.isFailure).toBe(true);
      expect(yield* inbox.take).toBeNull();
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
  "an agent's move only files a request he answers: it cannot approve itself, and nothing moves",
  () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      yield* inbox.take;
      const moved: Array<unknown> = [];
      const catalog = BatonSessionCatalogService.of({
        moveIntoTessaya: (input: unknown) => Effect.sync(() => (moved.push(input), {})),
      } as never);
      const runtime = Context.mergeAll(
        Context.make(BatonPhoneInbox, inbox),
        Context.make(BatonSessionCatalogService, catalog),
      ) as never;
      const asked = yield* callTool("thread", runtime, "tessaya_move_into_tessaya", {
        threadId: thread,
        providerChangeApproved: true,
      });
      expect(asked.result).toMatchObject({ status: "queued" });
      expect(moved).toEqual([]);
      const waiting = yield* inbox.recent(10);
      expect(waiting.map((ask) => ask.text)).toEqual([
        expect.stringContaining(`Move the Terminal thread ${thread} into Tessaya`),
      ]);
      const tool = TessayaToolkit.tools.tessaya_move_into_tessaya;
      expect(Object.keys(tool.parametersSchema.fields)).toEqual(["threadId"]);
    }).pipe(Effect.provide(inboxLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

it.effect(
  "an agent opens its own thread in a terminal at once; anyone else's thread is a request he answers",
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

it.effect("an outside agent's open in terminal on a thread files a request and opens nothing", () =>
  Effect.gen(function* () {
    const inbox = yield* BatonPhoneInbox;
    yield* inbox.take;
    const opened: Array<unknown> = [];
    const catalog = BatonSessionCatalogService.of({
      openInTerminal: (input: unknown) => Effect.sync(() => (opened.push(input), {})),
    } as never);
    const runtime = Context.mergeAll(
      Context.make(BatonPhoneInbox, inbox),
      Context.make(BatonSessionCatalogService, catalog),
    ) as never;
    const asked = yield* callTool("full-access", runtime, "tessaya_open_in_terminal", {
      threadId: thread,
    });
    expect(asked.result).toMatchObject({ status: "queued" });
    expect(opened).toEqual([]);
  }).pipe(Effect.provide(inboxLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

it.effect(
  "the R1's room acts in the house as Tessaya on the r1 surface, where the gate takes no yes; an outside agent as an agent",
  () =>
    Effect.gen(function* () {
      const by: Array<HomeActor> = [];
      const home = {
        call: (_request: unknown, actor: HomeActor) =>
          Effect.sync(() => {
            by.push(actor);
            return { status: "asked", id: "a1", line: "Sent to his phone." };
          }),
      } as unknown as HomeAssistantService["Service"];
      const runtime = Context.make(HomeAssistantService, home) as never;
      const unlock = {
        domain: "lock",
        service: "unlock",
        target: { entity_id: "lock.front" },
        why: "let me in",
      };
      const fromRoom = yield* callTool("room", runtime, "home_do", unlock);
      yield* callTool("auto", runtime, "home_do", unlock);
      expect(fromRoom.result).toMatchObject({ ok: true, value: { status: "asked" } });
      expect(by).toEqual([
        { who: "Tessaya", surface: "r1" },
        { who: "an outside agent", surface: "agent" },
      ]);
    }),
);

it("reads the Record on the house's clock with each row's age, never bare UTC (13 Nov)", () => {
  const row = {
    id: 1,
    kind: "device",
    actor: "r1",
    project: null,
    ref: null,
    subject: "heard",
    outcome: "answered",
    detail: "",
  };
  const now = Date.parse("2026-11-13T03:27:31.262Z");
  const read = TessayaHandlers.onHouseClock(
    [
      { ...row, at: "2026-11-13T03:26:31.262Z" },
      { ...row, id: 2, at: "2026-11-13T00:12:00.000Z" },
    ],
    now,
    "Asia/Karachi",
  );
  expect(read.now).toBe("2026-11-13T08:27:31+05:00");
  expect(read.entries.map((e) => [e.at, e.ago])).toEqual([
    ["2026-11-13T08:26:31+05:00", "1 min ago"],
    ["2026-11-13T05:12:00+05:00", "3 h 15 min ago"],
  ]);
  expect(TessayaHandlers.onHouseClock([row as never], now, "UTC").now).toBe(
    "2026-11-13T03:27:31+00:00",
  );
});
