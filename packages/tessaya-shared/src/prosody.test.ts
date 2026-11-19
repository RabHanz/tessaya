import { describe, expect, it } from "vite-plus/test";

import { speechPieces } from "./interjections.ts";
import { withProsody } from "./prosody.ts";

const lead = (text: string, continuing: boolean, engine?: "pocket" | "gemini", breath = true) => {
  const first = withProsody(speechPieces(text, "eve"), {
    continuing,
    breath,
    ...(engine === undefined ? {} : { engine }),
  })[0];
  return first?.kind === "sound" ? `${first.sound.kind}` : "words";
};

describe("the prosody front-end", () => {
  it("leaves a reply's first sentence alone, so its first words stream at once", () => {
    expect(lead("And the deploy finishes at half past two this afternoon.", false)).toBe("words");
  });

  it("breathes before a longer sentence that follows another, and only pauses before a short one", () => {
    expect(lead("And the deploy finishes at half past two this afternoon.", true)).toBe("breath");
    expect(lead("Anything else?", true)).toBe("pause");
  });

  it("never breathes unless his setting turns it on (19 Nov: the breath did not sound natural)", () => {
    expect(
      lead("And the deploy finishes at half past two this afternoon.", true, "pocket", false),
    ).toBe("pause");
  });

  it("leaves a cloud voice's breathing to the cloud", () => {
    expect(lead("And the deploy finishes at half past two this afternoon.", true, "gemini")).toBe(
      "words",
    );
  });
});
