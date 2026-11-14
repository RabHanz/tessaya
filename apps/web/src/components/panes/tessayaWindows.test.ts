import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { detachedWindowUrl, isMainWindow } from "./tessayaWindows";

const target = {
  kind: "server" as const,
  threadRef: scopeThreadRef(EnvironmentId.make("box"), ThreadId.make("a/b")),
};

describe("detachedWindowUrl", () => {
  const location = { protocol: "http:", host: "localhost:3773", pathname: "/" };

  it("uses the path on the web and the hash on the desktop app", () => {
    expect(detachedWindowUrl(target, "w1", location, false)).toBe(
      "http://localhost:3773/box/a%2Fb?batonWindow=w1",
    );
    expect(detachedWindowUrl(target, "w1", location, true)).toBe(
      "http://localhost:3773/?batonWindow=w1#/box/a%2Fb",
    );
  });
});

describe("isMainWindow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true for the main window, so its snapshot coordinator mounts", () => {
    vi.stubGlobal("window", { location: { search: "" }, name: "" });
    expect(isMainWindow()).toBe(true);
  });

  it("is false for a detached window, which must never ask for pending snapshots", () => {
    vi.stubGlobal("window", { location: { search: "?batonWindow=w1" }, name: "" });
    expect(isMainWindow()).toBe(false);
  });

  it("stays false after a detached window navigates away from the parameter", () => {
    vi.stubGlobal("window", { location: { search: "" }, name: "baton-window-w1" });
    expect(isMainWindow()).toBe(false);
  });
});
