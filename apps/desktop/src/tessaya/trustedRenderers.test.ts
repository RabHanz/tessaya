import { expect, it, vi } from "vite-plus/test";

const handlers = vi.hoisted(() => new Map<string, (event: unknown, key: string) => unknown>());
vi.mock("electron", () => ({
  app: {},
  protocol: {},
  shell: {},
  BrowserWindow: {},
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, key: string) => unknown) =>
      handlers.set(channel, listener),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

import { createClerkBridge } from "@clerk/electron";
import { admitTrustedGuestsToClerk, trustRenderer } from "./trustedRenderers.ts";

it("lets Clerk's token store answer the inline T3 page's top frame, and no other guest", () => {
  const bridge = createClerkBridge({
    storage: { getItem: () => "token", setItem: () => {}, removeItem: () => {} },
  });
  admitTrustedGuestsToClerk();
  const contents = (id: number, type: "window" | "webview") => {
    const mainFrame = {};
    return {
      id,
      mainFrame,
      getType: () => type,
      isDestroyed: () => false,
      once: () => undefined,
    };
  };
  const getToken = [...handlers].find(([channel]) => channel.includes("get"))![1];
  const ask = (sender: ReturnType<typeof contents>, senderFrame: unknown = sender.mainFrame) =>
    getToken({ sender, senderFrame }, "key");

  const guest = contents(2, "webview");
  trustRenderer(guest);
  expect(ask(contents(1, "window"))).toBe("token");
  expect(ask(guest)).toBe("token");
  expect(() => ask(guest, {})).toThrow("main frame");
  expect(() => ask(contents(3, "webview"))).toThrow("main frame");
  bridge.cleanup();
});
