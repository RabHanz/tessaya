/**
 * Baton's renderer bridge, exposed as its own `window.batonDesktopBridge` so upstream's
 * `desktopBridge` object stays upstream's. Called once from `preload.ts`
 * (`vendor-patches/t3code/0007-desktop.patch`); read through `batonDesktopBridge()`.
 */
import type { BatonDesktopBridge } from "@t3tools/tessaya-contracts";
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
    onR1BlePairing: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, message: unknown) => {
        const { id, kind, pin } = (message ?? {}) as {
          id?: unknown;
          kind?: unknown;
          pin?: unknown;
        };
        if (
          typeof id !== "number" ||
          (kind !== "providePin" && kind !== "confirmPin" && kind !== "confirm")
        )
          return;
        void handler({ kind, ...(typeof pin === "string" ? { pin } : {}) }).then(
          (answer) => ipcRenderer.send(Channels.R1_BLE_PAIRING_RESPONSE_CHANNEL, { id, ...answer }),
          () =>
            ipcRenderer.send(Channels.R1_BLE_PAIRING_RESPONSE_CHANNEL, { id, confirmed: false }),
        );
      };
      ipcRenderer.on(Channels.R1_BLE_PAIRING_REQUEST_CHANNEL, listener);
      return () => ipcRenderer.removeListener(Channels.R1_BLE_PAIRING_REQUEST_CHANNEL, listener);
    },
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
    onComposerDictation: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, message: unknown) => {
        const reply = handler(message as Parameters<typeof handler>[0]);
        if (reply !== null)
          ipcRenderer.send(Channels.BATON_COMPOSER_DICTATION_REPLY_CHANNEL, reply);
      };
      ipcRenderer.on(Channels.BATON_COMPOSER_DICTATION_CHANNEL, listener);
      return () => ipcRenderer.removeListener(Channels.BATON_COMPOSER_DICTATION_CHANNEL, listener);
    },
    setComposerFocus: (focused) => ipcRenderer.send(Channels.BATON_COMPOSER_FOCUS_CHANNEL, focused),
    replyComposerDictation: (reply) =>
      ipcRenderer.send(Channels.BATON_COMPOSER_DICTATION_REPLY_CHANNEL, reply),
    openTessaya: (link) => ipcRenderer.send(Channels.BATON_OPEN_TESSAYA_CHANNEL, link ?? ""),
    r1flash: async (request, onEvent) => {
      const listener = (_event: Electron.IpcRendererEvent, message: unknown) => {
        if (typeof message === "object" && message !== null)
          onEvent(message as Record<string, unknown>);
      };
      // One cable job at a time, so every event while this call runs is this job's.
      ipcRenderer.on(Channels.R1FLASH_EVENT_CHANNEL, listener);
      try {
        return await ipcRenderer.invoke(Channels.R1FLASH_RUN_CHANNEL, request);
      } finally {
        ipcRenderer.removeListener(Channels.R1FLASH_EVENT_CHANNEL, listener);
      }
    },
    r1flashInput: (line) => ipcRenderer.send(Channels.R1FLASH_INPUT_CHANNEL, line),
    r1flashStop: () => ipcRenderer.send(Channels.R1FLASH_STOP_CHANNEL),
  };
  contextBridge.exposeInMainWorld("batonDesktopBridge", bridge);
}
