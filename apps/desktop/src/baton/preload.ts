/**
 * Baton's renderer bridge, exposed as its own `window.batonDesktopBridge` so upstream's
 * `desktopBridge` object stays upstream's. Called once from `preload.ts`
 * (`vendor-patches/t3code/0007-desktop.patch`); read through `batonDesktopBridge()`.
 */
import type { BatonDesktopBridge } from "@t3tools/baton-contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as Channels from "./channels.ts";

export function exposeBatonDesktopBridge(): void {
  const bridge: BatonDesktopBridge = {
    getBatonInjectionReport: (request) =>
      ipcRenderer.invoke(Channels.BATON_INJECTION_REPORT_CHANNEL, request),
    onBatonVoiceRequest: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, message: unknown) => {
        if (typeof message !== "object" || message === null) return;
        const { id, request } = message as { id?: unknown; request?: unknown };
        if (typeof id !== "number" || typeof request !== "object" || request === null) return;
        void Promise.resolve()
          .then(() => handler(request as Parameters<typeof handler>[0]))
          .then(
            (value) =>
              ipcRenderer.send(Channels.BATON_VOICE_RESPONSE_CHANNEL, { id, ok: true, value }),
            (error: unknown) =>
              ipcRenderer.send(Channels.BATON_VOICE_RESPONSE_CHANNEL, {
                id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
      };
      ipcRenderer.on(Channels.BATON_VOICE_REQUEST_CHANNEL, listener);
      return () => ipcRenderer.removeListener(Channels.BATON_VOICE_REQUEST_CHANNEL, listener);
    },
    setBatonUsage: (usage) => ipcRenderer.send(Channels.BATON_USAGE_CHANNEL, usage),
    onBatonSessionRequest: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, message: unknown) => {
        if (typeof message !== "object" || message === null) return;
        const { id, request } = message as { id?: unknown; request?: unknown };
        if (typeof id !== "number" || typeof request !== "object" || request === null) return;
        void Promise.resolve()
          .then(() => handler(request as Parameters<typeof handler>[0]))
          .then(
            (result) =>
              ipcRenderer.send(Channels.BATON_SESSION_RESPONSE_CHANNEL, { id, ...result }),
            (error: unknown) =>
              ipcRenderer.send(Channels.BATON_SESSION_RESPONSE_CHANNEL, {
                id,
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
              }),
          );
      };
      ipcRenderer.on(Channels.BATON_SESSION_REQUEST_CHANNEL, listener);
      return () => ipcRenderer.removeListener(Channels.BATON_SESSION_REQUEST_CHANNEL, listener);
    },
    setBatonVoiceFocus: (workSessionId) =>
      ipcRenderer.send(Channels.BATON_VOICE_FOCUS_CHANNEL, workSessionId),
    composerMic: () => ipcRenderer.invoke(Channels.BATON_COMPOSER_MIC_CHANNEL),
  };
  contextBridge.exposeInMainWorld("batonDesktopBridge", bridge);
}
