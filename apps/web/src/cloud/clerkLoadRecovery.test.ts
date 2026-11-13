import { describe, expect, it, vi } from "vite-plus/test";

import { recoverFailedClerkLoad, type ClerkStatusSource } from "./clerkLoadRecovery";

function setup(
  initialStatus: string,
  stored: Record<string, string> = {},
  senderRefused: () => Promise<boolean> = async () => false,
) {
  const listeners = new Set<(status: string) => void>();
  const clerk: ClerkStatusSource & { emit: (status: string) => void } = {
    status: initialStatus,
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    emit: (status) => listeners.forEach((listener) => listener(status)),
  };
  const values = new Map(Object.entries(stored));
  const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const scheduled: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const reload = vi.fn();
  const onSenderRefused = vi.fn();
  const stop = recoverFailedClerkLoad(clerk, {
    reload,
    senderRefused,
    onSenderRefused,
    getStorage: () => storage,
    schedule: (run, delayMs) => {
      const entry = { run, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  return { clerk, values, scheduled, reload, onSenderRefused, stop };
}

describe("recoverFailedClerkLoad", () => {
  it("reloads with backoff after a failed load and stops after three reloads", async () => {
    const first = setup("loading");
    first.clerk.emit("error");
    await vi.waitFor(() => expect(first.scheduled.map((entry) => entry.delayMs)).toEqual([15_000]));
    first.scheduled[0]!.run();
    expect(first.reload).toHaveBeenCalledOnce();
    expect(first.values.get("t3code:clerk-load-reloads")).toBe("1");

    const third = setup("error", { "t3code:clerk-load-reloads": "2" });
    await vi.waitFor(() => expect(third.scheduled[0]!.delayMs).toBe(60_000));
    const exhausted = setup("error", { "t3code:clerk-load-reloads": "3" });
    await Promise.resolve();
    expect(exhausted.scheduled).toEqual([]);
  });

  it("never reloads a renderer the desktop refuses Clerk's token store to, and says so once", async () => {
    const refused = setup("error", {}, async () => true);
    await vi.waitFor(() => expect(refused.onSenderRefused).toHaveBeenCalledOnce());
    refused.clerk.emit("error");
    await Promise.resolve();
    expect(refused.scheduled).toEqual([]);
    expect(refused.reload).not.toHaveBeenCalled();
    expect(refused.onSenderRefused).toHaveBeenCalledOnce();
  });

  it("leaves a loading or ready Clerk alone and forgets past reloads once ready", async () => {
    const pending = setup("error", { "t3code:clerk-load-reloads": "1" });
    await vi.waitFor(() => expect(pending.scheduled).toHaveLength(1));
    pending.clerk.emit("ready");
    expect(pending.scheduled[0]!.cancelled).toBe(true);
    expect(pending.values.has("t3code:clerk-load-reloads")).toBe(false);

    const loading = setup("loading");
    loading.clerk.emit("loading");
    expect(loading.scheduled).toEqual([]);
  });
});
