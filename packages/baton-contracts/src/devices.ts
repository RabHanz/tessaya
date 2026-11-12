/**
 * Tessaya's hardware devices (the Agora R1 first), one method whose `kind` sets the scope like `baton.home.call`:
 * `read` looks; `act` drives harmless controls (eyes, LED, mute, transport, NFC tags); `owner` is the camera and
 * reboot, on the approval scope, so an agent's ask for one becomes a card on his phone instead.
 */
import * as Schema from "effect/Schema";

export const BATON_DEVICES_WS_METHODS = { call: "baton.devices.call" } as const;
export const BATON_DEVICES_CALL_KINDS = ["read", "act", "owner"] as const;

export const BATON_DEVICES_READ_OPS = ["list"] as const;
export const BATON_DEVICES_ACT_OPS = [
  "eye",
  "led",
  "vibrate",
  "say",
  "mute",
  "earcons",
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
] as const;
export const BATON_DEVICES_OWNER_OPS = ["reboot", "camera", "cameraView", "cameraClear"] as const;

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
  saved: Schema.NullOr(Schema.Struct({ mac: Schema.String, name: Schema.String })),
  output: Schema.Literals(DEVICE_SPEAKER_OUTPUTS),
  found: Schema.Array(
    Schema.Struct({
      mac: Schema.String,
      name: Schema.String,
      rssi: Schema.NullOr(Schema.Number),
      audio: Schema.Boolean,
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

export const DevicesOverview = Schema.Struct({
  broker: Schema.Struct({
    state: Schema.Literals(["off", "connecting", "connected"]),
    host: Schema.NullOr(Schema.String),
  }),
  devices: Schema.Array(DeviceView),
  tags: Schema.Array(DeviceTag),
  /** Agents' camera and reboot asks waiting for his yes on the phone. */
  pending: Schema.Array(Schema.Struct({ id: Schema.String, line: Schema.String })),
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
