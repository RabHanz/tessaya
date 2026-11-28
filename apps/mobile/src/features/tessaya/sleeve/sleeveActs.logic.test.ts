import { describe, expect, it } from "vite-plus/test";

import { callUrl, messageUrl, switchOf } from "./sleeveActs.logic";

describe("her Sleeve's acts", () => {
  it("opens a call only to something that is a number", () => {
    expect(callUrl("+44 20 7946 0958")).toBe("tel:+442079460958");
    expect(callUrl("mum")).toBeNull();
    expect(callUrl("tel:123; rm")).toBeNull();
  });

  it("opens a text with its message, in each platform's own form", () => {
    expect(messageUrl("+44 7700 900123: on my way & late", true)).toBe(
      "sms:+447700900123&body=on%20my%20way%20%26%20late",
    );
    expect(messageUrl("07700900123: hi", false)).toBe("sms:07700900123?body=hi");
    expect(messageUrl("07700900123", true)).toBe("sms:07700900123");
    expect(messageUrl("someone: hi", true)).toBeNull();
  });

  it("reads a setting's switch from her brain, and refuses what is neither", () => {
    expect([true, "On", "yes please", false, "off", "maybe", 3].map(switchOf)).toEqual([
      true,
      true,
      true,
      false,
      false,
      null,
      null,
    ]);
  });
});
