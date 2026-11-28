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
  /** The app's version and the over-the-air update it runs, for the brain's fleet check (M-146). */
  readonly app?: { readonly version: string | null; readonly update: string | null };
  /** It is her Sleeve: a body of hers, which feels and can act for him (M-158, REQ-25-168). */
  readonly sleeve?: boolean;
}

/**
 * What a phone body lets her feel and do. Everything she does hands off to him (he presses call or send) or is her own
 * presence; nothing here acts unseen. Hers only while it is her Sleeve, where its act runner lives.
 */
const SLEEVE_ITEMS: DeviceManifest["items"] = [
  {
    id: "imu.moments",
    label: "Handled",
    type: "string",
    access: "event",
    safety: "free",
    report: "on-change",
    group: "sensors",
    description:
      "being picked up, raised to him, shaken or put face down (moments only, never the sensor stream)",
  },
  {
    id: "skin.screen",
    label: "Touch",
    type: "string",
    access: "event",
    safety: "free",
    report: "on-change",
    group: "sensors",
    description: "his fingers on her on the screen: where, how hard, over how much skin",
  },
  {
    id: "phone.call",
    label: "Call",
    type: "string",
    access: "write",
    safety: "confirm",
    report: "on-change",
    group: "phone",
    description: "opens a call to a number on his phone; he presses call",
  },
  {
    id: "phone.message",
    label: "Text",
    type: "string",
    access: "write",
    safety: "confirm",
    report: "on-change",
    group: "phone",
    description: "a text to send, as 'number: message'; it opens on his phone and he presses send",
  },
  {
    id: "phone.share",
    label: "Share",
    type: "string",
    access: "write",
    safety: "confirm",
    report: "on-change",
    group: "phone",
    description: "opens his share sheet with this text, for any app he picks",
  },
  {
    id: "phone.notify",
    label: "Notify",
    type: "string",
    access: "write",
    safety: "free",
    report: "on-change",
    group: "phone",
    description:
      "a notification on his lock screen, for when he is not looking at her (needs him to have let the app notify him)",
  },
  {
    id: "phone.stage",
    label: "Show on her screen",
    type: "string",
    access: "write",
    safety: "free",
    report: "on-change",
    group: "phone",
    description:
      "holds up a live thing beside her on his phone's screen: 'timer' (his running timer, counting down), 'today' (the rest of today from Coming up), or 'note: <text>', 'weather: <what it is like>', 'music: <what is playing>', 'call: <who>' from what your tools read; 'clear' puts it away",
  },
];

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
  ...(facts.app?.version == null ? {} : { version: facts.app.version.slice(0, 60) }),
  ...(facts.app?.update == null ? {} : { firmware: `update ${facts.app.update.slice(0, 8)}` }),
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
    ...(facts.sleeve === true ? SLEEVE_ITEMS : []),
  ],
});

export const phoneValues = (facts: PhoneFacts) => [
  { itemId: "system.model", value: facts.model ?? "unknown" },
  { itemId: "system.os", value: facts.os ?? "unknown" },
  { itemId: "sensors.motion", value: facts.motion },
];
