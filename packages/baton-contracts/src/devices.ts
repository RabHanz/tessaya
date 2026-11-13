/**
 * Tessaya's hardware devices (the Agora R1 first), one method whose `kind` sets the scope like `baton.home.call`:
 * `read` looks; `act` drives harmless controls (eyes, LED, mute, transport, NFC tags); `owner` is the camera and
 * reboot, on the approval scope, so an agent's ask for one becomes a card on his phone instead.
 */
import * as Schema from "effect/Schema";

import { EnrolCard } from "./enrolCard.ts";

export const BATON_DEVICES_WS_METHODS = { call: "baton.devices.call" } as const;
/** `vessel` is a device on a client connection reporting itself (desktop, phone); never an agent's. */
export const BATON_DEVICES_CALL_KINDS = ["read", "act", "owner", "vessel"] as const;

/** `items` and `read` are the registry's: every device's items, and their values. */
export const BATON_DEVICES_READ_OPS = ["list", "items", "read", "reach", "updates"] as const;
export const BATON_DEVICES_ACT_OPS = [
  "eye",
  "led",
  "vibrate",
  "say",
  "mute",
  "earcons",
  "volume",
  "keyBind",
  "display",
  "transport",
  "transportConfirm",
  "transportRevert",
  "enrol",
  "diag",
  "nfcAssign",
  "nfcRemove",
  "forget",
  "speaker",
  "set",
  "watch",
] as const;
export const BATON_DEVICES_OWNER_OPS = [
  "reboot",
  "camera",
  "cameraView",
  "cameraClear",
  // "Away from home" on or off (R1Reach): an agent's ask goes to his phone, as the camera's does.
  "away",
  // Pairing (R1Pairing): claim a new R1 by the code on its eye; a new device key over the live link.
  "claim",
  "rotate",
  // The R1 hub's bus login, for a room loop or a watching server on another machine.
  "busLogin",
] as const;
export const BATON_DEVICES_VESSEL_OPS = ["publish"] as const;

/** The nine moods the R1's eye clips cover. */
export const R1_MOODS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "curious",
  "love",
  "sleepy",
  "surprise",
  "thinking",
] as const;
export type R1Mood = (typeof R1_MOODS)[number];

/** The firmware maps any colour onto three LED states. */
export const R1_LEDS = ["green", "red", "standby"] as const;

/** in-house is Tessaya's room loop; agora is Agora's cloud (its account is inactive, so it is a trial with a revert). */
export const DEVICE_TRANSPORTS = ["inhouse", "agora"] as const;
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[number];

/** What a tapped NFC tag does. `scene` runs a Home Assistant scene through the home door's own risk check. */
export const DeviceTagAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["mute", "unmute"]) }),
  Schema.Struct({ kind: Schema.Literal("mood"), mood: Schema.Literals(R1_MOODS) }),
  Schema.Struct({
    kind: Schema.Literal("scene"),
    entityId: Schema.String.check(Schema.isMaxLength(200)),
  }),
]);
export type DeviceTagAction = typeof DeviceTagAction.Type;

/** The R1's buttons and the presses each reports on `event/key` (firmware 3.32). */
export const R1_KEYS = ["s1", "s2", "s3"] as const;
export const R1_PRESSES = ["tap", "double", "hold", "long"] as const;
export type R1KeySlot = `${(typeof R1_KEYS)[number]}.${(typeof R1_PRESSES)[number]}`;
/** What the firmware itself can do on a press it lets be rebound (`cmd/key/bind`). */
export const R1_DEVICE_DOS = ["none", "talk", "mute", "vol_up", "vol_down", "sleep"] as const;
export type R1DeviceDo = (typeof R1_DEVICE_DOS)[number];

/**
 * Every press: fixed by the firmware (shown read-only), rebindable on the device, or Tessaya's alone (the firmware does
 * nothing with it). A Tessaya action runs only where the device does nothing, so it reports `did:"none"`.
 */
export const R1_KEY_SLOTS: Readonly<
  Record<R1KeySlot, { readonly fixed: string } | "device" | "tessaya">
> = {
  "s1.tap": { fixed: "Volume up" },
  "s1.double": "device",
  "s1.hold": "tessaya",
  "s1.long": "device",
  "s2.tap": { fixed: "Talk: start or stop" },
  "s2.double": "device",
  "s2.hold": { fixed: "Push to talk" },
  "s2.long": { fixed: "Wake" },
  "s3.tap": { fixed: "Volume down" },
  "s3.double": "device",
  "s3.hold": "tessaya",
  "s3.long": "device",
};
/** The firmware's own bindings until it acks a change on `state/key/bind`. */
export const R1_DEVICE_DEFAULTS: Readonly<Partial<Record<R1KeySlot, R1DeviceDo>>> = {
  "s1.double": "none",
  "s1.long": "mute",
  "s2.double": "none",
  "s3.double": "none",
  "s3.long": "sleep",
};

/** What a free press does: the device's own action, or one of Tessaya's, which the server runs. */
export const R1KeyBinding = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("device"), do: Schema.Literals(R1_DEVICE_DOS) }),
  /** No name: the next persona. Announced in the new persona's voice. */
  Schema.Struct({
    kind: Schema.Literal("persona"),
    name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  }),
  Schema.Struct({ kind: Schema.Literal("whatsNext") }),
  /** A lamp toggles, a scene or script runs; through the home door's own risk check. */
  Schema.Struct({
    kind: Schema.Literal("home"),
    entityId: Schema.String.check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({ kind: Schema.Literal("mute") }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: Schema.String.check(Schema.isMaxLength(100)),
    title: Schema.String.check(Schema.isMaxLength(120)),
    do: Schema.Literals(["continue", "stop"]),
  }),
  /** Said to her as if he had said it. */
  Schema.Struct({
    kind: Schema.Literal("prompt"),
    text: Schema.String.check(Schema.isMaxLength(400)),
  }),
]);
export type R1KeyBinding = typeof R1KeyBinding.Type;

/** The screen's rotation: the accelerometer's (auto), pinned upright or upside down, or "the way it stands now is upright". */
export const DEVICE_DISPLAY_SETS = ["auto", "normal", "flipped", "calibrate"] as const;
export type DeviceDisplaySet = (typeof DEVICE_DISPLAY_SETS)[number];

export const DeviceTag = Schema.Struct({
  uid: Schema.String,
  label: Schema.String,
  action: DeviceTagAction,
});
export type DeviceTag = typeof DeviceTag.Type;

/** What the speaker op asks the firmware to do. `route` picks where replies play. */
export const DEVICE_SPEAKER_ACTIONS = [
  "scan",
  "pair",
  "connect",
  "disconnect",
  "forget",
  "route",
] as const;
export type DeviceSpeakerAction = (typeof DEVICE_SPEAKER_ACTIONS)[number];
/** auto: the Bluetooth speaker while it streams, else the R1's own speaker. */
export const DEVICE_SPEAKER_OUTPUTS = ["auto", "bt", "onboard"] as const;
export type DeviceSpeakerOutput = (typeof DEVICE_SPEAKER_OUTPUTS)[number];

/** An external Bluetooth speaker (the R1 as an A2DP source). */
/** What a Bluetooth audio device is: the firmware's word, else its Class of Device, else its name (btNames `kindOf`). */
export const BT_KINDS = ["headphones", "headset", "speaker", "car", "receiver", "other"] as const;
export type BtKind = (typeof BT_KINDS)[number];

export const DeviceSpeaker = Schema.Struct({
  state: Schema.Literals([
    "off",
    "idle",
    "scanning",
    "connecting",
    "connected",
    "streaming",
    "failed",
  ]),
  /** The saved speaker, kept across reboots until forgotten. */
  saved: Schema.NullOr(
    Schema.Struct({
      mac: Schema.String,
      name: Schema.String,
      cod: Schema.optionalKey(Schema.Number),
      kind: Schema.optionalKey(Schema.Literals(BT_KINDS)),
    }),
  ),
  /** The route he chose (firmware 0.3.52 `wanted`; before it, where replies played). */
  output: Schema.Literals(DEVICE_SPEAKER_OUTPUTS),
  /** Where replies play right now (0.3.52 `out`): onboard while the chosen device is not connected. */
  playing: Schema.optionalKey(Schema.Literals(DEVICE_SPEAKER_OUTPUTS)),
  found: Schema.Array(
    Schema.Struct({
      mac: Schema.String,
      name: Schema.String,
      rssi: Schema.NullOr(Schema.Number),
      audio: Schema.Boolean,
      /** Its Bluetooth Class of Device, when the firmware reports it. */
      cod: Schema.optionalKey(Schema.Number),
      kind: Schema.optionalKey(Schema.Literals(BT_KINDS)),
    }),
  ),
  scannedAt: Schema.NullOr(Schema.String),
});
export type DeviceSpeaker = typeof DeviceSpeaker.Type;

export const DeviceStage = Schema.Struct({
  name: Schema.String,
  lastMs: Schema.NullOr(Schema.Number),
  p50Ms: Schema.NullOr(Schema.Number),
  samples: Schema.Number,
});
export type DeviceStage = typeof DeviceStage.Type;

export const DeviceLogLine = Schema.Struct({
  at: Schema.String,
  topic: Schema.String,
  text: Schema.String,
});

export const DeviceView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literal("agora-r1"),
  /** The one set up in Settings → Home (its key and broker); others were only heard on the broker. */
  configured: Schema.Boolean,
  online: Schema.NullOr(Schema.Boolean),
  lastSeenAt: Schema.NullOr(Schema.String),
  batteryPct: Schema.NullOr(Schema.Number),
  charging: Schema.NullOr(Schema.Boolean),
  rssi: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  firmware: Schema.NullOr(Schema.String),
  /** standalone (no server) is not built yet; every R1 is a satellite today. */
  mode: Schema.Literals(["satellite", "standalone"]),
  mood: Schema.NullOr(Schema.String),
  muted: Schema.Boolean,
  /** Her listening and closing sounds on this R1 (the room loop's cues). */
  earcons: Schema.Boolean,
  /** How loud she speaks, 0-100, as the R1 reports it; null on firmware without a volume command. */
  volume: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** What each press that is not fixed does now (see R1_KEY_SLOTS). */
  keys: Schema.Record(Schema.String, R1KeyBinding),
  /** From the R1's `state/display` (firmware 3.32): how the screen is turned now, and why the last change was refused. */
  display: Schema.Struct({
    rotate: Schema.NullOr(Schema.Number),
    mode: Schema.NullOr(Schema.Literals(["auto", "0", "180"])),
    note: Schema.NullOr(Schema.String),
  }),
  /** Set when the R1 refused the last button change. */
  keyNote: Schema.NullOr(Schema.String),
  transport: Schema.Literals(DEVICE_TRANSPORTS),
  /** While a transport trial runs: when it reverts to in-house, muted, unless confirmed. */
  revertAt: Schema.NullOr(Schema.String),
  enrolling: Schema.Boolean,
  /** The guided read while he enrols on it, and its summary until he closes it. */
  enrol: Schema.NullOr(EnrolCard),
  ota: Schema.NullOr(Schema.Struct({ phase: Schema.String, line: Schema.String })),
  camera: Schema.Struct({
    /** Until when the server takes a picture from it; the privacy light in every client. */
    armedUntil: Schema.NullOr(Schema.String),
    shotAt: Schema.NullOr(Schema.String),
    line: Schema.NullOr(Schema.String),
  }),
  lastTag: Schema.NullOr(Schema.Struct({ uid: Schema.String, at: Schema.String })),
  /** null until the firmware announces it can drive a Bluetooth speaker (state/caps); clients hide the controls. */
  speaker: Schema.NullOr(DeviceSpeaker),
  stages: Schema.Array(DeviceStage),
  log: Schema.Array(DeviceLogLine),
});
export type DeviceView = typeof DeviceView.Type;

/**
 * The device registry (R1-P13): every vessel describes itself with a manifest of items, and its values travel apart
 * as `{itemId, value, at}`. Manifests are data from a device, never instructions; labels reach a model quoted.
 */
export const DEVICE_ITEM_TYPES = ["number", "bool", "enum", "string", "action", "event"] as const;
/** free runs at once; confirm needs his yes; owner needs his verified voice or a phone card; never is Settings only. */
export const DEVICE_SAFETY = ["free", "confirm", "owner", "never"] as const;
export type DeviceSafety = (typeof DEVICE_SAFETY)[number];

const Short = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const DeviceItem = Schema.Struct({
  id: Short(80),
  label: Short(80),
  /** An unknown type is kept and shown read-only. */
  type: Short(20),
  unit: Schema.optionalKey(Short(16)),
  range: Schema.optionalKey(Schema.Tuple([Schema.Number, Schema.Number])),
  values: Schema.optionalKey(Schema.Array(Short(80))),
  /** Comma-separated: read, write, event. */
  access: Short(40),
  safety: Schema.Literals(DEVICE_SAFETY),
  report: Schema.optionalKey(Short(40)),
  group: Schema.optionalKey(Short(40)),
  description: Schema.optionalKey(Short(300)),
  /** Camera, microphone, biometrics, location: his consent and a visible live light before any use. */
  privacy: Schema.optionalKey(Schema.Boolean),
});
export type DeviceItem = typeof DeviceItem.Type;

export const DeviceManifest = Schema.Struct({
  deviceId: Short(60),
  kind: Short(30),
  name: Short(80),
  firmware: Schema.optionalKey(Short(60)),
  schema: Schema.Number,
  version: Schema.optionalKey(Short(60)),
  /** A pretend vessel (the suite, a replay, a bench): answered, never kept or shown. */
  test: Schema.optionalKey(Schema.Boolean),
  items: Schema.Array(DeviceItem).check(Schema.isMaxLength(200)),
});
export type DeviceManifest = typeof DeviceManifest.Type;

export const DeviceItemValue = Schema.Struct({
  itemId: Schema.String,
  value: Schema.Unknown,
  /** When the server heard it (ISO). */
  at: Schema.String,
});
export type DeviceItemValue = typeof DeviceItemValue.Type;

/** One device as the registry holds it: its manifest with the server's safety and privacy floor applied. */
export const RegisteredDevice = Schema.Struct({
  deviceId: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  firmware: Schema.NullOr(Schema.String),
  /** How it reaches the server: the broker, or a client connection. */
  via: Schema.Literals(["mqtt", "client"]),
  online: Schema.Boolean,
  lastSeenAt: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  items: Schema.Array(DeviceItem),
  values: Schema.Array(DeviceItemValue),
  /** Not heard from in two weeks: shown as such, with a way to forget it. */
  stale: Schema.optionalKey(Schema.Boolean),
  /** The member a client vessel belongs to (their phone, their desktop). */
  member: Schema.optionalKey(Schema.String),
  /** Private items in use now (a camera, a microphone): every client shows a live light until then. */
  live: Schema.optionalKey(
    Schema.Array(Schema.Struct({ itemId: Schema.String, until: Schema.String })),
  ),
});
export type RegisteredDevice = typeof RegisteredDevice.Type;

/** A vessel on a client connection (desktop, phone) reports itself; the answer carries writes for it to apply. */
export const DevicePublish = Schema.Struct({
  deviceId: Short(60),
  manifest: Schema.optionalKey(DeviceManifest),
  values: Schema.optionalKey(
    Schema.Array(Schema.Struct({ itemId: Short(80), value: Schema.Unknown })).check(
      Schema.isMaxLength(200),
    ),
  ),
  /** Results of writes it applied since the last call. */
  acks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ id: Short(60), ok: Schema.Boolean, error: Schema.optionalKey(Short(200)) }),
    ),
  ),
  /** Hold the answer open until a write arrives, at most 15 s. */
  waitMs: Schema.optionalKey(Schema.Number),
});
export type DevicePublish = typeof DevicePublish.Type;

export const DeviceWrite = Schema.Struct({
  id: Schema.String,
  itemId: Schema.String,
  value: Schema.Unknown,
});
export type DeviceWrite = typeof DeviceWrite.Type;

/** A condition on one item's value. `changes` and `event` fire on every change. */
export const DeviceRuleWhen = Schema.Struct({
  op: Schema.Literals(["<", ">", "==", "!=", "changes", "event"]),
  value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Boolean, Schema.String])),
});
export type DeviceRuleWhen = typeof DeviceRuleWhen.Type;

/** What a rule does when it fires: an existing act, through that act's own gate. */
export const DeviceRuleAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("device_set"),
    deviceId: Short(60),
    itemId: Short(80),
    value: Schema.optionalKey(
      Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
    ),
  }),
  /** A Home Assistant service on one entity, through the house's own risk check. */
  Schema.Struct({
    kind: Schema.Literal("home"),
    domain: Short(40),
    service: Short(60),
    entityId: Short(200),
  }),
  /** A card on his phone, and a line in the Record. */
  Schema.Struct({ kind: Schema.Literal("notify"), text: Short(300) }),
  /** Said aloud on a device that speaks (the R1). */
  Schema.Struct({ kind: Schema.Literal("say"), deviceId: Short(60), text: Short(300) }),
]);
export type DeviceRuleAction = typeof DeviceRuleAction.Type;

/**
 * A rule on device state. With `when` it is checked in code; without, his words (`intent`) are judged by the brain on
 * each change of the device and item it watches, and the brain picks the action when `then` is absent.
 */
export const DeviceRule = Schema.Struct({
  name: Short(120),
  deviceId: Schema.NullOr(Short(60)),
  itemId: Schema.NullOr(Short(80)),
  when: Schema.NullOr(DeviceRuleWhen),
  intent: Schema.NullOr(Short(400)),
  then: Schema.NullOr(DeviceRuleAction),
});
export type DeviceRule = typeof DeviceRule.Type;

/** device_watch: a rule, and how long it lives (as Home Assistant automations do). */
export const DeviceWatchInput = Schema.Struct({
  rule: DeviceRule,
  kind: Schema.optionalKey(Schema.Literals(["permanent", "temporary"])),
  expiresInMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 525_600 })),
  ),
  once: Schema.optionalKey(Schema.Boolean),
  /** His words, kept for the Record and the Automations list. */
  request: Short(300),
});
export type DeviceWatchInput = typeof DeviceWatchInput.Type;

export const DevicesOverview = Schema.Struct({
  broker: Schema.Struct({
    state: Schema.Literals(["off", "connecting", "connected"]),
    host: Schema.NullOr(Schema.String),
  }),
  devices: Schema.Array(DeviceView),
  tags: Schema.Array(DeviceTag),
  /** Agents' camera and reboot asks waiting for his yes on the phone. */
  pending: Schema.Array(Schema.Struct({ id: Schema.String, line: Schema.String })),
  /** Every device the registry knows, drawn from its manifest. Absent from older servers. */
  registry: Schema.optionalKey(Schema.Array(RegisteredDevice)),
});
export type DevicesOverview = typeof DevicesOverview.Type;

export const BatonDevicesCallInput = Schema.Struct({
  kind: Schema.Literals(BATON_DEVICES_CALL_KINDS),
  op: Schema.String.check(Schema.isMaxLength(40)),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type BatonDevicesCallInput = typeof BatonDevicesCallInput.Type;

/** ok with a value, or not ok with a sentence for a person. */
export const BatonDevicesCallResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
});
export type BatonDevicesCallResult = typeof BatonDevicesCallResult.Type;
