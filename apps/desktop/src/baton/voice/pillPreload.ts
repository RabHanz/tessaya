/**
 * The pill page's one bridge to the main process: it sends on its own `baton-pill:` channels, hears its bars on one, and has nothing else of
 * Electron or Node, so the page runs isolated and sandboxed.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pillIpc", {
  send: (channel: string, ...args: unknown[]) => {
    if (typeof channel === "string" && channel.startsWith("baton-pill:"))
      ipcRenderer.send(channel, ...args);
  },
  /** The waveform's bars, a byte a band (or one byte, a plain level), sent with each microphone frame. */
  onBands: (listener: (bars: Uint8Array) => void) => {
    ipcRenderer.on("baton-pill:bands", (_event, bars: Uint8Array) => listener(bars));
  },
});
