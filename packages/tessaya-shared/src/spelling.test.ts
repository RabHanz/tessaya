import { describe, expect, it } from "vite-plus/test";

import { foldSpelling, spelledRuns, spellOut } from "./spelling.ts";

describe("names spelled out loud, as the recogniser writes them", () => {
  it.each([
    ["Z-A-Y-D", "Zayd"],
    ["z a y d", "Zayd"],
    ["Z. A. Y. D.", "Zayd"],
    ["zed ay why dee", "Zayd"],
    ["Z, A, Y, D", "Zayd"],
    ["R. A. B.", "Rab"],
    ["double u i el el", "Will"],
    ["double-u a ell ess h", "Walsh"],
    ["b o double b y", "Bobby"],
    ["Q-A-D-R-I", "Qadri"],
  ])("%s is %s", (heard, word) => {
    expect(spelledRuns(heard).map((r) => r.word)).toEqual([word]);
  });

  it("leaves ordinary words and short letter pairs alone", () => {
    for (const plain of [
      "Can you see the sea",
      "I am a teacher",
      "Turn on the AC",
      "It is in the US",
      "Oh, why are you here",
    ])
      expect(spelledRuns(plain)).toEqual([]);
  });

  it("folds a spelling into the word it spells, and keeps how it was heard when that differs", () => {
    expect(foldSpelling("Call me Zaid, Z-A-Y-D, from now on")).toEqual({
      text: "Call me Zayd, from now on",
      names: [{ word: "Zayd", heardAs: "Zaid" }],
    });
    expect(foldSpelling("My dentist is Dr Qadri, Q-A-D-R-I")).toEqual({
      text: "My dentist is Dr Qadri",
      names: [{ word: "Qadri", heardAs: null }],
    });
    expect(foldSpelling("Just call me R. A. B.")).toEqual({
      text: "Just call me Rab",
      names: [{ word: "Rab", heardAs: null }],
    });
    expect(foldSpelling("Call me Zaid, spelled z a y d")).toMatchObject({
      text: "Call me Zayd",
      names: [{ word: "Zayd", heardAs: "Zaid" }],
    });
    expect(foldSpelling("Nothing spelled here")).toEqual({
      text: "Nothing spelled here",
      names: [],
    });
  });

  it("spells a word back the way she says it", () => {
    expect(spellOut("Zayd")).toBe("Z-A-Y-D");
  });
});
