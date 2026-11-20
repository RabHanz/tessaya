/**
 * The phone as one of Tessaya's vessels (R1-P13), a stub: what it can say about itself today without new native
 * modules (its model and system, and whether it has motion sensors). Battery, charging and location join when
 * expo-battery and expo-location are added; the registry takes the new items with no server change.
 */
import type { DeviceManifest } from "@t3tools/tessaya-contracts";

export interface PhoneFacts {
  readonly installId: string;
  readonly model: string | null;
  readonly os: string | null;
  readonly motion: boolean;
}

/** A value in a vessel publish that says where its member is (B-043), noted as presence and never kept as an item. */
export const HERE_ITEM = "presence.here";
export const HERE_SIGNALS = ["foreground", "background", "home", "away"] as const;

export const phoneDeviceId = (installId: string): string =>
  `phone-${
    installId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 24) || "unknown"
  }`;

export const phoneManifest = (facts: PhoneFacts): DeviceManifest => ({
  deviceId: phoneDeviceId(facts.installId),
  kind: "phone",
  name: facts.model ?? "Phone",
  schema: 1,
  items: [
    {
      id: "system.model",
      label: "Model",
      type: "string",
      access: "read",
      safety: "free",
      report: "on-change",
      group: "system",
      description: "the phone's make and model",
    },
    {
      id: "system.os",
      label: "System",
      type: "string",
      access: "read",
      safety: "free",
      report: "on-change",
      group: "system",
      description: "the phone's operating system and version",
    },
    {
      id: "sensors.motion",
      label: "Motion sensors",
      type: "bool",
      access: "read",
      safety: "free",
      report: "on-change",
      group: "sensors",
      description: "whether the phone has motion sensors Tessaya can use",
    },
    {
      id: "talk.cost",
      label: "Talk tab cost",
      type: "string",
      access: "read",
      safety: "free",
      report: "on-change",
      group: "system",
      description:
        "what her body costs the phone: frames drawn a minute and JS-thread busy share over ten minutes on the Talk tab, and ten in the background (D-038)",
    },
    {
      id: "body.tags",
      label: "Body tags",
      type: "list",
      access: "read",
      safety: "free",
      report: "on-change",
      group: "body",
      description: "the body tag the phone was last seated on, read by its own NFC",
    },
  ],
});

export const phoneValues = (facts: PhoneFacts) => [
  { itemId: "system.model", value: facts.model ?? "unknown" },
  { itemId: "system.os", value: facts.os ?? "unknown" },
  { itemId: "sensors.motion", value: facts.motion },
];
