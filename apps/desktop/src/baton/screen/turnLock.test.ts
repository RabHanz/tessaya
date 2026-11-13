import { describe, expect, it } from "vite-plus/test";

import { createTurnLock, deviceMayLook, headless, INTERRUPTED, labelPrompt } from "./turnLock.ts";

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** A device turn that runs until stopped or released; `started` resolves once it runs. */
const deviceTurn = (
  lock: ReturnType<typeof createTurnLock>,
  log: string[],
  name: string,
  /** Resolved before the turn names its stop, as a cold start does. */
  ready: Promise<void> = Promise.resolve(),
) => {
  const started = deferred();
  const released = deferred();
  const result = lock.device(async (onCancel) => {
    log.push(`${name} starts`);
    started.resolve();
    await ready;
    return await new Promise<string>((resolve, reject) => {
      onCancel(() => reject(new Error("closed")));
      void released.promise.then(() => resolve(`${name} answered`));
    });
  });
  return { result, started: started.promise, release: released.resolve };
};

describe("one turn at a time with a paired device", () => {
  it("his turn stops a running device turn, which reports it was interrupted", async () => {
    const lock = createTurnLock();
    const device = deviceTurn(lock, [], "device");
    await device.started;
    expect(lock.deviceRunning()).toBe(true);
    const end = await lock.his();
    expect(await device.result).toBe(INTERRUPTED);
    expect(lock.deviceRunning()).toBe(false);
    end();
  });

  it("a Stop ends a running device or standing-job turn without starting his", async () => {
    const lock = createTurnLock();
    lock.stopDevice();
    const device = deviceTurn(lock, [], "device");
    const queued = deviceTurn(lock, [], "queued");
    await device.started;
    lock.stopDevice();
    expect(await device.result).toBe(INTERRUPTED);
    // One waiting behind it never starts: Stop means nothing more from them now.
    expect(await queued.result).toBe(INTERRUPTED);
    expect(lock.deviceRunning()).toBe(false);
    const next = deviceTurn(lock, [], "next");
    next.release();
    expect(await next.result).toBe("next answered");
  });

  it("a cancel before the device turn names its stop still stops it", async () => {
    const lock = createTurnLock();
    const ready = deferred();
    const device = deviceTurn(lock, [], "device", ready.promise);
    await device.started;
    const his = lock.his();
    ready.resolve();
    expect(await device.result).toBe(INTERRUPTED);
    (await his)();
  });

  it("a device turn waits for his turn, and device turns wait for each other", async () => {
    const lock = createTurnLock();
    const log: string[] = [];
    const end = await lock.his();
    const first = deviceTurn(lock, log, "first");
    const second = deviceTurn(lock, log, "second");
    expect(log).toEqual([]);
    end();
    await first.started;
    expect(log).toEqual(["first starts"]);
    first.release();
    expect(await first.result).toBe("first answered");
    await second.started;
    expect(log).toEqual(["first starts", "second starts"]);
    second.release();
    expect(await second.result).toBe("second answered");
  });
});

describe("a confirm asked during a device's turn", () => {
  it("says it is the device's in the box and aloud, and his phone's only in the box", () => {
    const box = { title: "Use your mouse?", detail: "The pointer moves." };
    const device = labelPrompt(box, "Is that all right?", { device: true, phone: true });
    expect(device.box.detail).toContain("A paired device asked this, not you.");
    expect(device.spoken).toBe("A paired device asks. Is that all right?");
    const phone = labelPrompt(box, "Is that all right?", { device: false, phone: true });
    expect(phone.box.detail).toContain("You asked this from your phone.");
    expect(phone.spoken).toBe("Is that all right?");
    expect(labelPrompt(box, "x", { device: false, phone: false }).box).toBe(box);
    // The device he said it to, when it came through one (his R1 asking his laptop, 13 Nov).
    const r1 = labelPrompt(box, "Is that all right?", { device: true, phone: false, origin: "R1" });
    expect(r1.box.detail).toContain("(Requested from R1, not you.)");
    expect(r1.spoken).toBe("Requested from R1. Is that all right?");
  });
});

describe("a request from another device", () => {
  it("takes its one look without a prompt only on his yes: his verified voice there or his setting", () => {
    expect(deviceMayLook({ deviceRunning: true, mayLook: true })).toBe(true);
    expect(deviceMayLook({ deviceRunning: true, mayLook: false })).toBe(false);
    expect(deviceMayLook({ deviceRunning: false, mayLook: true })).toBe(false);
  });

  it("draws nothing on this screen while it runs, and draws again after (13 Nov: the R1's laptop ask)", async () => {
    const drew: Array<string> = [];
    const mark = (what: string) => async () => void drew.push(what);
    let away = true;
    const overlay = headless(
      {
        point: async () => (drew.push("point"), true),
        bubble: mark("bubble"),
        card: mark("card"),
        glide: async () => (drew.push("glide"), 1),
        clear: mark("clear"),
        retreat: mark("retreat"),
        timer: async () => undefined,
        hiddenFor: (fn) => fn(),
        dispose: () => undefined,
      },
      () => away,
    );
    await overlay.card(null);
    await overlay.bubble("hi");
    expect(await overlay.point({ x: 0, y: 0 }, null)).toBe(false);
    await overlay.glide({ x: 0, y: 0 }, "x");
    await overlay.clear();
    await overlay.retreat();
    expect(drew).toEqual([]);
    away = false;
    await overlay.card(null);
    expect(drew).toEqual(["card"]);
  });
});
