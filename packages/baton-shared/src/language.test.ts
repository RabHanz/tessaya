import { describe, expect, it } from "vite-plus/test";

import { mostlyForeign } from "./language.ts";

describe("mostlyForeign", () => {
  it("knows the room's TV from him (10:35, 13 Nov)", () => {
    expect(
      mostlyForeign(
        "Ik heb minekin, for nie bata. So, you can see that. Foi já gente. Quem quer essa trilha? Twizz.",
      ),
    ).toBe(true);
    for (const t of [
      "I think. Tessaya, what time is it?",
      "Speak it normally in AM and PM.",
      "Can you turn on my office fan?",
      "Café opens at nine, José said.",
      "Que?",
    ])
      expect(mostlyForeign(t), t).toBe(false);
  });
});
