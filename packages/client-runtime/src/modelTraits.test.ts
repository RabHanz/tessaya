import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay, getDescriptorStringValue } from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it.each([
    { currentValue: undefined, defaultValue: undefined, value: null, label: "Thinking" },
    { currentValue: undefined, defaultValue: "high", value: "high", label: "High" },
    { currentValue: "low", defaultValue: undefined, value: "low", label: "Low" },
    { currentValue: "max", defaultValue: "high", value: "max", label: "Max" },
    { id: "effort", currentValue: undefined, defaultValue: undefined, value: null, label: "" },
  ])("labels Pi thinking without inventing a selection: $label ($value)", (input) => {
    const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: input.id ?? "thinking",
      label: "Thinking",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === input.defaultValue ? { isDefault: true } : {}),
      })),
      ...(input.currentValue ? { currentValue: input.currentValue } : {}),
    };

    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("pi"),
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });

  // Web and mobile both label the composer with this; builds before it said "Ultracode Off".
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
