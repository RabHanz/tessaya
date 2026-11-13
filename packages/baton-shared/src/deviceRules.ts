/**
 * State triggers on any device (R1-P13 step 3): when an item's value meets a condition, run one action. A rule in
 * plain words ("if the R1 is face down, mute it") keeps his words as an intent and is judged by the brain when its
 * device changes. Pure: the server stores and fires rules, this decides whether one fires.
 */
import type { DeviceRule, DeviceRuleWhen } from "@t3tools/baton-contracts";

/** Ids of rules on device state, in the automations table beside Home Assistant's. */
export const DEVICE_RULE_PREFIX = "tessaya_device_";
export const isDeviceRule = (id: string): boolean => id.startsWith(DEVICE_RULE_PREFIX);

const asNumber = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b) ||
  (typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase());

/** Whether a value meets the condition now. */
export const holds = (when: DeviceRuleWhen, value: unknown): boolean => {
  switch (when.op) {
    case "<":
    case ">": {
      const v = asNumber(value);
      const limit = asNumber(when.value);
      return v !== null && limit !== null && (when.op === "<" ? v < limit : v > limit);
    }
    case "==":
      return same(value, when.value);
    case "!=":
      return !same(value, when.value);
    case "changes":
    case "event":
      return true;
  }
};

/**
 * Fires on the edge: the condition starts to hold, not every report while it holds ("battery < 15" fires once as it
 * drops, again only after it has gone back up). `changes` and `event` fire on every change.
 */
export const fires = (when: DeviceRuleWhen, value: unknown, previous: unknown): boolean =>
  when.op === "changes" || when.op === "event"
    ? true
    : holds(when, value) && (previous === undefined || !holds(when, previous));

/** Whether a change on this device and item concerns the rule. */
export const watches = (rule: DeviceRule, deviceId: string, itemId: string): boolean =>
  (rule.deviceId === null || rule.deviceId === deviceId) &&
  (rule.itemId === null || rule.itemId === itemId);

/** The rule in one line for the Automations list and the Record. */
export const ruleLine = (rule: DeviceRule): string =>
  rule.when === null
    ? `"${rule.intent ?? rule.name}"`
    : `when ${rule.deviceId ?? "any device"} ${rule.itemId ?? "anything"} ${rule.when.op}${rule.when.value === undefined ? "" : ` ${JSON.stringify(rule.when.value)}`}`;
