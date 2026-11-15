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
      "No, stop.",
    ])
      expect(stopIntent(t), t).toBe("stop");
    for (const t of [
      "Dismissed.",
      "Dismiss.",
      "Okay, dismissed.",
      "That's all.",
      "Goodbye.",
      // 15 Nov, 09:11: answered, and she stayed awake.
      "Nothing, that would be all.",
      // 15 Nov, 08:27 and 09:11: "dismissed" as the recogniser wrote it.
      "This best.",
      "This miss.",
    ])
      expect(stopIntent(t), t).toBe("dismiss");
    for (const t of [
      "What time is it?",
      "The bus stop is on the corner of the road outside.",
      "Twenty to one, in the morning.",
      // 15 Nov, 08:21: talk that holds a stop word is not a stop.
      "Yeah yeah, I'll stop.",
      "Fair enough.",
      "It's too quiet.",
      "I won't cancel it.",
      "What's this best for?",
      "",
    ])
      expect(stopIntent(t), t).toBeNull();
  });

  it("takes his own phrases from his voice settings", () => {
    expect(stopIntent("Hush now.")).toBeNull();
    expect(stopIntent("Hush now.", ["hush"])).toBe("stop");
  });
});
