import type { BatonContextSnapshot } from "@t3tools/tessaya-contracts";
import { applyContextSnapshot, emptyContextBus } from "@t3tools/tessaya-shared/contextBus";
import { describe, expect, it } from "vite-plus/test";

import { grammarClient } from "../test/grammarClient.ts";
import { createVoiceRouter } from "./router.ts";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");

const snapshot = (over: Partial<BatonContextSnapshot>): BatonContextSnapshot =>
  ({
    producer: "fabric",
    observedAt: "2026-10-26T11:59:59.000Z",
    foregroundApplication: null,
    activeWindowTitle: null,
    activeWorkSessionId: null,
    activeThreadId: null,
    vscode: null,
    browser: null,
    editableTarget: null,
    recentVoiceTarget: null,
    ...over,
  }) as BatonContextSnapshot;

const focused = applyContextSnapshot(
  emptyContextBus,
  snapshot({ activeWorkSessionId: "ws-vantageos" as never }),
);

describe("voice router", () => {
  it("runs a low-risk command through the intent path", async () => {
    const { client, calls } = grammarClient();
    const out = await createVoiceRouter(client).route(
      { kind: "command", text: "what's VantageOS doing", inheritedTarget: null },
      { bus: emptyContextBus, now: NOW },
    );
    expect(out).toMatchObject({ kind: "ran", workSessionId: "ws-vantageos" });
    expect(calls.map((c) => c.kind)).toEqual(["resolve", "run"]);
  });

  it("a follow-up's 'it' goes to the inherited conversation target", async () => {
    const { client, calls } = grammarClient();
    const out = await createVoiceRouter(client).route(
      { kind: "command", text: "tell it to run the other test too", inheritedTarget: "ws-margin" },
      { bus: focused, now: NOW },
    );
    expect(out).toMatchObject({ kind: "ran", workSessionId: "ws-margin" });
    expect(calls[0]?.target).toBe("ws-margin");
  });

  it("with no conversation target, falls back to the focused session (§14 rung 3)", async () => {
    const { client } = grammarClient();
    const out = await createVoiceRouter(client).route(
      { kind: "command", text: "tell it to run the migration tests", inheritedTarget: null },
      { bus: focused, now: NOW },
    );
    expect(out).toMatchObject({ kind: "ran", workSessionId: "ws-vantageos" });
  });

  it("refuses high-risk sentences before anything leaves the client", async () => {
    const { client, calls } = grammarClient();
    const router = createVoiceRouter(client);
    const a = await router.route(
      { kind: "command", text: "tell it to deploy to production", inheritedTarget: "ws-vantageos" },
      { bus: focused, now: NOW },
    );
    const b = await router.route(
      { kind: "session_message", text: "merge it into main" },
      { bus: focused, now: NOW },
    );
    expect(a).toMatchObject({ kind: "refused", reason: "high_risk" });
    expect(b).toMatchObject({ kind: "refused", reason: "high_risk" });
    expect(calls).toEqual([]);
  });

  it("medium risk needs a spoken confirm, then re-resolves at run time", async () => {
    const { client, calls } = grammarClient();
    const router = createVoiceRouter(client);
    const ask = await router.route(
      { kind: "command", text: "start work on VantageOS with codex", inheritedTarget: null },
      { bus: emptyContextBus, now: NOW },
    );
    expect(ask.kind).toBe("needs_confirmation");
    expect(calls.map((c) => c.kind)).toEqual(["resolve"]);
    if (ask.kind !== "needs_confirmation") return;
    const done = await router.route(
      { kind: "confirmed", token: ask.token },
      { bus: emptyContextBus, now: NOW },
    );
    expect(done.kind).toBe("ran");
    expect(calls.map((c) => c.kind)).toEqual(["resolve", "run"]);
    // A token is good once.
    const again = await router.route(
      { kind: "confirmed", token: ask.token },
      { bus: emptyContextBus, now: NOW },
    );
    expect(again.kind).toBe("refused");
  });

  it("prepare only reads: a medium-risk command parks nothing until go", async () => {
    const { client, calls } = grammarClient();
    const router = createVoiceRouter(client);
    const context = { bus: emptyContextBus, now: NOW };
    const go = await router.prepare!(
      { kind: "command", text: "start work on VantageOS with codex", inheritedTarget: null },
      context,
    );
    expect(calls.map((c) => c.kind)).toEqual(["resolve"]);
    // Before go there is no token to confirm, not even the first one it would hand out.
    const early = await router.route({ kind: "confirmed", token: "confirm-1" }, context);
    expect(early.kind).toBe("refused");
    const ask = await go();
    expect(ask.kind).toBe("needs_confirmation");
    if (ask.kind !== "needs_confirmation") return;
    expect((await router.route({ kind: "confirmed", token: ask.token }, context)).kind).toBe("ran");
    expect(calls.map((c) => c.kind)).toEqual(["resolve", "run"]);
  });

  it("direct-session speech goes only to a focused session", async () => {
    const { client, calls } = grammarClient();
    const router = createVoiceRouter(client);
    const sent = await router.route(
      { kind: "session_message", text: "Also run the migration tests." },
      { bus: focused, now: NOW },
    );
    expect(sent).toEqual({ kind: "sent_to_session", reply: "", workSessionId: "ws-vantageos" });
    const none = await router.route(
      { kind: "session_message", text: "hello" },
      { bus: emptyContextBus, now: NOW, mostRecentWorkSessionId: "ws-margin" },
    );
    expect(none).toMatchObject({ kind: "refused", reason: "no_focus" });
    expect(calls).toEqual([
      { kind: "sendToSession", text: "Also run the migration tests.", target: "ws-vantageos" },
    ]);
  });

  it("dictation goes to the focused field and never to the intent path", async () => {
    const { client, calls } = grammarClient();
    const router = createVoiceRouter(client);
    const bus = applyContextSnapshot(
      emptyContextBus,
      snapshot({
        producer: "browser" as never,
        editableTarget: {
          producer: "browser",
          kind: "browser_field",
          label: "Gmail compose",
          injectable: true,
          origin: null,
        } as never,
      }),
    );
    const out = await router.route(
      { kind: "dictate", text: "Thanks, I'll send it tomorrow." },
      { bus, now: NOW },
    );
    expect(out).toMatchObject({ kind: "dictated", inserted: true });
    expect(calls.map((c) => c.kind)).toEqual(["insertText"]);
    const nowhere = await router.route(
      { kind: "dictate", text: "x" },
      { bus: emptyContextBus, now: NOW },
    );
    expect(nowhere).toMatchObject({ kind: "dictated", inserted: false });
  });
});
