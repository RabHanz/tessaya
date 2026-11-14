/**
 * The device registry's rules for one item, shared by the server and the clients that draw it: the server's safety
 * and privacy floor, what a value may be, and how a value reads aloud. Pure.
 */
import {
  DEVICE_SAFETY,
  type DeviceItem,
  type DeviceSafety,
  type RegisteredDevice,
} from "@t3tools/tessaya-contracts";

/** The suite's, a replay's or a bench's pretend vessel: never kept in the registry, never shown. */
export const isTestVessel = (deviceId: string): boolean =>
  /^(replay|bench|suite|room-suite|test|pretend|probe)([-_.]|$)/i.test(deviceId);

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
      // `true` stays true: the R1's sleep runs only on `value:true` (0.3.52).
      if (value === null || value === undefined) return { ok: true, value: null };
      if (value === true) return { ok: true, value: true };
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

/** Items by their manifest group, in manifest order. */
export const groupItems = <A>(items: ReadonlyArray<DeviceItem>, f: (item: DeviceItem) => A) => {
  const out: Record<string, Array<A>> = {};
  for (const i of items) (out[i.group ?? "other"] ??= []).push(f(i));
  return out;
};

/** device_list for a model: each device's items by group, without values. Labels are the device's words, as data. */
export const itemsView = (devices: ReadonlyArray<RegisteredDevice>) =>
  devices.map((d) => ({
    id: d.deviceId,
    kind: d.kind,
    name: d.name,
    online: d.online,
    groups: groupItems(d.items, (i) => ({
      item: i.id,
      label: i.label,
      type: i.type,
      access: i.access,
      safety: i.safety,
      ...(i.privacy === true ? { privacy: true } : {}),
      ...(i.unit === undefined ? {} : { unit: i.unit }),
      ...(i.range === undefined ? {} : { range: i.range }),
      ...(i.values === undefined ? {} : { values: i.values }),
      ...(i.description === undefined ? {} : { description: i.description }),
    })),
  }));

/** device_read: values with units and how old each is, in seconds. */
export const readView = (
  d: RegisteredDevice,
  itemIds: ReadonlyArray<string> | undefined,
  now: number,
) => ({
  id: d.deviceId,
  name: d.name,
  online: d.online,
  values: d.items
    .filter((i) =>
      itemIds === undefined ? accessOf(i).read || accessOf(i).event : itemIds.includes(i.id),
    )
    .flatMap((i) => {
      const v = d.values.find((x) => x.itemId === i.id);
      return v === undefined && itemIds === undefined
        ? []
        : [
            {
              item: i.id,
              label: i.label,
              value: v?.value ?? null,
              said: v === undefined ? "not reported yet" : valueText(i, v.value),
              ageSeconds:
                v === undefined ? null : Math.max(0, Math.round((now - Date.parse(v.at)) / 1000)),
            },
          ];
    }),
});
