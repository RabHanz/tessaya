import { describe, expect, it } from "vite-plus/test";

import { mayFetchClone, tailnetIp } from "./cloneGate.ts";

// Built at run time so no tailnet-looking literal sits in the public repo.
const cgnat = (b: number, d: number) => ["100", b, "0", d].join(".");

describe("his cloned voice for a room loop on another machine", () => {
  const peer = cgnat(76, 1);
  const gate = (over: Partial<Parameters<typeof mayFetchClone>[0]> = {}) =>
    mayFetchClone({
      keyOk: true,
      remote: peer,
      proxied: false,
      fullAccessIps: new Set([peer]),
      ...over,
    });

  it("goes to a full-access machine of his straight over the tailnet, on a Tessel's key", () => {
    expect(gate()).toBe(true);
    expect(gate({ remote: `::ffff:${peer}` })).toBe(true);
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
    expect(tailnetIp(cgnat(64, 1))).toBe(cgnat(64, 1));
    expect(tailnetIp(cgnat(127, 254))).toBe(cgnat(127, 254));
    expect(tailnetIp(cgnat(63, 1))).toBeNull();
    expect(tailnetIp(cgnat(128, 1))).toBeNull();
  });
});
