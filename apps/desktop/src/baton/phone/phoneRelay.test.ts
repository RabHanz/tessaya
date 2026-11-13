import { describe, expect, it, vi } from "vite-plus/test";

import { createPhoneRelay, guardedPhoneCall, nextPollMs } from "./phoneRelay.ts";

const make = (
  over: {
    take?: unknown;
    run?: (
      text: string,
      source: "phone" | "device",
      origin: string | null,
      hisVoice: boolean,
    ) => Promise<{ spoken: string; card: string }>;
    poll?: Array<number | null>;
    every?: (ms: number, run: () => void) => () => void;
  } = {},
) => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const polls = [...(over.poll ?? [])];
  const relay = createPhoneRelay({
    call: async (op, args) => {
      calls.push([op, args]);
      if (op === "take") return over.take ?? null;
      if (op === "promptPoll") return polls.shift() ?? null;
      return true;
    },
    run: over.run ?? (async () => ({ spoken: "Two jobs.", card: "Two jobs are running." })),
    wait: async () => undefined,
    newId: () => "p1",
    ...(over.every === undefined ? {} : { every: over.every }),
  });
  return { relay, calls };
};

describe("the desktop's phone relay", () => {
  it("does nothing when nothing is waiting, and says away when the server does not answer", async () => {
    expect(await make().relay.tick()).toBe("idle");
    const down = createPhoneRelay({
      call: async () => Promise.reject(new Error("x")),
      run: async () => ({ spoken: "", card: "" }),
    });
    expect(await down.tick()).toBe("away");
  });

  it("runs a taken ask as a typed ask and sends back the reply and the card", async () => {
    const { relay, calls } = make({
      take: { id: "c-1", text: "what is running", source: "phone" },
    });
    expect(await relay.tick()).toBe("answered");
    expect(calls.at(-1)).toEqual([
      "answer",
      { id: "c-1", spoken: "Two jobs.", card: "Two jobs are running." },
    ]);
  });

  it("runs only the server's phone words as his; a device's or an unmarked ask is a device's", async () => {
    const sources: string[] = [];
    for (const source of ["phone", "device", undefined]) {
      const { relay } = make({
        take: { id: "c-3", text: "x", source },
        run: async (_text, from) => (sources.push(from), { spoken: "", card: "" }),
      });
      await relay.tick();
      await relay.settled();
    }
    expect(sources).toEqual(["phone", "device", "device"]);
  });

  it("passes on the device it came from and whether his verified voice said it (13 Nov)", async () => {
    const seen: Array<[string | null, boolean]> = [];
    for (const take of [
      { id: "c-4", text: "x", source: "device", origin: "R1", hisVoice: true },
      { id: "c-5", text: "x", source: "device", hisVoice: "yes" },
    ]) {
      const { relay } = make({
        take,
        run: async (_t, _s, origin, hisVoice) => (
          seen.push([origin, hisVoice]),
          { spoken: "", card: "" }
        ),
      });
      await relay.tick();
      await relay.settled();
    }
    expect(seen).toEqual([
      ["R1", true],
      [null, false],
    ]);
  });

  it("starts a device's ask without holding his next phone ask behind it, and renews its lease while it runs", async () => {
    const finishes: Array<() => void> = [];
    let renewTick = () => {};
    const { relay, calls } = make({
      take: { id: "d-1", text: "check every job", source: "device" },
      run: () =>
        new Promise(
          (resolve) => void finishes.push(() => resolve({ spoken: "Done.", card: "Done." })),
        ),
      every: (_ms, run) => ((renewTick = run), () => (renewTick = () => {})),
    });
    expect(await relay.tick()).toBe("started");
    // The relay is free for the next ask while the device's runs.
    expect(await relay.tick()).toBe("started");
    renewTick();
    expect(calls.some(([op, args]) => op === "renew" && args["id"] === "d-1")).toBe(true);
    // At most three held at once: the fourth waits on the server.
    expect(await relay.tick()).toBe("started");
    expect(await relay.tick()).toBe("busy");
    for (const finish of finishes) finish();
    await relay.settled();
    expect(calls.some(([op]) => op === "answer")).toBe(true);
  });

  it("reports a failed turn instead of leaving the ask hanging", async () => {
    const { relay, calls } = make({
      take: { id: "c-2", text: "x", source: "phone" },
      run: async () => Promise.reject(new Error("boom")),
    });
    expect(await relay.tick()).toBe("failed");
    expect(calls.at(-1)?.[0]).toBe("fail");
  });

  it("mirrors a question and resolves with the phone's button; closing tells the server", async () => {
    const { relay, calls } = make({ poll: [null, 1] });
    const mirrored = relay.mirror({
      title: "Run it?",
      detail: "Click Save",
      buttons: ["Go ahead", "Not now"],
      yes: 0,
      cancel: 1,
    });
    expect(await mirrored!.answer).toBe(1);
    expect(calls[0]).toEqual([
      "prompt",
      {
        id: "p1",
        title: "Run it?",
        detail: "Click Save",
        buttons: ["Go ahead", "Not now"],
        yes: 0,
        cancel: 1,
      },
    ]);
    mirrored!.close();
    expect(calls.at(-1)).toEqual(["promptClose", { id: "p1" }]);
  });

  it("polls often while active and backs off when nothing happens, but never past the server's connected window", () => {
    expect([0, 11, 12, 59, 60, 5_000].map((n) => nextPollMs(n))).toEqual([
      5_000, 5_000, 15_000, 15_000, 30_000, 30_000,
    ]);
    expect(Math.max(...[0, 12, 60].map((n) => nextPollMs(n)))).toBeLessThan(45_000);
    // A server that held the take open for the next ask: look again at once, however quiet it has been.
    expect(nextPollMs(60, 10_000)).toBe(0);
    expect(nextPollMs(60, 200)).toBe(30_000);
  });
});

describe("the relay's call into the app", () => {
  const marks: string[] = [];
  const mark = (name: string) => void marks.push(name);
  it("does not ask while the app's window is closed, and marks the call", async () => {
    marks.length = 0;
    let asked = false;
    const call = guardedPhoneCall({
      windowUp: async () => false,
      request: async () => {
        asked = true;
        return null;
      },
      mark,
    });
    await expect(call("take", {})).rejects.toThrow(/not open/);
    expect(asked).toBe(false);
    expect(marks).toEqual(["phone-call:begin", "phone-call:end"]);
  });
  it("gives up on an app that never answers, so the loop goes on", async () => {
    vi.useFakeTimers();
    const call = guardedPhoneCall({
      windowUp: async () => true,
      request: () => new Promise(() => undefined),
      mark,
      timeoutMs: 1_000,
    });
    const result = call("take", {});
    const checked = expect(result).rejects.toThrow(/in time/);
    await vi.advanceTimersByTimeAsync(1_000);
    await checked;
    vi.useRealTimers();
  });
  it("turns a synchronous throw into a rejection instead of breaking the loop", async () => {
    const call = guardedPhoneCall({
      windowUp: () => {
        throw new Error("boom");
      },
      request: async () => null,
      mark,
    });
    await expect(call("take", {})).rejects.toThrow("boom");
  });
});
