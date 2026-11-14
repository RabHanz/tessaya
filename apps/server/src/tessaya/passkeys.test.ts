import { describe, expect, it } from "vite-plus/test";

import { decodeCbor, verifyAssertion, verifyRegistration } from "./passkeys.ts";
import { authenticator, ORIGIN, RP } from "./testing/softPasskey.ts";

describe("passkeys, checked with Node's crypto", () => {
  it("registers a verified key and accepts its signature on the fresh challenge only", () => {
    for (const kind of ["ec", "ed25519"] as const) {
      const device = authenticator(kind);
      const key = verifyRegistration(device.create("reg-1"), {
        challenge: "reg-1",
        origin: ORIGIN,
        rpId: RP,
      });
      const expected = { challenge: "step-1", origin: ORIGIN, rpId: RP };
      const first = verifyAssertion(device.get("step-1"), expected, { ...key });
      expect(first.signCount).toBe(1);
      // An old challenge, another site, another origin, no user check, or a replayed counter: refused.
      expect(() => verifyAssertion(device.get("old"), expected, key)).toThrow(/old or different/);
      expect(() =>
        verifyAssertion(device.get("step-1", { rp: "evil.example" }), expected, key),
      ).toThrow(/different site/);
      expect(() =>
        verifyAssertion(device.get("step-1", { origin: "https://evil.example" }), expected, key),
      ).toThrow(/different site/);
      expect(() => verifyAssertion(device.get("step-1", { flags: 0x01 }), expected, key)).toThrow(
        /check it's you/,
      );
      expect(() =>
        verifyAssertion(device.get("step-1"), expected, { ...key, signCount: 99 }),
      ).toThrow(/copied/);
    }
  });

  it("refuses a signature from another key and a registration without a user check", () => {
    const mine = authenticator();
    const key = verifyRegistration(mine.create("r"), { challenge: "r", origin: ORIGIN, rpId: RP });
    const other = authenticator();
    expect(() =>
      verifyAssertion(other.get("s"), { challenge: "s", origin: ORIGIN, rpId: RP }, key),
    ).toThrow(/signature/);
    expect(() =>
      verifyRegistration(authenticator().create("r", 0x41), {
        challenge: "r",
        origin: ORIGIN,
        rpId: RP,
      }),
    ).toThrow(/check it's you/);
    expect(() => decodeCbor(Buffer.from([0x5f]))).toThrow();
  });
});
