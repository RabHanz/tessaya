import { describe, expect, it } from "vite-plus/test";

import { calledName, isDismissal } from "./addressing.ts";

const NAMES = ["Tessaya", "Freya", "Alfred", "Sebastian"];

describe("whether he was talking to her", () => {
  it("hears her name the way the R1 wrote it on 12 Nov, and nothing in what was not for her", () => {
    const heard = (t: string) => calledName(t, NAMES);
    expect(heard("Seya, can you hear me?")).toBe("Tessaya");
    expect(heard("Casea, can you hear me?")).toBe("Tessaya");
    expect(heard("Say yeah.")).toBe("Tessaya");
    expect(heard("You say ya?")).toBe("Tessaya");
    expect(heard("Tessaya, turn off the lamp.")).toBe("Tessaya");
    expect(heard("Alfred, what broke?")).toBe("Alfred");
    expect(heard("Freya can you remind me at six")).toBe("Freya");
    for (const t of [
      "Did you hear me?",
      "This is a test of Tessa dictation.",
      "Testing without selecting an input box.",
      "I mean turn it back off.",
      "Tessa said she would call me later.",
    ])
      expect(heard(t)).toBeNull();
  });

  it("knows when he has sent her away", () => {
    expect(isDismissal("No, dismissed.")).toBe(true);
    expect(isDismissal("Okay, that will be all discussed.")).toBe(true);
    expect(isDismissal("Turn off the lamp.")).toBe(false);
  });
});
