import { describe, expect, it } from "vite-plus/test";

import {
  languageCode,
  languagesFromSaved,
  outsideLanguages,
  PARAKEET_V3_LANGUAGES,
  recogniserHint,
} from "./dictationLanguages.ts";

describe("dictation languages", () => {
  it("lists the 25 languages of the multilingual model; the fast one takes English only", () => {
    expect(PARAKEET_V3_LANGUAGES).toHaveLength(25);
    expect(languageCode("v3", "Portuguese")).toBe("pt");
    expect(languageCode("v3", "de")).toBe("de");
    expect(languageCode("v3", "Chinese")).toBeUndefined();
    expect(languageCode("fast", "German")).toBeUndefined();
    expect(languageCode("fast", "english")).toBe("en");
  });

  it("carries a saved single language over: English stays English only, detect stays any", () => {
    expect(languagesFromSaved({})).toEqual(["en"]);
    expect(languagesFromSaved({ language: "en" })).toEqual(["en"]);
    expect(languagesFromSaved({ language: null })).toEqual([]);
    expect(languagesFromSaved({ languages: ["en", "fr", "zh", "en"] })).toEqual(["en", "fr"]);
    expect(recogniserHint(["en"])).toBe("en");
    expect(recogniserHint(["en", "fr"])).toBeNull();
    expect(recogniserHint([])).toBeNull();
  });

  it("sets aside what is heard outside his languages, and only that", () => {
    // What English in a British accent came back as on the multilingual model.
    expect(outsideLanguages("Deixa eu tentar.", ["en"])).toBe("pt");
    expect(outsideLanguages("Ik weet.", ["en"])).toBe("nl");
    expect(outsideLanguages("Det säger.", ["en"])).toBe("sv");
    expect(outsideLanguages("Привет, как дела", ["en"])).toBe("ru");
    for (const english of [
      "To say yeah.",
      "Dictate.",
      "Hello.",
      "Is it ok?",
      "Meet me at the café.",
      // Two-word English that shares a word with another language.
      "Call Meg.",
      "Open vi.",
      "Sim card.",
      "Las Vegas",
      "Non profit",
      "Med school",
      "Co founder",
      "Yo, nu metal",
    ])
      expect([english, outsideLanguages(english, ["en"])]).toEqual([english, null]);
    expect(outsideLanguages("Ich weiß nicht.", ["en", "de"])).toBeNull();
    expect(outsideLanguages("Deixa eu tentar.", [])).toBeNull();
  });
});
