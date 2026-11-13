import { describe, expect, it, vi } from "vite-plus/test";

import {
  auditWhat,
  createHandleRegistry,
  createHandsBroker,
  HOST_LISTENING_MS,
  publishedSpecs,
} from "./remoteHands.ts";

const make = () => {
  let t = 0;
  let n = 0;
  const log: string[] = [];
  const broker = createHandsBroker({
    now: () => t,
    newId: () => `c${(n += 1)}`,
    callTimeoutMs: 1_000,
    onAudit: (e) => log.push(`${e.tool}:${e.outcome}`),
  });
  return { broker, log, advance: (ms: number) => void (t += ms) };
};

describe("remote hands broker", () => {
  it("passes a call to a waiting desktop at once and returns its answer", async () => {
    const { broker, log } = make();
    const taking = broker.take(50);
    const answer = broker.call("s1", "ui_tree", {});
    const call = (await taking)!;
    expect(call).toMatchObject({ tool: "ui_tree", session: "s1" });
    expect(broker.reply(call.id, { ok: true, text: "Notepad" })).toBe(true);
    expect(await answer).toEqual({ ok: true, text: "Notepad" });
    expect(log).toEqual(["ui_tree:done"]);
  });

  it("queues a call made before the desktop asks, and says so when nobody is listening", async () => {
    const { broker, advance } = make();
    expect((await broker.call("s", "ui_tree", {})).error).toContain("not listening");
    await broker.take(1);
    const queued = broker.call("s", "wait_for", { label: "OK", seconds: 1 });
    advance(HOST_LISTENING_MS - 1);
    const call = (await broker.take(1))!;
    expect(call.tool).toBe("wait_for");
    broker.reply(call.id, { ok: false, error: "no" });
    expect((await queued).ok).toBe(false);
  });

  it("never hands out a queued call after it timed out", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const { broker, log } = make();
    void broker.take(1);
    await vi.advanceTimersByTimeAsync(1);
    const late = broker.call("s", "type_text", { text: "x" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await late).error).toContain("did not answer");
    const taking = broker.take(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await taking).toBeNull();
    expect(log).toEqual(["type_text:timeout"]);
  });

  it("refuses a tool that is not a remote hands tool, an oversized call, and a reply to nothing", async () => {
    const { broker, log } = make();
    void broker.take(1);
    expect((await broker.call("s", "click", { x: 1, y: 2 })).error).toContain(
      "not a remote hands tool",
    );
    expect((await broker.call("s", "type_text", { text: "x".repeat(30_000) })).error).toContain(
      "too large",
    );
    expect(broker.reply("nope", { ok: true })).toBe(false);
    expect(log).toEqual(["click:refused", "type_text:refused"]);
  });

  it("gives a brain turn only the tools the desktop offers, with the turn named, and a remote session only the hands", async () => {
    const { broker, advance } = make();
    const screen = { name: "screen_capture", description: "d", input_schema: { type: "object" } };
    const origin = { label: "R1", hisVoice: true, member: "owner", assurance: 2, tainted: false };
    await broker.take(1, [screen]);
    expect(broker.published()).toEqual([screen]);
    expect((await broker.call("s", "screen_capture", {})).error).toContain(
      "not a remote hands tool",
    );
    expect((await broker.call("turn:R1", "ui_tree", {}, origin)).error).toContain("does not offer");
    const answer = broker.call("turn:R1", "screen_capture", {}, origin);
    const call = (await broker.take(1))!;
    expect(call).toMatchObject({ tool: "screen_capture", origin });
    broker.reply(call.id, { ok: true, text: "Notepad" });
    expect((await answer).text).toBe("Notepad");
    // A take without tools keeps the offer; a desktop that stopped listening offers nothing.
    expect(broker.published()).toEqual([screen]);
    advance(HOST_LISTENING_MS);
    expect(broker.published()).toEqual([]);
  });

  it("keeps only well-formed published tools", () => {
    expect(publishedSpecs("no")).toBeNull();
    expect(
      publishedSpecs([
        { name: "screen_capture", description: "d", input_schema: {} },
        { name: "Bad Name", description: "d", input_schema: {} },
        { name: "no_schema", description: "d" },
      ])?.map((s) => s.name),
    ).toEqual(["screen_capture"]);
  });

  it("keeps typed text out of the audit and stops only handles it issued", () => {
    expect(auditWhat("type_text", { text: "my password", why: "w" })).toBe(
      'type_text text(11 chars) why="w"',
    );
    const ids = createHandleRegistry<number>(() => "h1");
    const id = ids.add(4242);
    expect(ids.get(id)).toBe(4242);
    expect(ids.get("h2")).toBeUndefined();
  });
});
