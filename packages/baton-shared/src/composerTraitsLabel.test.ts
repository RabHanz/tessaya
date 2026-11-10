import { buildTraitsTriggerDisplay } from "@t3tools/client-runtime/model-traits";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

// Web and mobile both label the composer with this; mobile builds before 2026-11-06 said "Ultracode Off".
describe("composer traits label", () => {
  it.each([
    [undefined, "Medium"],
    [false, "Medium"],
    [true, "Medium · Ultracode"],
  ])("names Ultracode only when it is on (%s)", (currentValue, label) => {
    const display = buildTraitsTriggerDisplay({
      provider: ProviderDriverKind.make("claudeAgent"),
      descriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [{ id: "medium", label: "Medium", isDefault: true }],
        },
        {
          id: "ultracode",
          label: "Ultracode",
          type: "boolean",
          ...(currentValue === undefined ? {} : { currentValue }),
        },
      ],
      primarySelectDescriptorId: "effort",
      ultrathinkPromptControlled: false,
    });
    expect(display.label).toBe(label);
    expect(display.ultracode).toBe(currentValue === true);
  });
});
