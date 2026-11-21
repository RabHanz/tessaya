import { describe, expect, it } from "vite-plus/test";

import { isSleeve, withSleeve } from "./sleeveMode.logic";

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

  it("adds and takes out only this phone, and clears the preference when none is left", () => {
    expect(withSleeve("iPhone", phone, true)).toBe("iPhone, Hamza’s Xperia");
    expect(withSleeve("iPhone, SOG09", phone, false)).toBe("iPhone");
    expect(withSleeve("SOG09", phone, false)).toBeNull();
  });
});
