/**
 * The mascot page's one bridge to the main process: it sends on its own `baton-mascot:` channels and hears her voice's
 * level on one, and has nothing else of Electron or Node, so the page runs isolated and sandboxed.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mascotIpc", {
  send: (channel: string, ...args: unknown[]) => {
    if (typeof channel === "string" && channel.startsWith("baton-mascot:"))
      ipcRenderer.send(channel, ...args);
  },
  onLevel: (listener: (level: number) => void) => {
    ipcRenderer.on("baton-mascot:level", (_event, level: number) => listener(level));
  },
});
