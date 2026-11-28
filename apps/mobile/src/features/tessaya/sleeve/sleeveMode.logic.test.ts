import { describe, expect, it } from "vite-plus/test";

import { isSleeve, restOf, sleeveCovers, withSleeve } from "./sleeveMode.logic";

const phone = { id: "phone-xperia5iv", names: ["Hamza’s Xperia", "SOG09"] };

describe("Sleeve mode", () => {
  it("is on for this phone when the preference names it by id, name or model, whatever the case", () => {
    expect(isSleeve("hamza's xperia", phone)).toBe(true);
    expect(isSleeve("iPhone, sog09", phone)).toBe(true);
    expect(isSleeve("phone-xperia5iv", phone)).toBe(true);
    expect(isSleeve("iPhone", phone)).toBe(false);
    expect(isSleeve("off", phone)).toBe(false);
    expect(isSleeve(undefined, phone)).toBe(false);
  });

  it("lets him out at once when he gives it back, even while her brain still names it, until her value changes", () => {
    expect(sleeveCovers("SOG09", phone, null)).toBe(true);
    // given back from "SOG09": her brain unreached or refusing, the phone is his again here
    expect(sleeveCovers("SOG09", phone, "SOG09")).toBe(false);
    // he made it her Sleeve again (a new value): it covers once more
    expect(sleeveCovers("iPhone, SOG09", phone, "SOG09")).toBe(true);
  });

  it("adds and takes out only this phone, and clears the preference when none is left", () => {
    expect(withSleeve("iPhone", phone, true)).toBe("iPhone, Hamza’s Xperia");
    expect(withSleeve("iPhone, SOG09", phone, false)).toBe("iPhone");
    expect(withSleeve("SOG09", phone, false)).toBeNull();
  });
});

describe("Sleeve power", () => {
  it("rests as her dock by day and dark in his quiet hours, across midnight", () => {
    expect(restOf("22-8", 14)).toBe("dock");
    expect(restOf("22-8", 23)).toBe("night");
    expect(restOf("22-8", 3)).toBe("night");
    expect(restOf("none", 3)).toBe("dock");
  });
});
