import { describe, expect, it } from "vite-plus/test";

import { syncPeerUrl } from "./tessayaMemorySync";

describe("where a memory-sync credential may go", () => {
  it("keeps a relay's base path, and refuses plain http off this machine and the tailnet", () => {
    expect(syncPeerUrl("https://relay.example/env/abc", "/oauth/token")?.href).toBe(
      "https://relay.example/env/abc/oauth/token",
    );
    expect(syncPeerUrl("http://127.0.0.1:3773", "tessaya/desk/x")?.href).toBe(
      "http://127.0.0.1:3773/tessaya/desk/x",
    );
    // Built from octets: inside the tailnet block, then just outside it.
    const host = (...octets: number[]) => `http://${octets.join(".")}:3773`;
    expect(syncPeerUrl(host(100, 101, 2, 3), "x")).not.toBeNull();
    expect(syncPeerUrl(host(100, 200, 2, 3), "x")).toBeNull();
    expect(syncPeerUrl("http://192.168.1.4:3773", "x")).toBeNull();
  });
});
