import { describe, expect, it } from "vite-plus/test";

import { loadPersonaLayers } from "./PersonaLayers.ts";

describe("loadPersonaLayers", () => {
  it("imports nothing outside an internal build, whatever the environment names", async () => {
    const layers = await loadPersonaLayers(
      { stepUp: async () => null },
      "/no/such/layer/that/would/throw/if/imported.ts",
    );
    expect(layers).toEqual([]);
  });
});
