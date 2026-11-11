// @effect-diagnostics globalDate:off - display strings in his own locale, not Effect code.
/**
 * Settings → Devices' words and drawings, shared by web and mobile: a device's status line, the stage table, and a
 * still sketch of each of the R1's nine moods (SVG paths, so both clients draw the same eyes). Pure.
 */
import type { DeviceTagAction, DeviceView, R1Mood } from "@t3tools/baton-contracts";

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

export const tagActionLine = (action: DeviceTagAction): string =>
  action.kind === "mood"
    ? `Eyes: ${action.mood}`
    : action.kind === "scene"
      ? `Scene: ${action.entityId}`
      : action.kind === "mute"
        ? "Mute"
        : "Unmute";

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
