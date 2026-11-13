/**
 * The device registry's rules for one item, shared by the server and the clients that draw it: the server's safety
 * and privacy floor, what a value may be, and how a value reads aloud. Pure.
 */
import { DEVICE_SAFETY, type DeviceItem, type DeviceSafety } from "@t3tools/baton-contracts";

/** Ids whose items always see or hear him, whatever the device says: consent and a live light first. */
const PRIVATE_ITEM =
  /(^|\.)(camera|webcam|mic|microphone|biometric|hello|fingerprint|face|location)(\.|$)|^screen\.capture/;

const rank = (s: DeviceSafety) => DEVICE_SAFETY.indexOf(s);
/** The stricter of two classes. */
export const stricter = (a: DeviceSafety, b: DeviceSafety): DeviceSafety =>
  rank(a) >= rank(b) ? a : b;

/**
 * The server's floor: a device may describe an item as safer than the server allows, never the other way. A private
 * item's write needs at least his owner yes.
 */
export const withFloor = (item: DeviceItem): DeviceItem => {
  const privacy = item.privacy === true || PRIVATE_ITEM.test(item.id);
  const writes = accessOf(item).write;
  const safety = privacy && writes ? stricter(item.safety, "owner") : item.safety;
  return { ...item, safety, ...(privacy ? { privacy: true } : {}) };
};

export const accessOf = (item: Pick<DeviceItem, "access">) => {
  const parts = item.access.split(",").map((p) => p.trim());
  return {
    read: parts.includes("read"),
    write: parts.includes("write"),
    event: parts.includes("event"),
  };
};

/** The value a write may carry for this item, or why not. Unknown types are read-only. */
export const checkWrite = (
  item: DeviceItem,
  value: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly why: string } => {
  if (!accessOf(item).write) return { ok: false, why: `${item.label} can only be read.` };
  switch (item.type) {
    case "number": {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n))
        return { ok: false, why: `${item.label} takes a number.` };
      if (item.range !== undefined && (n < item.range[0] || n > item.range[1]))
        return {
          ok: false,
          why: `${item.label} goes from ${item.range[0]} to ${item.range[1]}${item.unit ?? ""}.`,
        };
      return { ok: true, value: n };
    }
    case "bool":
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "true" || value === "on") return { ok: true, value: true };
      if (value === "false" || value === "off") return { ok: true, value: false };
      return { ok: false, why: `${item.label} is on or off.` };
    case "enum":
      if (typeof value !== "string") return { ok: false, why: `${item.label} takes a name.` };
      if (item.values !== undefined && item.values.length > 0 && !item.values.includes(value))
        return { ok: false, why: `${item.label} is one of ${item.values.join(", ")}.` };
      return { ok: true, value };
    case "string":
      return typeof value === "string" && value.length <= 200
        ? { ok: true, value }
        : { ok: false, why: `${item.label} takes a short text.` };
    case "action": {
      // An action may carry a number (a duration), a text or a small object of arguments.
      if (value === null || value === undefined || value === true) return { ok: true, value: null };
      if (typeof value === "number" && item.range !== undefined)
        return checkWrite({ ...item, type: "number" }, value);
      if (typeof value === "string" || typeof value === "number") return { ok: true, value };
      if (typeof value === "object" && JSON.stringify(value).length <= 400)
        return { ok: true, value };
      return { ok: false, why: `${item.label} got arguments it cannot take.` };
    }
    default:
      return { ok: false, why: `${item.label} is a kind this server cannot set yet.` };
  }
};

/** A value as a person hears it: "71 %", "on", "face down". */
export const valueText = (item: Pick<DeviceItem, "type" | "unit">, value: unknown): string => {
  if (value === null || value === undefined) return "unknown";
  if (item.type === "bool" || typeof value === "boolean") return value === true ? "on" : "off";
  if (typeof value === "number") return `${value}${item.unit === undefined ? "" : ` ${item.unit}`}`;
  if (typeof value === "string") return value.slice(0, 120);
  return JSON.stringify(value).slice(0, 120);
};
