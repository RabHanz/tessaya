import { describe, expect, it } from "vite-plus/test";

import { exitFallback } from "./exitFallback.logic";

describe("his way out of the Sleeve", () => {
  it("falls back to a hold when his PIN cannot be checked, never on a wrong PIN", () => {
    const no = (line: string) => ({ ok: false, line });
    expect(exitFallback({ biometric: true, pin: null })).toBe(false);
    expect(exitFallback({ biometric: true, pin: no("That PIN is not right.") })).toBe(false);
    expect(
      exitFallback({
        biometric: true,
        pin: no("Set up your PIN first: choose it in Tessaya on your phone."),
      }),
    ).toBe(true);
    expect(exitFallback({ biometric: true, pin: no("Her brain can't be reached.") })).toBe(true);
    expect(exitFallback({ biometric: true, pin: no("PINs aren't kept on this server.") })).toBe(
      true,
    );
  });

  it("falls back at once on a phone with no Face ID or fingerprint", () => {
    expect(exitFallback({ biometric: false, pin: null })).toBe(true);
  });
});
