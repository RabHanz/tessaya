import { describe, expect, it } from "vite-plus/test";

import { deviceVoiceLine } from "./HardwareSettings.logic";

const persona = (id: string, extra: object = {}) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  wake: null,
  voice: `${id}-voice`,
  role: "",
  lead: false,
  ...extra,
});

describe("deviceVoiceLine", () => {
  const personas = [
    persona("tessaya", { lead: true }),
    persona("freya", { cloudVoice: "azelma" }),
    persona("alfred", { cloneVoice: "c1" }),
  ];

  it("names the persona the device wears and that persona's own voice, not a fixed one", () => {
    expect(deviceVoiceLine(personas, [{ id: "tumble", wearing: "freya" }], "tumble")).toBe(
      "Freya, speaking with the voice azelma.",
    );
    expect(deviceVoiceLine(personas, [{ id: "tumble", wearing: "alfred" }], "tumble")).toBe(
      "Alfred, speaking with your saved clone.",
    );
  });

  it("falls back to the lead when Cast has nothing for the device", () => {
    expect(deviceVoiceLine(personas, [], "tumble")).toBe(
      "Tessaya, speaking with the voice tessaya-voice.",
    );
    expect(deviceVoiceLine([], [], "tumble")).toBeNull();
  });
});
