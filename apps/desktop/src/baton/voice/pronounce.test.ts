import { describe, expect, it } from "vite-plus/test";

import { pronounce, pronounceFrom } from "./pronounce.ts";

describe("what the voice is given to say", () => {
  it.each([
    // [what she wrote, what the voice is given]
    // His pick by ear (pronounce-4, #4): "Tess-ay-uh" was heard as "Tessa are".
    ["Tessaya will check it.", "Tessayya will check it."],
    ["Ask Freya's window.", "Ask Fray-uh's window."],
    ["Baton is up, and T3 too.", "Batton is up, and T three too."],
    // The product only: "a baton" is the word.
    ["She passed the baton.", "She passed the baton."],
    // Pocket says these as letters already: "C I" was heard as "See I".
    ["The VPN, the CI and the PR are fine.", "The VPN, the CI and the P R are fine."],
    ["Two PRs and an API key.", "Two P Rs and an API key."],
    ["Run the SQL against the URL.", "Run the SQL against the URL."],
    // Acronyms only in capitals, and only as whole words.
    ["Print it, then pr it and APIary.", "Print it, then pr it and APIary."],
    // Times, the British way.
    ["It is 9:30 GMT+5.", "It is 9 30 G M T plus 5."],
    ["Meet at 14:00 UTC-3:30.", "Meet at 2 pm U T C minus 3 30."],
    ["At 9:05.", "At 9 oh 5."],
    ["At 2:00 pm, or 2:30 pm.", "At 2 pm, or 2 30 pm."],
    ["At 00:00 and at 12:00.", "At midnight and at noon."],
    ["From 10:30-11:00.", "From 10 30 to 11."],
    ["Il est 14:00 à Paris, déjà.", "Il est 14:00 à Paris, déjà."],
    ["About ~5 minutes.", "About about 5 minutes."],
    ["Due 2026-11-07.", "Due 7 November 2026."],
    ["Due 07.11.2026.", "Due 7 November 2026."],
    [
      "Version 0.1.73 is out, 3.5 times faster.",
      "Version 0 point 1 point 73 is out, 3.5 times faster.",
    ],
    ["Update to v0.1.73.", "Update to version 0 point 1 point 73."],
    ["The router is 192.168.1.1.", "The router is 192 dot 168 dot 1 dot 1."],
    // Paths: only the file they name, its full stop kept; and only with a letter in it. Extensions the way he says
    // them (0.1.74), any other spelled as letters; an ALL-CAPS name said as a word.
    ["See apps/desktop/src/core.ts now.", "See core dot T S now."],
    ["See apps/desktop/src/core.ts.", "See core dot T S."],
    ["Run index.test.ts again.", "Run index dot test dot T S again."],
    ["Saved to C:\\Users\\user\\notes.md.", "Saved to notes dot M D."],
    ["Saved to C:\\Users\\user\\My Notes\\plan.md, as asked.", "Saved to plan dot M D, as asked."],
    [
      "There is a conflict in two files, .github/SECURITY.md and apps/web/public/manifest.webmanifest.",
      "There is a conflict in two files, security dot M D and manifest dot web manifest.",
    ],
    ["Open package.json and config.yaml.", "Open package dot jason and config dot yammel."],
    [
      "It is in state.sqlite, run setup.ps1.",
      "It is in state dot S Q lite, run setup dot P S one.",
    ],
    // An unknown extension is spelled out in a path; on its own "example.com" stays a site, not a file.
    ["Check the .env file and src/app.xyz.", "Check the dot env file and app dot X Y Z."],
    ["Mail them at example.com.", "Mail them at example.com."],
    [
      "Edit Pill.tsx and main.py, then build.rs.",
      "Edit Pill dot T S X and main dot pie, then build dot R S.",
    ],
    // A dotfile in a path, and one with parts; a short ALL-CAPS name spelled as the acronym it is.
    ["Copy src/.env and config/.env.local.", "Copy dot env and dot env dot local."],
    ["See docs/PR.md first.", "See P R dot M D first."],
    ["Read docs/API.md and SECURITY.md.", "Read A P I dot M D and security dot M D."],
    ["Step 1/2.5 done.", "Step 1/2.5 done."],
    // Links: the site, with the sentence's own punctuation kept.
    ["Open https://github.com/acme/app/pull/12 please.", "Open github dot com please."],
    ["It is at https://example.com.", "It is at example dot com."],
    ["(see https://example.com/a), then go.", "(see example dot com), then go."],
    ["Read [the guide](https://example.com/guide).", "Read the guide."],
    ["Done ✅ and shipped 🚀.", "Done and shipped."],
    ["Press 1️⃣ now.", "Press now."],
    ["| a | b |", " a b "],
    // Not a path: "and/or" and "TCP/IP" have no file in them.
    ["Yes and/or no over TCP/IP.", "Yes and/or no over TCP/IP."],
  ])("%j is said as %j", (written, said) => {
    expect(pronounce(written)).toBe(said);
  });

  it("takes his own list over the built-in one, whole words only, and respells once", () => {
    const his = { Baton: "Bat-on", Kiro: "Keer-oh", AWS: "A W S" };
    expect(pronounce("Baton runs Kiro on AWS, not aws or Kirov.", his)).toBe(
      "Bat-on runs Keer-oh on A W S, not aws or Kirov.",
    );
    // His spelling of Freya is not respelled again by the built-in one.
    expect(pronounce("Freya.", { Freya: "Freya" })).toBe("Freya.");
    // His own spelling of her name still beats the built-in one.
    expect(pronounce("Tessaya here.", { Tessaya: "Tess-AY-ya" })).toBe("Tess-AY-ya here.");
  });

  it("reads his list from the settings file, keeping only word and text pairs", () => {
    expect(pronounceFrom({ Kiro: "Keer-oh", "": "x", AWS: 3, Blank: " " })).toEqual({
      Kiro: "Keer-oh",
    });
    expect(pronounceFrom(["Kiro"])).toEqual({});
    expect(pronounceFrom(undefined)).toEqual({});
  });
});
