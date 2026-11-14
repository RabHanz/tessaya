import { describe, expect, it } from "vite-plus/test";

import { capabilities, degradedSummary } from "./degraded.ts";

const get = (caps: ReturnType<typeof capabilities>, start: string) =>
  caps.find((c) => c.name.startsWith(start))!;

describe("what works when something is missing", () => {
  it("keeps the local things working with no internet and says what needs it", () => {
    const caps = capabilities({ network: false, claude: true, speechModel: true, server: true });
    expect(get(caps, "Wake word").state).toBe("works");
    expect(get(caps, "Dictation with light").state).toBe("works");
    expect(get(caps, "Snippets").state).toBe("works");
    expect(get(caps, "Answers").state).toBe("off");
    expect(get(caps, "Answers").why).toBe("Needs the internet, which is not available.");
    expect(get(caps, "Sessions, approvals").state).toBe("works");
    expect(degradedSummary(caps)).toMatch(/^\d+ of 11 things are unavailable/);
  });
  it("never reports an unchecked thing as working", () => {
    const caps = capabilities({ network: null, claude: null, speechModel: false, server: null });
    expect(get(caps, "Wake word").state).toBe("off");
    expect(get(caps, "Answers").state).toBe("unknown");
    expect(get(caps, "Transcribing").state).toBe("off");
  });
  it("says everything is available when it is", () => {
    expect(
      degradedSummary(
        capabilities({ network: true, claude: true, speechModel: true, server: true }),
      ),
    ).toBe("Everything checked is available.");
  });
});
