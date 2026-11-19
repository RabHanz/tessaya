import { describe, expect, it } from "vite-plus/test";

import { placeLine } from "./PersonasPage.logic";

describe("placeLine", () => {
  const bodies = [
    { name: "Tumble", on: ["freya", "tessaya"], home: "freya", wearing: "freya" },
    { name: "This desktop", on: ["tessaya"], home: "tessaya", wearing: "tessaya" },
  ];
  it("says every body a persona is on, and the ones it lives on", () => {
    expect(placeLine("tessaya", bodies)).toBe(
      "On Tumble, This desktop now; lives on This desktop. Bring them to another body, or say “bring them here”.",
    );
    expect(placeLine("alfred", bodies)).toBe(
      "Not on any body now. Bring them to another body, or say “bring them here”.",
    );
  });
});
