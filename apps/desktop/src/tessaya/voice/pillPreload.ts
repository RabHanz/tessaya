/**
 * The pill page's one bridge to the main process: it sends on its own `baton-pill:` channels, hears its level on one, and has nothing else of
 * Electron or Node, so the page runs isolated and sandboxed.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pillIpc", {
  send: (channel: string, ...args: unknown[]) => {
    if (typeof channel === "string" && channel.startsWith("baton-pill:"))
      ipcRenderer.send(channel, ...args);
  },
  /** The waveform's level in dBFS, sent with each microphone frame (or each step of Tessaya's own voice). */
  onLevel: (listener: (db: number) => void) => {
    ipcRenderer.on("baton-pill:level", (_event, db: number) => listener(db));
  },
});
