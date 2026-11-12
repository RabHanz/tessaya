import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";
import { trustRenderer } from "../baton/trustedRenderers.ts";

it.effect(
  "answers only the main window's top frame, and Tessaya's own windows' and inline pages'",
  () =>
    Effect.gen(function* () {
      const mainFrame = {};
      const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
      const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
      const ipc = yield* DesktopIpc.DesktopIpc.pipe(
        Effect.provide(
          DesktopIpc.layer({
            removeHandler: (channel) => void invoke.delete(channel),
            handle: (channel, listener) => void invoke.set(channel, listener),
            removeAllListeners: (channel) => void sync.delete(channel),
            on: (channel, listener) => void sync.set(channel, listener),
          }).pipe(
            Layer.provide(
              Layer.mock(ElectronWindow.ElectronWindow, {
                main: Effect.succeedSome({
                  webContents: { id: 1, mainFrame },
                } as unknown as Electron.BrowserWindow),
              }),
            ),
          ),
        ),
      );
      yield* ipc.handle(
        DesktopIpc.makeIpcMethod({
          channel: "token",
          payload: Schema.Void,
          result: Schema.String,
          handler: () => Effect.succeed("secret"),
        }),
      );
      yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

      // A detached thread window, and the T3 page Tessaya's window shows inline: both run T3's app.
      const renderer = (id: number) => {
        const frame = {};
        const destroyed: Array<() => void> = [];
        let gone = false;
        const contents = {
          id,
          mainFrame: frame,
          isDestroyed: () => gone,
          once: (_event: "destroyed", listener: () => void) => destroyed.push(listener),
          destroy: () => {
            gone = true;
            for (const listener of destroyed) listener();
          },
        };
        trustRenderer(contents);
        return contents;
      };
      const detached = renderer(3);
      const inline = renderer(4);
      const closed = renderer(5);
      closed.destroy();
      const senders = {
        app: { sender: { id: 1 }, senderFrame: mainFrame },
        detachedWindow: { sender: { id: 3 }, senderFrame: detached.mainFrame },
        tessayaInlinePage: { sender: { id: 4 }, senderFrame: inline.mainFrame },
        tessayaInlineSubframe: { sender: { id: 4 }, senderFrame: {} },
        closedWindow: { sender: { id: 5 }, senderFrame: closed.mainFrame },
        appSubframe: { sender: { id: 1 }, senderFrame: {} },
        previewGuest: { sender: { id: 2 }, senderFrame: {} },
      };
      const results: Record<string, unknown> = {};
      for (const [name, sender] of Object.entries(senders)) {
        const event = { ...sender, returnValue: "unset" as unknown };
        sync.get("token-sync")!(event);
        results[name] = [
          yield* Effect.promise(() =>
            Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
          ),
          event.returnValue,
        ];
      }
      assert.deepEqual(results, {
        app: ["secret", "secret"],
        detachedWindow: ["secret", "secret"],
        tessayaInlinePage: ["secret", "secret"],
        tessayaInlineSubframe: ["rejected", undefined],
        closedWindow: ["rejected", undefined],
        appSubframe: ["rejected", undefined],
        previewGuest: ["rejected", undefined],
      });
    }).pipe(Effect.scoped),
);
