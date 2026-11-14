import { describe, expect, it } from "vite-plus/test";

import { pairingAnswer } from "./r1Pairing.ts";

describe("pairing an R1 from the desktop", () => {
  it("passes on only the six digits he typed, or his yes, and cancels anything else", () => {
    expect(pairingAnswer("providePin", { confirmed: true, pin: "482913" })).toEqual({
      confirmed: true,
      pin: "482913",
    });
    expect(pairingAnswer("providePin", { confirmed: true, pin: "4829" })).toEqual({
      confirmed: false,
    });
    expect(pairingAnswer("providePin", { confirmed: true })).toEqual({ confirmed: false });
    expect(pairingAnswer("confirmPin", { confirmed: true })).toEqual({ confirmed: true });
    expect(pairingAnswer("confirmPin", { confirmed: false })).toEqual({ confirmed: false });
    expect(pairingAnswer("confirm", { confirmed: "yes" })).toEqual({ confirmed: false });
    // He never answered (the timeout's null).
    expect(pairingAnswer("providePin", null)).toEqual({ confirmed: false });
  });
});
