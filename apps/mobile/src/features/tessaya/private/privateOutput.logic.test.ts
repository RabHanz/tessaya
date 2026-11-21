import { describe, expect, it } from "vite-plus/test";

import { privateSoundAllowed } from "./privateOutput.logic";

describe("her private voice on the phone", () => {
  it("plays into headphones whoever is home, and out loud only when he is alone", () => {
    expect(privateSoundAllowed("bluetooth-a2dp", "others")).toBe(true);
    expect(privateSoundAllowed("wired", "unknown")).toBe(true);
    expect(privateSoundAllowed("speaker", "alone")).toBe(true);
    expect(privateSoundAllowed("speaker", "others")).toBe(false);
    expect(privateSoundAllowed("receiver", "unknown")).toBe(false);
    expect(privateSoundAllowed(null, "others")).toBe(false);
  });
});
