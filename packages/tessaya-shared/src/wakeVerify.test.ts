import { describe, expect, it } from "vite-plus/test";

import { wakeTrusted, wakeWordHeard } from "./wakeVerify.ts";

describe("the second check before a wake", () => {
  it("trusts the model only at its ceiling, by the word's own threshold", () => {
    const words = [
      { word: "Tessaya", threshold: 0.95 },
      { word: "Alfred", threshold: 0.9 },
    ];
    // His real passes in the 0.1.61 logs.
    expect(wakeTrusted(words, "Tessaya", 1.0518)).toBe(true);
    expect(wakeTrusted(words, "tessaya", 1.0525)).toBe(true);
    expect(wakeTrusted(words, "Tessaya", 1.03)).toBe(false);
    expect(wakeTrusted(words, "Alfred", 1.05)).toBe(false);
    expect(wakeTrusted(words, "Freya", 2)).toBe(false);
  });

  it("accepts the wake word and the ways recognition spells it", () => {
    // The clip ends where the model fired, just after the name.
    expect(wakeWordHeard("Sebastian.", "Sebastian")).toBe(true);
    expect(wakeWordHeard("hey alfred", "Alfred")).toBe(true);
    expect(wakeWordHeard("okay, Fraya", "Freya")).toBe(true);
    expect(wakeWordHeard("al fred", "Alfred")).toBe(true);
    expect(wakeWordHeard("Tessaia", "Tessaya")).toBe(true);
  });

  it("hears Tessaya in the words a British voice comes back as, and not in near misses", () => {
    // "To say you." and "Тесая." are his real wakes from the 0.1.61 logs.
    const heard = ["To say yeah.", "Tessa yeah.", "tess a ya", "the saya", "To say you.", "Тесая."];
    for (const text of heard) expect([text, wakeWordHeard(text, "Tessaya")]).toEqual([text, true]);
    // The wake lane's near misses (tessaya-ops/wake/gb_test.py).
    const near = [
      "Tessa, what time is it?",
      "Vanessa said it was fine.",
      "I wanted to say a few words.",
      "Tess, are you there?",
      "The essay is due on Friday.",
      "Teresa will call you back.",
      "Is this a test?",
      "Did you just say yeah?",
      "Thessaly lies in central Greece.",
      "Let me say a thing or two.",
      "Tessie left her umbrella on the train.",
      // Found in review: a sound match inside a sentence, or ending on "you".
      "Nice to see you",
      "Good to see you again",
      "I was going to say yeah",
      "I just wanted to say you were right",
      "Tessa, you there?",
      "To say you can see that.",
      "So to say you",
      "Yeah.",
      // The clip ends where the model fired, so near misses arrive cut short.
      "Tessa, you.",
      "To see you.",
      "Do say you.",
      "They say you.",
      "I desire nothing",
      "the desired outcome",
      "Desiree called",
    ];
    for (const text of near) expect([text, wakeWordHeard(text, "Tessaya")]).toEqual([text, false]);
    for (const [text, word] of [
      ["Set them free, you know", "Freya"],
      ["Set them free, you", "Freya"],
      ["Free you.", "Freya"],
      ["Fray you.", "Freya"],
      ["all fret", "Alfred"],
      ["I'll fret", "Alfred"],
    ] as const)
      expect([text, wakeWordHeard(text, word)]).toEqual([text, false]);
  });

  it("takes his own 'Tessaya' as Parakeet writes it, only alone at the clip's start and with the model sure (G1)", () => {
    // 0.1.73-74: his live wakes came back "To say." and "To see her."; the one clip he says is right, "To say here".
    for (const text of ["To say.", "To see her.", "Tuh say.", "To say here.", "to say"])
      expect([text, wakeWordHeard(text, "Tessaya", 1.05)]).toEqual([text, true]);
    for (const [text, score] of [
      // The model unsure: as before.
      ["To say.", 0.98],
      ["To see her.", undefined],
      // Something before them, or a sentence after.
      ["I want to say.", 1.05],
      ["Nice to see her.", 1.05],
      ["To say a few words.", 1.05],
      ["To see her again tomorrow.", 1.05],
      // Not these forms.
      ["To see you.", 1.05],
      ["They say.", 1.05],
    ] as const)
      expect([text, wakeWordHeard(text, "Tessaya", score)]).toEqual([text, false]);
    // Only her name: another wake word is never these.
    expect(wakeWordHeard("To say.", "Freya", 1.05)).toBe(false);
  });

  it("rejects speech that only sounds a little like it, and silence", () => {
    expect(wakeWordHeard("and the sixth of November", "Sebastian")).toBe(false);
    expect(wakeWordHeard("it was a nice day at the beach", "Alfred")).toBe(false);
    expect(wakeWordHeard("the weather in Norfolk is cold", "Onyx")).toBe(false);
    expect(wakeWordHeard("", "Freya")).toBe(false);
    expect(wakeWordHeard("   ", "Tessaya")).toBe(false);
  });
});
