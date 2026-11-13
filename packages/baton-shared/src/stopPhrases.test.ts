import { describe, expect, it } from "vite-plus/test";

import { stopIntent } from "./stopPhrases.ts";

describe("stopIntent", () => {
  it("hears his stop and his dismissal over her, and nothing else", () => {
    for (const t of [
      "Stop.",
      "Okay, stop.",
      "Stop, stop.",
      "Enough, thanks.",
      "Be quiet.",
      "Never mind.",
    ])
      expect(stopIntent(t), t).toBe("stop");
    for (const t of ["Dismissed.", "Okay, dismissed.", "That's all.", "Goodbye."])
      expect(stopIntent(t), t).toBe("dismiss");
    for (const t of [
      "What time is it?",
      "The bus stop is on the corner of the road outside.",
      "Twenty to one, in the morning.",
      "",
    ])
      expect(stopIntent(t), t).toBeNull();
  });

  it("takes his own phrases from his voice settings", () => {
    expect(stopIntent("Hush now.")).toBeNull();
    expect(stopIntent("Hush now.", ["hush"])).toBe("stop");
  });
});
