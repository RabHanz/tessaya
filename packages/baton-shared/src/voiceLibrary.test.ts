import { describe, expect, it } from "vite-plus/test";

import { mergePack } from "./osPack.ts";
import { commercialBuild, resolvePersonaVoice, voiceLibrary } from "./voiceLibrary.ts";

describe("the voice library", () => {
  it("lists every Pocket voice, with the non-commercial and unlicensed ones marked personal use", () => {
    const all = voiceLibrary("pocket", { commercial: false });
    expect(all).toHaveLength(27);
    expect(
      all
        .filter((v) => v.personalUse)
        .map((v) => v.id)
        .toSorted(),
    ).toEqual(["alba", "cosette", "daan", "jean", "juergen", "rafael"]);
    expect(all.find((v) => v.id === "cosette")).toMatchObject({
      licence: "cc-by-nc-4.0",
      gender: "female",
    });
    expect(all.find((v) => v.id === "bill_boerst")).toMatchObject({
      name: "Bill Boerst",
      licence: "cc0",
      personalUse: false,
    });
  });

  it("leaves personal-use voices out of a commercial build", () => {
    expect(commercialBuild({ TESSAYA_COMMERCIAL_BUILD: "1" })).toBe(true);
    expect(commercialBuild({})).toBe(false);
    const sold = voiceLibrary("pocket", { commercial: true });
    expect(sold).toHaveLength(21);
    expect(sold.some((v) => v.personalUse)).toBe(false);
  });

  it("offers the Gemini en-GB library with accents", () => {
    const cloud = voiceLibrary("gemini", { commercial: true });
    expect(cloud).toHaveLength(116);
    expect(cloud.find((v) => v.id === "en-gb-assistant-1")).toMatchObject({
      accent: "Winchester",
      licence: "google",
    });
  });
});

describe("what a persona speaks in", () => {
  const on = { cloud: true, commercial: false };
  it("takes its Pocket voice, and its cloud voice only while cloud voices are on", () => {
    expect(resolvePersonaVoice({ voice: "Jane", cloudVoice: "en-gb-assistant-1" }, on)).toEqual({
      pocket: "jane",
      cloud: "en-gb-assistant-1",
    });
    expect(
      resolvePersonaVoice(
        { voice: "jane", cloudVoice: "en-gb-assistant-1" },
        { ...on, cloud: false },
      ),
    ).toEqual({ pocket: "jane", cloud: null });
  });

  it("falls back to the default for a voice the library does not have or a commercial build hides", () => {
    expect(resolvePersonaVoice({ voice: "nobody", cloudVoice: "nobody" }, on)).toEqual({
      pocket: "eve",
      cloud: null,
    });
    expect(resolvePersonaVoice({ voice: "cosette" }, on).pocket).toBe("cosette");
    expect(resolvePersonaVoice({ voice: "cosette" }, { ...on, commercial: true }).pocket).toBe(
      "eve",
    );
  });

  it("reads each persona's voices from the pack, his file over the default", () => {
    const pack = mergePack({
      roles: { companion: "---\nvoice: jane\ncloud voice: en-gb-assistant-12\n---\n" },
    });
    const voices = Object.fromEntries(
      pack.personas.map((p) => [p.name, resolvePersonaVoice(p, on)]),
    );
    expect(voices).toMatchObject({
      // His picks by ear (2026-11-12) are the defaults; his own file still wins (Freya here).
      Tessaya: { pocket: "eve", cloud: null },
      Alfred: { pocket: "peter_yearsley", cloud: null },
      Sebastian: { pocket: "michael", cloud: null },
      Freya: { pocket: "jane", cloud: "en-gb-assistant-12" },
    });
  });
});
