import type { BatonSessionSummary } from "@t3tools/baton-contracts";
import { expect, it, vi } from "vite-plus/test";

const ipc = vi.hoisted(() => new Map<string, (event: unknown, message: unknown) => void>());
vi.mock("electron", () => ({
  ipcMain: { on: (channel: string, handler: never) => void ipc.set(channel, handler) },
}));

import { BATON_SESSION_RESPONSE_CHANNEL } from "../channels.ts";
import { createSessionsBridge, showLiveWhenReady } from "./sessionsBridge.ts";

const summary = (key: string, over: Partial<BatonSessionSummary>): BatonSessionSummary => ({
  key,
  project: "Storefront",
  session: key,
  account: null,
  state: "idle",
  urgent: false,
  box: key,
  updatedAt: null,
  thread: null,
  pane: null,
  ...over,
});

/** A server answering the across list; `hereOnly` gets only its own rows, as the real one does. */
const serverWith = (list: () => ReadonlyArray<BatonSessionSummary>) => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const direct = async (method: string, input: unknown) => {
    calls.push({ method, input });
    if (method !== "baton.sessions.across") return { delivered: true, detail: "" };
    const hereOnly = (input as { hereOnly?: boolean }).hereOnly === true;
    return {
      here: { environmentId: "here", label: "laptop" },
      sessions: list().filter((row) => !hereOnly || row.access === null),
      unreachable: hereOnly ? [] : [{ environmentId: "st", label: "Studio" }],
    };
  };
  return { calls, direct };
};

it("with T3's window closed, lists from this machine's server and types only into its own panes, never opening the window", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const server = serverWith(() => [
    summary("laptop", { access: null, pane: { environmentId: "here", pane: "s~1" } }),
    summary("box", { access: "full-access", pane: { environmentId: "box", pane: "s~2" } }),
    summary("shared", { access: "read-only", pane: { environmentId: "ro", pane: "s~3" } }),
  ]);
  const ensureMainWindow = vi.fn(() => Promise.reject(new Error("must not open")));
  const bridge = createSessionsBridge({
    ensureMainWindow,
    openMainWindow: () => undefined,
    onChange: () => undefined,
    mainWindowUp: async () => false,
    direct: server.direct,
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(bridge.rows().map((row) => row.key)).toEqual(["laptop", "box", "shared"]);
  expect(bridge.notes()).toEqual(["Studio isn't answering, so its sessions are not listed."]);

  expect(await bridge.act("n:laptop", "go on")).toBe("Sent.");
  expect(server.calls.at(-1)).toEqual({
    method: "baton.live.herdrSend",
    input: { pane: "s~1", text: "go on" },
  });
  expect(await bridge.act("n:box", "go on")).toContain("Open T3 to send to box");
  expect(await bridge.act("n:shared", "go on")).toContain("Open T3 to send to shared");
  expect(server.calls.filter((call) => call.method === "baton.live.herdrSend")).toHaveLength(1);
  expect(ensureMainWindow).not.toHaveBeenCalled();
  // This computer's rows are read again every 5 s, keeping the other computers' last reading.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(server.calls.at(-1)).toEqual({
    method: "baton.sessions.across",
    input: { hereOnly: true },
  });
  expect(bridge.rows().map((row) => row.key)).toEqual(["laptop", "box", "shared"]);
});

it("reads the row again just before typing, and types nothing at a question that came up since the list", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  let urgent = false;
  const server = serverWith(() => [
    summary("laptop", { access: null, urgent, pane: { environmentId: "here", pane: "s~1" } }),
  ]);
  const bridge = createSessionsBridge({
    ensureMainWindow: () => Promise.reject(new Error("must not open")),
    openMainWindow: () => undefined,
    onChange: () => undefined,
    mainWindowUp: async () => false,
    direct: server.direct,
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(bridge.rows()[0]?.urgent).toBe(false);
  urgent = true;
  expect(await bridge.act("n:laptop", "yes")).toContain("waiting on a question or an approval");
  expect(server.calls.some((call) => call.method === "baton.live.herdrSend")).toBe(false);
});

it("lists from this machine's server with T3's window up too, types into its own panes there, and another computer's through the window", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const sent: Array<unknown> = [];
  let answer: unknown = {
    here: { environmentId: "here", label: "laptop" },
    sessions: [
      summary("laptop", { access: null, pane: { environmentId: "here", pane: "s~1" } }),
      summary("box", { access: "full-access", pane: { environmentId: "box", pane: "s~2" } }),
    ],
    unreachable: [],
  };
  const window = {
    webContents: {
      send: (_channel: string, message: { id: number; request: unknown }) => {
        sent.push(message.request);
        ipc.get(BATON_SESSION_RESPONSE_CHANNEL)?.(null, {
          id: message.id,
          ok: true,
          detail: "Sent.",
        });
      },
    },
  };
  const calls: Array<string> = [];
  const bridge = createSessionsBridge({
    ensureMainWindow: async () => window as never,
    openMainWindow: () => undefined,
    onChange: () => undefined,
    mainWindowUp: async () => true,
    direct: async (method, input) => {
      calls.push(method);
      if (method === "baton.sessions.across") {
        if (answer === null) throw new Error("down");
        const listed = answer as { sessions: ReadonlyArray<BatonSessionSummary> };
        return (input as { hereOnly?: boolean }).hereOnly === true
          ? { ...listed, sessions: listed.sessions.filter((row) => row.access === null) }
          : listed;
      }
      return { delivered: true, detail: "" };
    },
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(bridge.rows().map((row) => row.key)).toEqual(["laptop", "box"]);

  expect(await bridge.act("n:laptop", "hi")).toBe("Sent.");
  expect(calls.at(-1)).toBe("baton.live.herdrSend");
  expect(await bridge.act("n:box", "hi")).toBe("Sent.");
  expect(sent).toEqual([{ kind: "send", environmentId: "box", pane: "s~2", text: "hi" }]);

  // A failed read keeps the last list and says it may be old.
  answer = null;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(bridge.rows().map((row) => row.key)).toEqual(["laptop", "box"]);
  expect(bridge.notes()).toEqual([
    "This computer's server did not answer, so these sessions may be out of date.",
  ]);
});

it("with T3's window closed, opening a thread still goes to the window, which it brings up", async () => {
  const sent: Array<unknown> = [];
  const window = {
    webContents: {
      send: (_channel: string, message: { id: number; request: unknown }) => {
        sent.push(message.request);
        ipc.get(BATON_SESSION_RESPONSE_CHANNEL)?.(null, {
          id: message.id,
          ok: true,
          detail: "Opened.",
        });
      },
    },
  };
  const bridge = createSessionsBridge({
    ensureMainWindow: async () => window as never,
    openMainWindow: () => undefined,
    onChange: () => undefined,
    mainWindowUp: async () => false,
    direct: () => Promise.reject(new Error("not for opening")),
  });
  const open = { kind: "open", environmentId: "env-box", threadId: "t1" } as const;
  expect(await bridge.request(open)).toEqual({ ok: true, detail: "Opened." });
  expect(sent).toEqual([open]);
});

it("asks a cold window to show live sessions again until its sidebar answers, and gives up after a few tries", async () => {
  const answers = [null, null, { ok: true, detail: "Showing live sessions." }];
  const request = vi.fn(async () => answers.shift() ?? null);
  expect(await showLiveWhenReady({ request })).toBe(true);
  expect(request).toHaveBeenCalledTimes(3);
  const never = vi.fn(async () => null);
  expect(await showLiveWhenReady({ request: never }, 4)).toBe(false);
  expect(never).toHaveBeenCalledTimes(4);
  expect(await showLiveWhenReady(undefined)).toBe(false);
});
