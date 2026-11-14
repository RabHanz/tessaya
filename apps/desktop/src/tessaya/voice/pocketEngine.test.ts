import { describe, expect, it } from "vite-plus/test";

import { createPocketEngine } from "./pocketVoice.ts";

describe("the Pocket engine on a machine it has no build for", () => {
  it("says the voice cannot load, so the line is shown and not spoken by another voice", async () => {
    const engine = createPocketEngine({
      root: "/nonexistent",
      platform: "plan9",
      arch: "mips",
      onProgress: () => undefined,
    });
    expect(engine.synthesise("anna")).toBeNull();
    expect(await engine.ensure("anna")).toBe(false);
  });
});
