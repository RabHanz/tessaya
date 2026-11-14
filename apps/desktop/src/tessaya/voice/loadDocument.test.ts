import { describe, expect, it } from "vite-plus/test";

import { loadDocument } from "./loadDocument.ts";

describe("loadDocument", () => {
  it("resolves true when the page loads", async () => {
    const win = { loadURL: async () => {}, isDestroyed: () => false };
    expect(await loadDocument(win, "<p>hi</p>")).toBe(true);
  });

  it("turns an aborted load (ERR_FAILED on a closed window) into false, never a rejection", async () => {
    const seen: boolean[] = [];
    const win = {
      loadURL: () => Promise.reject(new Error("ERR_FAILED (-2) loading 'data:text/html,...'")),
      isDestroyed: () => true,
    };
    expect(await loadDocument(win, "x", (_cause, closed) => seen.push(closed))).toBe(false);
    expect(seen).toEqual([true]);
  });
});
