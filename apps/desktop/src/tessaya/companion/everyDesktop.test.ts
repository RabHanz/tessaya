import { describe, expect, it } from "vite-plus/test";

import { type ExStyleApi, onEveryDesktop } from "./everyDesktop.ts";

const fakeWindow = (visible: boolean) => {
  const log: Array<string> = [];
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x1234n);
  return {
    log,
    win: {
      getNativeWindowHandle: () => handle,
      isDestroyed: () => false,
      isVisible: () => visible,
      hide: () => void log.push("hide"),
      showInactive: () => void log.push("show"),
      setVisibleOnAllWorkspaces: (on: boolean) => void log.push(`workspaces:${on}`),
    },
  };
};

const styles = (start: bigint) => {
  let style = start;
  const seen: Array<bigint> = [];
  const api: ExStyleApi = {
    get: (hwnd) => (seen.push(hwnd), style),
    set: (_hwnd, next) => void (style = next),
  };
  return { api, seen, style: () => style };
};

describe("her windows on every virtual desktop", () => {
  it("on Windows adds the tool-window style to her own window, keeping its other styles, while hidden", async () => {
    const { win, log } = fakeWindow(true);
    const s = styles(0x08000008n);
    await onEveryDesktop(win, async () => s.api);
    expect(s.seen).toEqual([0x1234n]);
    expect(s.style()).toBe(0x08000088n);
    // the shell reads the style as a window shows, so a window already up is shown again under it
    expect(log).toEqual(["workspaces:true", "hide", "show"]);
    // once set, it is left alone
    await onEveryDesktop(win, async () => s.api);
    expect(log).toEqual(["workspaces:true", "hide", "show", "workspaces:true"]);
  });

  it("on Windows sets a hidden window without showing it", async () => {
    const { win, log } = fakeWindow(false);
    const s = styles(0n);
    await onEveryDesktop(win, async () => s.api);
    expect([s.style(), log]).toEqual([0x80n, ["workspaces:true"]]);
  });

  it("elsewhere (no user32 to load) takes only the workspaces setting", async () => {
    const { win, log } = fakeWindow(true);
    await onEveryDesktop(win, () => Promise.reject(new Error("no user32.dll")));
    expect(log).toEqual(["workspaces:true"]);
  });
});
