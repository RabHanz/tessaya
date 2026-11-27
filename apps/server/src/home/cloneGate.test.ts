import { describe, expect, it } from "vite-plus/test";

import { mayFetchClone, tailnetIp } from "./cloneGate.ts";

describe("his cloned voice for a room loop on another machine", () => {
  const onnyx = "100.76.212.51";
  const gate = (over: Partial<Parameters<typeof mayFetchClone>[0]> = {}) =>
    mayFetchClone({
      keyOk: true,
      remote: onnyx,
      proxied: false,
      fullAccessIps: new Set([onnyx]),
      ...over,
    });

  it("goes to a full-access machine of his straight over the tailnet, on a Tessel's key", () => {
    expect(gate()).toBe(true);
    expect(gate({ remote: `::ffff:${onnyx}` })).toBe(true);
  });

  it.each([
    ["a wrong device key", { keyOk: false }],
    ["a machine linked without full access", { fullAccessIps: new Set<string>() }],
    ["a request through a proxy or the tunnel", { proxied: true }],
    [
      "an address off the tailnet (the LAN)",
      { remote: "192.168.10.227", fullAccessIps: new Set(["192.168.10.227"]) },
    ],
    [
      "loopback, which has its own route",
      { remote: "127.0.0.1", fullAccessIps: new Set(["127.0.0.1"]) },
    ],
  ] as const)("is refused for %s", (_, over) => {
    expect(gate(over)).toBe(false);
  });

  it("knows the tailnet's range", () => {
    expect(tailnetIp("100.64.0.1")).toBe("100.64.0.1");
    expect(tailnetIp("100.127.255.254")).toBe("100.127.255.254");
    expect(tailnetIp("100.63.0.1")).toBeNull();
    expect(tailnetIp("100.128.0.1")).toBeNull();
  });
});
