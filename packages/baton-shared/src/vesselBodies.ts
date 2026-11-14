/**
 * Vessel bodies (VesselBodies): the signed link an NFC tag carries, the items the server keeps for a vessel's body,
 * and where it is when it is in none. Pure; the server signs and the phone writes.
 */
import { VESSEL_BODY_TYPES, type DeviceItem, type VesselBodyType } from "@t3tools/baton-contracts";

/** `https://<host>/b/1/<type>/<bodyId>.<sig>`: any host, so the domain stays a setting and old tags keep working. */
const LINK =
  /^https:\/\/[a-z0-9.-]{1,253}(?::\d{1,5})?\/b\/1\/([a-z]{2,12})\/([a-z2-7]{8})\.([A-Za-z0-9_-]{16})$/i;

export interface BodyLink {
  readonly type: VesselBodyType;
  readonly bodyId: string;
  readonly sig: string;
}

export const parseBodyLink = (url: unknown): BodyLink | null => {
  if (typeof url !== "string") return null;
  const m = LINK.exec(url.trim());
  if (m === null) return null;
  const type = m[1]!.toLowerCase();
  return {
    type: (VESSEL_BODY_TYPES as ReadonlyArray<string>).includes(type)
      ? (type as VesselBodyType)
      : "other",
    bodyId: m[2]!.toLowerCase(),
    sig: m[3]!,
  };
};

export const bodyLink = (host: string, type: VesselBodyType, bodyId: string, sig: string) =>
  `https://${host}/b/1/${type}/${bodyId}.${sig}`;

export const normalUid = (uid: string) => uid.toLowerCase().replace(/[^0-9a-f]/g, "");

/** What the signature covers: the tag's own UID, so the link copied onto another tag fails. */
export const signedText = (uid: string, type: VesselBodyType, bodyId: string) =>
  `${normalUid(uid)}|1|${type}|${bodyId}`;

/** A bare host name (no scheme, path or port), as body tag links name it. */
export const isLinksHost = (host: string) =>
  host.length <= 253 &&
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);

export const BODY_POSTURES = ["in_body", "table", "handheld", "carried"] as const;
export type BodyPosture = (typeof BODY_POSTURES)[number];

/** Out of a body, the motion sensor's activity says where: still on a table, walking about, else in a hand. */
export const postureOf = (inBody: boolean, activity: unknown): BodyPosture | null => {
  if (inBody) return "in_body";
  if (typeof activity !== "string") return null;
  const a = activity.toLowerCase();
  if (/^(still|idle|rest|flat|stationary)/.test(a)) return "table";
  if (/^(walk|carr|run|pocket|bag)/.test(a)) return "carried";
  return "handheld";
};

/** What each kind of body sets before he teaches it more. A vessel without the item skips it. */
export const BODY_TYPE_DEFAULTS: Readonly<
  Partial<Record<VesselBodyType, Record<string, unknown>>>
> = {
  dock: { "imu.profile": "calm" },
  perch: { "imu.profile": "focus" },
  plush: { "imu.profile": "playful" },
  car: { "imu.profile": "mobile" },
  clip: { "imu.profile": "mobile" },
  peek: { "imu.profile": "calm" },
};

/** The server's own items on a vessel that has a body; it writes their values and answers their writes. */
export const BODY_ITEMS: ReadonlyArray<DeviceItem> = [
  {
    id: "body.current",
    label: "Body",
    type: "string",
    access: "read",
    safety: "free",
    group: "body",
    description:
      "the body she is in now: a dock, plush or stand by its name, her Pebble alone, or a bare board",
  },
  {
    id: "body.type",
    label: "Body type",
    type: "string",
    access: "read",
    safety: "free",
    group: "body",
    description: "what kind of body: dock, perch, plush, car, clip, peek, stand, pebble or bare",
  },
  {
    id: "body.name",
    label: "Body name",
    type: "string",
    access: "read,write",
    safety: "free",
    group: "body",
    description: 'the name of the body she is in now; "this is the bedroom dock" renames it',
  },
  {
    id: "body.room",
    label: "Room",
    type: "string",
    access: "read,write",
    safety: "free",
    group: "body",
    description: 'the room the body she is in stands in; "this dock is in the kitchen" sets it',
  },
  {
    id: "body.posture",
    label: "Where it is",
    type: "enum",
    values: [...BODY_POSTURES],
    access: "read",
    safety: "free",
    group: "body",
    description: "in a body, on a table, in a hand, or carried about",
  },
  {
    id: "body.shell",
    label: "Shell",
    type: "enum",
    values: ["pebble", "bare"],
    access: "read,write",
    safety: "confirm",
    group: "body",
    description: "whether the board is in its Pebble shell, or out of it on a bench (dev mode)",
  },
  {
    id: "body.history",
    label: "Body history",
    type: "list",
    access: "read",
    safety: "free",
    group: "body",
    description: "the last bodies it went into and came out of, newest first",
  },
];
