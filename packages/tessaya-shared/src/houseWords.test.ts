import { describe, expect, it } from "vite-plus/test";

import { fixHouseNames } from "./houseWords.ts";

const HOUSE = ["Master Bedroom Fan", "Study Lamp", "Water Pump", "Kitchen Light"];

describe("fixHouseNames", () => {
  it("puts a misheard device right against the house's own names (20 Nov 09:28: the battle van)", () => {
    expect(fixHouseNames("Turn off the battle van.", HOUSE)).toBe("Turn off the bedroom fan.");
    expect(fixHouseNames("Can you set the bedroom van to forty percent?", HOUSE)).toBe(
      "Can you set the bedroom fan to forty percent?",
    );
  });

  it("leaves a name said right, a sentence that asks nothing, and two names that sound alike", () => {
    expect(fixHouseNames("Turn off the bedroom fan.", HOUSE)).toBe("Turn off the bedroom fan.");
    expect(fixHouseNames("That was a battle, man.", HOUSE)).toBe("That was a battle, man.");
    expect(fixHouseNames("Turn off the battle van.", [...HOUSE, "Guest Bathroom Fan"])).toBe(
      "Turn off the battle van.",
    );
    expect(fixHouseNames("Turn on the TV.", HOUSE)).toBe("Turn on the TV.");
  });
});
