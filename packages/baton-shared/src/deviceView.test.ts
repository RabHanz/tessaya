import { R1_KEY_SLOTS, type R1KeySlot } from "@t3tools/baton-contracts";
import { describe, expect, it } from "vite-plus/test";

import { keyBindingFrom, keyChoiceOf, keyChoices } from "./deviceView.ts";

describe("an R1 button's choices", () => {
  it("make the binding each names, and read back as the same choice; a detail-less one makes none", () => {
    for (const slot of Object.keys(R1_KEY_SLOTS) as Array<R1KeySlot>)
      for (const [choice] of keyChoices(slot)) {
        const made = keyBindingFrom(choice, "light.desk", { id: "t1", title: "Release" });
        expect(made === null ? null : keyChoiceOf(made), `${slot} ${choice}`).toBe(choice);
      }
    expect(keyBindingFrom("prompt", "  ", null)).toBeNull();
    expect(keyBindingFrom("thread:stop", "", null)).toBeNull();
    // Device actions are offered only where the firmware lets a press be rebound.
    expect(keyChoices("s1.hold").some(([c]) => c === "device:sleep")).toBe(false);
  });
});
