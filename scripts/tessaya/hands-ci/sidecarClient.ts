// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// A long-lived UI Automation sidecar, spoken to as the app speaks to it (JSON lines with an id).
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

export const startSidecar = (exe: string) => {
  const proc = NodeChildProcess.spawn(exe, ["serve"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  NodeReadline.createInterface({ input: proc.stdout }).on("line", (line) => {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (typeof e["id"] === "number") waiting.get(e["id"])?.(e);
    } catch {
      // other events
    }
  });
  let nextId = 0;
  const call = <T>(message: Record<string, unknown>): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1);
      const timer = setTimeout(
        () => reject(new Error(`sidecar silent for ${JSON.stringify(message).slice(0, 80)}`)),
        20_000,
      );
      waiting.set(id, (v) => (clearTimeout(timer), waiting.delete(id), resolve(v as T)));
      proc.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    });
  return {
    call,
    kill: () => void proc.kill(),
    sidecar: {
      locate: (i: Record<string, unknown>) => call<never>({ cmd: "locate", ...i }),
      uiTree: (window?: string) =>
        call<never>({ cmd: "ui_tree", ...(window === undefined ? {} : { window }) }),
      setValue: (window: string, text: string) => call<never>({ cmd: "set_value", window, text }),
      captureWindow: (i: Record<string, unknown>) => call<never>({ cmd: "capture_window", ...i }),
      focusState: (window?: string) =>
        call<never>({ cmd: "focus_state", ...(window === undefined ? {} : { window }) }),
    },
  };
};

export const ps = (script: string): string =>
  NodeChildProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  ).trim();
