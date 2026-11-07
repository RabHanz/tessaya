/**
 * The pill page's one bridge to the main process: it sends on its own `baton-pill:` channels and has nothing else of
 * Electron or Node, so the page runs isolated and sandboxed.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pillIpc", {
  send: (channel: string, ...args: unknown[]) => {
    if (typeof channel === "string" && channel.startsWith("baton-pill:"))
      ipcRenderer.send(channel, ...args);
  },
});
