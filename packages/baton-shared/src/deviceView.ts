// @effect-diagnostics globalDate:off - display strings in his own locale, not Effect code.
/**
 * Settings → Devices' words and drawings, shared by web and mobile: a device's status line, the stage table, and a
 * still sketch of each of the R1's nine moods (SVG paths, so both clients draw the same eyes). Pure.
 */
import {
  R1_DEVICE_DOS,
  R1_KEY_SLOTS,
  type DeviceSpeaker,
  type DeviceTagAction,
  type DeviceView,
  type R1DeviceDo,
  type R1KeyBinding,
  type R1KeySlot,
  type R1Mood,
} from "@t3tools/baton-contracts";

import { DEFAULT_OS_PACK } from "./osPack.ts";

export const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { timeStyle: "medium" });

export const deviceStatusLine = (d: DeviceView): string =>
  [
    d.online === true ? "Online" : d.online === false ? "Offline" : "Not heard from yet",
    d.batteryPct === null
      ? null
      : `battery ${d.batteryPct}%${d.charging === true ? ", charging" : ""}`,
    d.signal === null && d.rssi === null
      ? null
      : `Wi-Fi ${d.signal ?? ""}${d.rssi === null ? "" : ` (${d.rssi} dBm)`}`.replace("  ", " "),
    d.firmware === null ? null : `firmware ${d.firmware}`,
    d.mode,
    d.online !== true && d.lastSeenAt !== null ? `last seen ${when(d.lastSeenAt)}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

export const transportLine = (d: DeviceView): string =>
  d.revertAt !== null
    ? `Trying ${d.transport}. Goes back to in-house, muted, at ${clock(d.revertAt)} unless you keep it.`
    : d.transport === "inhouse"
      ? "In-house: Tessaya's own room loop hears and speaks."
      : "Agora's cloud. Its account is inactive, so the device may not answer; revert to in-house if it goes quiet.";

/** One line for the R1's Bluetooth speaker row, the same on web and mobile. */
export const speakerLine = (s: DeviceSpeaker): string => {
  const name = s.saved?.name ?? "the speaker";
  switch (s.state) {
    case "scanning":
      return "Looking for Bluetooth speakers nearby.";
    case "connecting":
      return `Connecting to ${name}.`;
    case "connected":
    case "streaming":
      return `Connected to ${name}. ${SPEAKER_OUTPUT_LINE[s.output]}`;
    case "failed":
      return `Could not reach ${name}. Check it is on and in range, then connect again.`;
    default:
      return s.saved === null
        ? "No speaker paired. Scan, then pick one to pair."
        : `${name} is paired but not connected. Replies play on the R1.`;
  }
};

export const SPEAKER_OUTPUT_LINE = {
  auto: "Replies play on it, and on the R1 when it drops.",
  bt: "Replies play only on it.",
  onboard: "Replies play on the R1's own speaker for now.",
} as const;

export const tagActionLine = (action: DeviceTagAction): string =>
  action.kind === "mood"
    ? `Eyes: ${action.mood}`
    : action.kind === "scene"
      ? `Scene: ${action.entityId}`
      : action.kind === "mute"
        ? "Mute"
        : "Unmute";

/** The screen choices, without calibrate (its own "Set upright" button), and which one the R1 reports. */
export const DISPLAY_CHOICES = [
  ["auto", "Auto"],
  ["normal", "Normal"],
  ["flipped", "Upside down"],
] as const;
export const displayChoiceOf = (d: DeviceView): "auto" | "normal" | "flipped" =>
  d.display.mode === "0" ? "normal" : d.display.mode === "180" ? "flipped" : "auto";
export const displayLine = (d: DeviceView): string =>
  d.display.note ??
  (d.display.mode === null
    ? "Auto turns it with the R1. Set upright stores how it stands now as upright (firmware 3.32)."
    : `${d.display.mode === "auto" ? "Turns with the R1" : "Pinned"}; upright now is ${d.display.rotate === 180 ? "upside down" : "normal"}.`);

const DEVICE_DO_LINE: Readonly<Record<R1DeviceDo, string>> = {
  none: "Nothing",
  talk: "Talk: start or stop",
  mute: "Mic mute, on the R1",
  vol_up: "Volume up",
  vol_down: "Volume down",
  sleep: "Deep sleep",
};

export const keyBindingLine = (b: R1KeyBinding): string => {
  switch (b.kind) {
    case "device":
      return DEVICE_DO_LINE[b.do];
    case "persona":
      return b.name === undefined ? "Next persona, in her voice" : `Switch to ${b.name}`;
    case "whatsNext":
      return "What's next";
    case "home":
      return `Home: ${b.entityId}`;
    case "mute":
      return "Mute Tessaya";
    case "thread":
      return `${b.do === "stop" ? "Stop" : "Continue"}: ${b.title}`;
    case "prompt":
      return `Ask: “${b.text}”`;
  }
};

/** One press per row, in button order; `fixed` is the firmware's own, shown read-only. */
export const KEY_ROWS = (Object.keys(R1_KEY_SLOTS) as Array<R1KeySlot>).map((slot) => {
  const spec = R1_KEY_SLOTS[slot];
  const [key, press] = slot.split(".") as [string, string];
  return {
    slot,
    title: `${key.toUpperCase()} ${press}`,
    fixed: typeof spec === "object" ? spec.fixed : null,
  };
});

/** What a free press may be set to. `home`, `thread:*` and `prompt` need a detail before they save. */
export const keyChoices = (slot: R1KeySlot): ReadonlyArray<readonly [string, string]> => [
  ["device:none", "Nothing"],
  ...(R1_KEY_SLOTS[slot] === "device"
    ? R1_DEVICE_DOS.filter((d) => d !== "none").map(
        (d) => [`device:${d}`, DEVICE_DO_LINE[d]] as const,
      )
    : []),
  ["persona:", "Next persona, in her voice"],
  ...DEFAULT_OS_PACK.personas.map((p) => [`persona:${p.name}`, `Switch to ${p.name}`] as const),
  ["whatsNext", "What's next"],
  ["mute", "Mute Tessaya"],
  ["home", "Toggle a lamp or run a scene"],
  ["thread:continue", "Continue a thread"],
  ["thread:stop", "Stop a thread"],
  ["prompt", "Ask her something"],
];

export const keyChoiceOf = (b: R1KeyBinding): string =>
  b.kind === "device"
    ? `device:${b.do}`
    : b.kind === "persona"
      ? `persona:${b.name ?? ""}`
      : b.kind === "thread"
        ? `thread:${b.do}`
        : b.kind;

/** The binding a choice makes, or null while its detail (entity, thread or words) is missing. */
export const keyBindingFrom = (
  choice: string,
  text: string,
  thread: { readonly id: string; readonly title: string } | null,
): R1KeyBinding | null => {
  const [kind, rest = ""] = choice.split(":") as [string, string?];
  const t = text.trim();
  switch (kind) {
    case "device":
      return R1_DEVICE_DOS.includes(rest as R1DeviceDo)
        ? { kind: "device", do: rest as R1DeviceDo }
        : null;
    case "persona":
      return rest === "" ? { kind: "persona" } : { kind: "persona", name: rest };
    case "whatsNext":
    case "mute":
      return { kind };
    case "home":
      return t === "" ? null : { kind: "home", entityId: t };
    case "thread":
      return thread === null
        ? null
        : {
            kind: "thread",
            threadId: thread.id,
            title: thread.title.slice(0, 120),
            do: rest === "stop" ? "stop" : "continue",
          };
    case "prompt":
      return t === "" ? null : { kind: "prompt", text: t.slice(0, 400) };
  }
  return null;
};

export const msText = (ms: number | null): string => (ms === null ? "none yet" : `${ms} ms`);

/** The eyes in a 80×36 box: the two round screens, then each mood's marks. `fill` false means a stroke. */
export interface EyeMark {
  readonly d: string;
  readonly fill: boolean;
}
const L = 20;
const R = 60;
const Y = 18;
const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const both = (f: (cx: number, side: -1 | 1) => EyeMark): ReadonlyArray<EyeMark> => [
  f(L, -1),
  f(R, 1),
];
const heart = (cx: number) =>
  `M${cx} ${Y + 7}C${cx - 11} ${Y - 1} ${cx - 6} ${Y - 9} ${cx} ${Y - 3}C${cx + 6} ${Y - 9} ${cx + 11} ${Y - 1} ${cx} ${Y + 7}Z`;

export const EYE_SCREENS: ReadonlyArray<EyeMark> = [
  { d: circle(L, Y, 15), fill: false },
  { d: circle(R, Y, 15), fill: false },
];

export const MOOD_EYES: Readonly<Record<R1Mood, ReadonlyArray<EyeMark>>> = {
  neutral: both((cx) => ({ d: circle(cx, Y, 6), fill: true })),
  happy: both((cx) => ({
    d: `M${cx - 7} ${Y + 3}Q${cx} ${Y - 8} ${cx + 7} ${Y + 3}`,
    fill: false,
  })),
  sad: [
    ...both((cx) => ({ d: circle(cx, Y + 3, 5), fill: true })),
    ...both((cx, side) => ({
      d: `M${cx - 7} ${Y - 5 + (side < 0 ? 3 : -3)}L${cx + 7} ${Y - 5 + (side < 0 ? -3 : 3)}`,
      fill: false,
    })),
  ],
  angry: [
    ...both((cx) => ({ d: circle(cx, Y + 2, 5), fill: true })),
    ...both((cx, side) => ({
      d: `M${cx - 8} ${Y - 7 + (side < 0 ? -2 : 4)}L${cx + 8} ${Y - 7 + (side < 0 ? 4 : -2)}`,
      fill: false,
    })),
  ],
  curious: [
    { d: circle(L, Y, 5), fill: true },
    { d: circle(R, Y - 1, 8), fill: true },
  ],
  love: both((cx) => ({ d: heart(cx), fill: true })),
  sleepy: both((cx) => ({
    d: `M${cx - 8} ${Y + 1}Q${cx} ${Y + 6} ${cx + 8} ${Y + 1}`,
    fill: false,
  })),
  surprise: both((cx) => ({ d: circle(cx, Y, 10), fill: false })),
  thinking: both((cx) => ({ d: circle(cx + 4, Y - 5, 5), fill: true })),
};
