// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off preferSchemaOverJson:off
/**
 * Tessaya's hardware devices, the Agora R1 first. One MQTT subscriber on the broker the R1's record names
 * (Settings → Home) keeps each device's status, and every control goes out from here as `freya/r1/<id>/...`, so no
 * client ever speaks MQTT. Camera and reboot asked by anyone but him become a phone card first.
 */
import * as NodeCrypto from "node:crypto";

import {
  DEVICE_SPEAKER_OUTPUTS,
  DEVICE_TRANSPORTS,
  EnrolCard,
  R1_DEVICE_DEFAULTS,
  R1_DEVICE_DOS,
  R1_KEY_SLOTS,
  R1_MOODS,
  type R1DeviceDo,
  type R1KeyBinding,
  type R1KeySlot,
  type DeviceDisplaySet,
  type DeviceSpeaker,
  type DeviceSpeakerAction,
  type DeviceSpeakerOutput,
  type DeviceStage,
  type DeviceTag,
  type DeviceTagAction,
  type DeviceTransport,
  type DeviceView,
  type DevicesOverview,
} from "@t3tools/baton-contracts";
import { recordText } from "@t3tools/baton-shared/audit";
import { valueText } from "@t3tools/baton-shared/deviceItems";
import { volumeAfter, volumeLine, type VolumeTo } from "@t3tools/baton-shared/speakingVolume";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BatonPhoneInbox } from "../baton/BatonPhoneInbox.ts";
import { BatonRecordService } from "../baton/BatonRecordService.ts";
import { DeviceRefusedError, DeviceRegistry } from "./DeviceRegistry.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { connectMqtt } from "./Mqtt.ts";

/** settings is him in Settings → Devices (the RPC checked his scope); anyone else asks before camera or reboot. */
export interface DeviceActor {
  readonly who: string;
  readonly surface: "settings" | "agent" | "assistant";
  /** His yes is already given: his own spoken request at the R1, his voice verified this turn (R1Device). */
  readonly approved?: boolean;
}

export type DeviceCommand =
  | { readonly op: "eye"; readonly mood: (typeof R1_MOODS)[number]; readonly holdMs?: number }
  | { readonly op: "led"; readonly color: "green" | "red" | "standby" }
  | { readonly op: "vibrate"; readonly ms: number }
  | { readonly op: "say"; readonly text: string }
  | { readonly op: "mute"; readonly muted: boolean }
  | { readonly op: "earcons"; readonly on: boolean }
  | { readonly op: "keyBind"; readonly slot: R1KeySlot; readonly bind: R1KeyBinding }
  | { readonly op: "display"; readonly set: DeviceDisplaySet }
  | { readonly op: "transport"; readonly transport: DeviceTransport }
  | { readonly op: "transportConfirm" }
  | { readonly op: "transportRevert" }
  | { readonly op: "enrol"; readonly cancel: boolean }
  | { readonly op: "diag" }
  /** How loud she speaks on it (firmware `cmd/volume`, r1/bt-smp 0.3.x; earlier firmware ignores it). */
  | { readonly op: "volume"; readonly to: VolumeTo }
  | { readonly op: "forget" }
  | {
      readonly op: "speaker";
      readonly action: DeviceSpeakerAction;
      readonly mac?: string;
      readonly name?: string;
      readonly output?: DeviceSpeakerOutput;
    }
  | { readonly op: "reboot" }
  | { readonly op: "camera" }
  /**
   * Any registry item on any vessel, by its manifest. `confirmed`: he said yes to this change in the conversation,
   * which a `confirm` item needs from her; an agent's never counts.
   */
  | {
      readonly op: "item";
      readonly itemId: string;
      readonly value: unknown;
      readonly confirmed?: boolean;
    };

export interface DeviceOutcome {
  /** confirm: nothing was done; she asks him and calls again. */
  readonly status: "done" | "asked" | "confirm";
  readonly line: string;
}

/** Owner ops: never run for an agent without his yes. */
/** The firmware's 0 dB on the DAC (r1bt_volume_get's fallback). */
const R1_DEFAULT_VOLUME = 71;

const RISKY_OPS: ReadonlySet<DeviceCommand["op"]> = new Set(["reboot", "camera"]);
/** How long a private item's live light shows after it is used. */
const LIVE_MS = 30_000;

const TRIAL_MS = 60_000;
const CAMERA_WINDOW_MS = 30_000;
const SHOT_KEEP_MS = 10 * 60_000;
const ASK_TTL_MS = 10 * 60_000;
const ENROL_MS = 5 * 60_000;
const REARM_AFTER_MS = [2_000, 8_000, 18_000] as const;
export const MAX_SHOT_BYTES = 512 * 1024;
const LOG_KEEP = 40;
const SAMPLES_KEEP = 50;
const SETTINGS_KEY = "devices.state";

/** The room loop's per-turn metrics, in pipeline order. */
const STAGES = [
  ["endpointMs", "End of speech"],
  ["asrMs", "Speech to text"],
  ["brainFirstMs", "Brain, first words"],
  ["ttsFirstMs", "Voice, first sound"],
  ["firstSoundMs", "Heard to first sound"],
] as const;

/**
 * What the broker has told us about one device beyond its items: the link, and the R1's own controls. Item values
 * (battery, Wi-Fi, volume, firmware, mood...) live in the DeviceRegistry.
 */
export interface Heard {
  online: boolean | null;
  lastSeen: number | null;
  ota: { phase: string; line: string } | null;
  camera: string | null;
  lastTag: { uid: string; at: number } | null;
  display: DeviceView["display"];
  /** The R1 answered the last `cmd/key/bind` with `{"ok":false}`. */
  keyRefused: boolean;
  /** Set once the firmware's state/caps says it drives a Bluetooth speaker; the speaker controls stay off until then. */
  speaker: {
    state: DeviceSpeaker["state"];
    saved: DeviceSpeaker["saved"];
    output: DeviceSpeakerOutput;
    found: DeviceSpeaker["found"];
    scannedAt: number | null;
  } | null;
  samples: Record<string, Array<number>>;
  log: Array<{ at: number; topic: string; text: string }>;
  /** The room loop's enrolment card while he enrols, and its summary until he closes it. */
  enrol: EnrolCard | null;
}

const blank = (): Heard => ({
  online: null,
  lastSeen: null,
  ota: null,
  camera: null,
  lastTag: null,
  keyRefused: false,
  display: { rotate: null, mode: null, note: null },
  speaker: null,
  samples: {},
  log: [],
  enrol: null,
});

const decodeEnrolCard = Schema.decodeUnknownOption(EnrolCard);

const json = (text: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const SPEAKER_STATES: ReadonlyArray<string> = [
  "off",
  "idle",
  "scanning",
  "connecting",
  "connected",
  "streaming",
  "failed",
];
export const MAC = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/** What one broker message means for the registry: item values, a manifest, a write acknowledged. */
export interface Folded {
  readonly id: string;
  readonly cameOnline: boolean;
  readonly tag: string | null;
  readonly items: ReadonlyArray<{ readonly itemId: string; readonly value: unknown }>;
  readonly manifest: unknown;
  readonly ack: { readonly itemId: string; readonly ok: boolean; readonly error?: string } | null;
}

/** The R1 says `onboard` on its older topics where its manifest says `speaker`. */
const outputItem = (out: string | null) => (out === "onboard" ? "speaker" : out);

/**
 * Folds one broker message into what we know of its device. Pure. Returns the device id, the item values it carries
 * (the firmware's older topics map onto its manifest's items until it reports `state/item/<id>` for all of them), and
 * what the service must react to: the device coming online (re-arm in-house voice) or a tag tapped. Payloads are the
 * firmware's, so data.
 */
export const applyMessage = (
  devices: Map<string, Heard>,
  topic: string,
  payload: string,
  now: number,
): Folded | null => {
  const parts = topic.split("/");
  if (parts[0] !== "freya" || parts[1] !== "r1" || parts[2] === undefined || parts[2] === "")
    return null;
  const id = parts[2].slice(0, 60);
  const rest = parts.slice(3).join("/");
  const d = devices.get(id) ?? blank();
  devices.set(id, d);
  const body = json(payload);
  let cameOnline = false;
  let tag: string | null = null;
  let manifest: unknown = null;
  let ack: Folded["ack"] = null;
  const items: Array<{ itemId: string; value: unknown }> = [];
  const item = (itemId: string, value: unknown) => {
    if (value !== null && value !== undefined) items.push({ itemId, value });
  };
  let line = recordText(payload, 160);
  const done = () => ({ id, cameOnline, tag, items, manifest, ack });
  if (rest.startsWith("state/item/") && rest !== "state/item/ack") {
    item(rest.slice("state/item/".length), body === null ? payload.trim() : body["value"]);
    d.lastSeen = now;
    return done();
  }
  if (/^(state|event)\/(imu\/)?(posture|activity)$/.test(rest)) {
    const which = rest.endsWith("posture") ? "imu.posture" : "imu.activity";
    item(
      which,
      str(body?.["value"]) ??
        str(body?.[which.slice(4)]) ??
        (body === null ? str(payload.trim()) : null),
    );
  }
  if (/^event\/(tap|double_tap|shake|stroke|touch)$/.test(rest))
    item("touch.tap", str(body?.["ev"]) ?? str(body?.["gesture"]) ?? rest.slice("event/".length));
  switch (rest) {
    case "state/online": {
      const up = payload.trim() === "1";
      cameOnline = up && d.online !== true;
      d.online = up;
      break;
    }
    case "state/battery": {
      const pct = Number.parseInt(payload, 10);
      if (Number.isFinite(pct) && pct >= 0) item("power.battery_pct", pct);
      break;
    }
    case "state/power": {
      const pct = num(body?.["battery_pct"]);
      if (pct !== null && pct >= 0) item("power.battery_pct", pct);
      if (typeof body?.["charging"] === "boolean") item("power.charging", body["charging"]);
      if (typeof body?.["stay_awake"] === "boolean") item("power.stay_awake", body["stay_awake"]);
      const up = num(body?.["uptime_ms"]);
      if (up !== null) item("system.uptime", Math.round(up / 1000));
      break;
    }
    case "state/wifi":
      item("wifi.rssi", num(body?.["rssi"]));
      item("wifi.quality", str(body?.["quality"]));
      break;
    case "state/manifest":
      manifest = body;
      line = `manifest ${str(body?.["version"]) ?? ""}`.trim();
      break;
    case "state/item/ack": {
      const cmd = str(body?.["cmd"]) ?? str(body?.["id"]) ?? str(body?.["item"]);
      if (cmd !== null)
        ack = {
          itemId: cmd.replace(/^item\//, ""),
          ok: body?.["ok"] !== false,
          ...(str(body?.["error"]) === null
            ? {}
            : { error: recordText(str(body?.["error"])!, 160) }),
        };
      break;
    }
    case "state/audio/output":
      item("audio.output", outputItem(str(body?.["out"])));
      if (typeof body?.["device"] === "string") item("audio.device", body["device"]);
      break;
    case "event/key": {
      const key = str(body?.["key"]);
      const act = str(body?.["act"]);
      if (key !== null && act !== null) item("key.press", `${key}.${act}`);
      break;
    }
    case "state/ota": {
      const phase = str(body?.["phase"]) ?? str(body?.["state"]) ?? "unknown";
      const rc = num(body?.["rc"]);
      const extra = str(body?.["extra"]) ?? str(body?.["note"]);
      d.ota = {
        phase,
        line: `${phase}${rc !== null && rc !== 0 ? ` (code ${rc})` : ""}${extra === null ? "" : `: ${recordText(extra, 80)}`}`,
      };
      break;
    }
    case "state/eye/mood":
      item("eye.mood", str(body?.["mood"]) ?? (recordText(payload.trim(), 20) || null));
      break;
    case "state/camera":
      d.camera = str(body?.["ev"]) ?? d.camera;
      break;
    case "state/display": {
      if (body?.["ok"] === false) {
        d.display = {
          ...d.display,
          note: recordText(str(body["reason"]) ?? "The R1 refused that.", 120),
        };
        break;
      }
      const rotate = num(body?.["rotate"]);
      const mode = String(body?.["mode"] ?? "");
      d.display = {
        rotate: rotate === 0 || rotate === 180 ? rotate : d.display.rotate,
        mode: mode === "auto" || mode === "0" || mode === "180" ? mode : d.display.mode,
        note: null,
      };
      break;
    }
    case "event/announce":
    case "event/wake/boot":
      item("system.firmware", str(body?.["fw_ver"]) ?? str(body?.["fw"]));
      break;
    case "state/volume":
      item("audio.volume", num(body?.["pct"]));
      break;
    case "state/caps":
      item("system.firmware", str(body?.["fw"]));
      if (body?.["bt_speaker"] === true)
        d.speaker ??= { state: "off", saved: null, output: "auto", found: [], scannedAt: null };
      else d.speaker = null;
      break;
    case "state/bt": {
      item("bt.state", str(body?.["state"]));
      if (typeof body?.["name"] === "string" && body["name"] !== "")
        item("audio.device", body["name"]);
      if (d.speaker === null) break;
      const state = str(body?.["state"]);
      if (state !== null && SPEAKER_STATES.includes(state as never))
        d.speaker.state = state as DeviceSpeaker["state"];
      const out = str(body?.["out"]);
      if (out !== null && DEVICE_SPEAKER_OUTPUTS.includes(out as never))
        d.speaker.output = out as DeviceSpeakerOutput;
      const mac = str(body?.["mac"]);
      d.speaker.saved =
        body?.["saved"] === true && mac !== null
          ? { mac, name: recordText(str(body?.["name"]) ?? mac, 40) }
          : null;
      break;
    }
    case "event/bt/devices": {
      if (d.speaker === null) break;
      const list = Array.isArray(body?.["devices"]) ? (body["devices"] as Array<unknown>) : [];
      d.speaker.found = list.slice(0, 10).flatMap((x) => {
        const v = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
        const mac = str(v["mac"]);
        return mac === null || !MAC.test(mac)
          ? []
          : [
              {
                mac,
                name: recordText(str(v["name"]) ?? "", 40),
                rssi: num(v["rssi"]),
                audio: v["audio"] === true,
              },
            ];
      });
      d.speaker.scannedAt = now;
      line = `${d.speaker.found.length} Bluetooth devices nearby`;
      break;
    }
    case "event/nfc": {
      const uid = payload.trim();
      if (/^[0-9a-fA-F:]{4,40}$/.test(uid)) {
        tag = uid.toLowerCase();
        d.lastTag = { uid: tag, at: now };
      }
      break;
    }
    case "event/enrol": {
      // Several a second while he reads: the card, not the log.
      const card = decodeEnrolCard(body);
      if (card._tag === "Some") d.enrol = card.value;
      d.lastSeen = now;
      return done();
    }
    case "event/voice/metrics": {
      // The loop sends what was heard too; only the times are kept.
      const parts: Array<string> = [];
      for (const [key, name] of STAGES) {
        const ms = num(body?.[key]);
        if (ms === null) continue;
        const list = (d.samples[key] ??= []);
        list.push(ms);
        if (list.length > SAMPLES_KEEP) list.shift();
        parts.push(`${name} ${Math.round(ms)} ms`);
      }
      line = parts.join(", ") || "turn";
      break;
    }
  }
  if (rest !== "state/online" || d.online) d.lastSeen = now;
  d.log.push({ at: now, topic: rest, text: line });
  if (d.log.length > LOG_KEEP) d.log.shift();
  return done();
};

export const stagesOf = (d: Heard): ReadonlyArray<DeviceStage> =>
  STAGES.map(([key, name]) => {
    const list = d.samples[key] ?? [];
    return {
      name,
      lastMs: list.length === 0 ? null : Math.round(list[list.length - 1]!),
      p50Ms: median(list),
      samples: list.length,
    };
  });

interface Saved {
  transport: Record<string, DeviceTransport>;
  muted: Record<string, boolean>;
  /** R1s with her listening and closing sounds off (the room loop plays them by default). */
  earconsOff: Record<string, boolean>;
  /** Per R1: the level she last set by voice, so a step has a base before the firmware reports one. */
  volume: Record<string, number>;
  tags: Record<string, { label: string; action: DeviceTagAction }>;
  /** Per R1: the device's bindings from its last ack, and Tessaya's (null: nothing, overriding the default). */
  keys: Record<
    string,
    {
      device: Partial<Record<R1KeySlot, R1DeviceDo>>;
      tessaya: Partial<Record<R1KeySlot, R1KeyBinding | null>>;
    }
  >;
}

/** S2 double switches to the next persona until he picks something else. */
const TESSAYA_DEFAULTS: Partial<Record<R1KeySlot, R1KeyBinding>> = {
  "s2.double": { kind: "persona" },
};
/** The firmware's long press; a hold released before it is a hold, after it was the long press. */
const LONG_PRESS_MS = 3000;

const tessayaOf = (saved: Saved, id: string, slot: R1KeySlot): R1KeyBinding | null => {
  const mine = saved.keys[id]?.tessaya[slot];
  return mine === undefined ? (TESSAYA_DEFAULTS[slot] ?? null) : mine;
};

/** What a press does now: the device's own action unless it does nothing there and Tessaya has one. */
const keyBindingOf = (saved: Saved, id: string, slot: R1KeySlot): R1KeyBinding => {
  const device =
    R1_KEY_SLOTS[slot] === "device"
      ? (saved.keys[id]?.device[slot] ?? R1_DEVICE_DEFAULTS[slot] ?? "none")
      : "none";
  const tessaya = tessayaOf(saved, id, slot);
  return device === "none" && tessaya !== null ? tessaya : { kind: "device", do: device };
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export interface DeviceLink {
  readonly publish: (topic: string, payload: string, retain?: boolean) => void;
  readonly connected: () => boolean;
  readonly close: () => void;
}

/** The broker, behind a seam so tests run without a socket. */
export class HomeDeviceBroker extends Context.Service<
  HomeDeviceBroker,
  {
    readonly connect: (input: {
      readonly url: string;
      readonly user: string | null;
      readonly pass: string | null;
      readonly onMessage: (topic: string, payload: string) => void;
    }) => Effect.Effect<DeviceLink>;
  }
>()("t3/home/HomeDevices/HomeDeviceBroker") {}

export const brokerLayer = Layer.succeed(HomeDeviceBroker, {
  connect: Effect.fn("HomeDeviceBroker.connect")(function* (
    input: Parameters<HomeDeviceBroker["Service"]["connect"]>[0],
  ) {
    return yield* Effect.sync((): DeviceLink => {
      const url = new URL(input.url);
      const client = connectMqtt({
        host: url.hostname,
        port: Number(url.port || 1883),
        clientId: `tessaya-devices-${NodeCrypto.randomBytes(3).toString("hex")}`,
        ...(input.user === null ? {} : { user: input.user }),
        ...(input.pass === null ? {} : { pass: input.pass }),
        subscribe: ["freya/r1/+/state/#", "freya/r1/+/event/#"],
        onMessage: (topic, payload) => input.onMessage(topic, payload.toString("utf8")),
        log: () => {},
      });
      return {
        publish: (topic: string, payload: string, retain?: boolean) =>
          client.publish(topic, payload, retain),
        connected: client.connected,
        close: client.close,
      };
    });
  }),
});

/** A button's thread action; a seam, since importing the engine here closes an import cycle through the MCP tools. */
export class HomeDeviceThreads extends Context.Service<
  HomeDeviceThreads,
  { readonly run: (threadId: string, what: "continue" | "stop") => Effect.Effect<boolean> }
>()("t3/home/HomeDevices/HomeDeviceThreads") {}

export class HomeDevices extends Context.Service<
  HomeDevices,
  {
    readonly overview: Effect.Effect<DevicesOverview>;
    readonly command: (
      id: string,
      command: DeviceCommand,
      by: DeviceActor,
    ) => Effect.Effect<DeviceOutcome, DeviceRefusedError>;
    readonly assignTag: (
      uid: string,
      label: string,
      action: DeviceTagAction,
    ) => Effect.Effect<ReadonlyArray<DeviceTag>>;
    readonly removeTag: (uid: string) => Effect.Effect<ReadonlyArray<DeviceTag>>;
    /** The held picture as a data URL, for him only. */
    readonly cameraView: (
      id: string,
    ) => Effect.Effect<{ readonly at: string; readonly dataUrl: string } | null>;
    readonly cameraClear: (id: string) => Effect.Effect<void>;
    /** A JPEG the device posted; taken only inside the window he opened. */
    readonly acceptShot: (id: string, bytes: Uint8Array) => Effect.Effect<boolean>;
    /** One broker message; the subscriber feeds every one through here, in order. */
    readonly receive: (topic: string, payload: string) => Effect.Effect<void>;
    /** One pass: follow the device record's broker, end trials, windows and asks. The layer runs it. */
    readonly tick: Effect.Effect<void>;
  }
>()("t3/home/HomeDevices") {}

const LED = {
  green: { r: 0, g: 255, b: 0 },
  red: { r: 255, g: 0, b: 0 },
  standby: { r: 0, g: 0, b: 0 },
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const home = yield* HomeAssistantService;
  const broker = yield* HomeDeviceBroker;
  const inbox = yield* Effect.serviceOption(BatonPhoneInbox);
  const threads = yield* Effect.serviceOption(HomeDeviceThreads);
  const record = yield* Effect.serviceOption(BatonRecordService);
  const registry = yield* DeviceRegistry;
  const scope = yield* Effect.scope;
  const incoming = yield* Queue.unbounded<{ topic: string; payload: string }>();

  const heard = new Map<string, Heard>();
  const trials = new Map<string, number>();
  const enrolling = new Map<string, number>();
  const cameras = new Map<
    string,
    {
      armedUntil: number | null;
      shot: { at: number; bytes: Uint8Array } | null;
      line: string | null;
    }
  >();
  const asks = new Map<
    string,
    { id: string; command: DeviceCommand; line: string; by: DeviceActor; until: number }
  >();
  let link: DeviceLink | null = null;
  let linkKey: string | null = null;
  let device: R1Device | null = null;
  let counter = 0;

  const readSaved = sql<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${SETTINGS_KEY}`.pipe(
    Effect.map((rows): Saved => {
      const value = json(rows[0]?.value ?? "") ?? {};
      return {
        transport: (value["transport"] ?? {}) as Saved["transport"],
        muted: (value["muted"] ?? {}) as Saved["muted"],
        earconsOff: (value["earconsOff"] ?? {}) as Saved["earconsOff"],
        volume: (value["volume"] ?? {}) as Saved["volume"],
        tags: (value["tags"] ?? {}) as Saved["tags"],
        keys: (value["keys"] ?? {}) as Saved["keys"],
      };
    }),
    Effect.orDie,
  );
  const writeSaved = (saved: Saved) =>
    sql`INSERT INTO fabric_settings (key, value) VALUES (${SETTINGS_KEY}, ${JSON.stringify(saved)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
      Effect.asVoid,
      Effect.orDie,
    );
  const change = (f: (saved: Saved) => void) =>
    Effect.flatMap(readSaved, (saved) => {
      f(saved);
      return writeSaved(saved);
    });

  const audit = (by: DeviceActor, id: string, subject: string, outcome: string) =>
    record._tag === "Some"
      ? record.value.append({
          kind: "device",
          actor: by.who,
          ref: id,
          subject,
          outcome,
          detail: by.surface,
        })
      : Effect.void;

  const publish = (id: string, path: string, payload: unknown, retain = false) =>
    Effect.sync(() => {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      link?.publish(`freya/r1/${id}/${path}`, text, retain);
    });

  const live = (id: string) =>
    Effect.suspend(() => {
      if (link === null || !link.connected())
        return Effect.fail(
          new DeviceRefusedError({
            why: "The devices' broker is not connected. Check the R1's broker in Settings → Home.",
          }),
        );
      if (heard.get(id)?.online !== true)
        return Effect.fail(
          new DeviceRefusedError({ why: `${id} is offline right now. Nothing was sent.` }),
        );
      return Effect.void;
    });

  /** In-house voice is a push the firmware forgets on every boot, so it is sent again after each one. */
  const rearm = Effect.fn("HomeDevices.rearm")(function* (id: string) {
    for (const [i, at] of REARM_AFTER_MS.entries()) {
      yield* Effect.sleep(at - (i === 0 ? 0 : REARM_AFTER_MS[i - 1]!));
      const saved = yield* readSaved;
      if ((saved.transport[id] ?? "inhouse") === "inhouse")
        yield* publish(id, "cmd/voice/mode", { mode: "inhouse" });
      if (saved.muted[id] === true) yield* publish(id, "voice/ctl", { ev: "mute" });
    }
  });

  const runTag = Effect.fn("HomeDevices.runTag")(function* (id: string, uid: string) {
    const entry = (yield* readSaved).tags[uid];
    if (entry === undefined) return;
    const by: DeviceActor = { who: `NFC tag ${entry.label}`, surface: "agent" };
    const action = entry.action;
    switch (action.kind) {
      case "mute":
      case "unmute":
        return yield* command(id, { op: "mute", muted: action.kind === "mute" }, by).pipe(
          Effect.ignore,
        );
      case "mood":
        return yield* command(id, { op: "eye", mood: action.mood }, by).pipe(Effect.ignore);
      case "scene":
        return yield* home
          .call(
            {
              domain: "scene",
              service: "turn_on",
              target: { entity_id: action.entityId },
              why: `NFC tag "${entry.label}" tapped on the R1`,
            },
            { who: `NFC tag ${entry.label}`, surface: "r1" },
          )
          .pipe(Effect.ignore);
    }
  });

  /** A press the device left to us (`did:"none"`) runs its Tessaya action; any other press was the device's. */
  const runKey = Effect.fn("HomeDevices.runKey")(function* (
    id: string,
    body: Record<string, unknown> | null,
  ): Effect.fn.Return<void> {
    // A hold runs on release, so holding on into a long press does not run both.
    if (body?.["did"] !== "none" || body["act"] === "hold") return;
    const act =
      body["act"] === "hold_end"
        ? (num(body["ms"]) ?? LONG_PRESS_MS) < LONG_PRESS_MS
          ? "hold"
          : null
        : body["act"];
    const slot = `${String(body["key"])}.${String(act)}`;
    if (!Object.hasOwn(R1_KEY_SLOTS, slot) || typeof R1_KEY_SLOTS[slot as R1KeySlot] === "object")
      return;
    // did:"none" says the device did nothing, whatever its last ack said.
    const bind = tessayaOf(yield* readSaved, id, slot as R1KeySlot);
    if (bind === null) return;
    const by: DeviceActor = { who: `the R1's ${slot} button`, surface: "agent" };
    const say = (text: string) => publish(id, "voice/say", { text });
    switch (bind.kind) {
      case "device":
        return;
      case "persona":
        return yield* publish(
          id,
          "voice/persona",
          bind.name === undefined ? {} : { name: bind.name },
        );
      case "whatsNext":
        return yield* publish(id, "voice/ask", { text: "What's next?" });
      case "prompt":
        return yield* publish(id, "voice/ask", { text: bind.text });
      case "mute":
        return yield* command(
          id,
          { op: "mute", muted: (yield* readSaved).muted[id] !== true },
          by,
        ).pipe(Effect.ignore);
      case "home": {
        const domain = bind.entityId.split(".")[0] ?? "";
        const outcome = yield* home
          .call(
            {
              domain,
              service: domain === "scene" || domain === "script" ? "turn_on" : "toggle",
              target: { entity_id: bind.entityId },
              why: `The R1's ${slot} button`,
            },
            { who: by.who, surface: "r1" },
          )
          .pipe(Effect.catchTags({ HomeRefusedError: (e) => Effect.succeed({ line: e.why }) }));
        return yield* say(outcome.line);
      }
      case "thread": {
        if (threads._tag === "None") return;
        const ok = yield* threads.value.run(bind.threadId, bind.do);
        return yield* say(
          ok
            ? `${bind.do === "stop" ? "Stopped" : "Continued"} ${bind.title}.`
            : bind.do === "stop"
              ? `Nothing was running in ${bind.title}.`
              : `I couldn't continue ${bind.title}.`,
        );
      }
    }
  });

  /** The R1's ack of a bind: its whole map, or `{"ok":false}` when it refused the change. */
  const keepBinds = Effect.fn("HomeDevices.keepBinds")(function* (
    id: string,
    body: Record<string, unknown> | null,
  ): Effect.fn.Return<void> {
    const d = heard.get(id);
    if (d === undefined || body === null) return;
    d.keyRefused = body["ok"] === false;
    if (d.keyRefused) return;
    const device: Partial<Record<R1KeySlot, R1DeviceDo>> = {};
    for (const [slot, spec] of Object.entries(R1_KEY_SLOTS)) {
      if (spec !== "device") continue;
      const [key, act] = slot.split(".") as [string, string];
      const v = (body[key] as Record<string, unknown> | undefined)?.[act];
      if (R1_DEVICE_DOS.includes(v as R1DeviceDo)) device[slot as R1KeySlot] = v as R1DeviceDo;
    }
    yield* change((s) => {
      s.keys[id] = { device, tessaya: s.keys[id]?.tessaya ?? {} };
    });
  });

  const handle = Effect.fn("HomeDevices.handle")(function* (topic: string, payload: string) {
    const now = yield* Clock.currentTimeMillis;
    const result = applyMessage(heard, topic, payload, now);
    if (result === null) return;
    if (topic.endsWith("/state/online"))
      yield* registry.seen(result.id, heard.get(result.id)?.online === true);
    if (result.manifest !== null) {
      const refused = yield* registry.publish("mqtt", result.manifest);
      if (refused !== null)
        heard.get(result.id)?.log.push({ at: now, topic: "state/manifest", text: refused });
    }
    if (result.items.length > 0) yield* registry.report("mqtt", result.id, result.items);
    if (result.ack !== null) yield* registry.acked(result.id, result.ack.itemId, result.ack);
    if (result.cameOnline) yield* rearm(result.id).pipe(Effect.forkIn(scope));
    if (result.tag !== null) yield* runTag(result.id, result.tag);
    const tail = topic.slice(`freya/r1/${result.id}/`.length);
    if (tail === "event/key") yield* runKey(result.id, json(payload));
    else if (tail === "state/key/bind") yield* keepBinds(result.id, json(payload));
  });

  const revert = Effect.fn("HomeDevices.revert")(function* (id: string) {
    trials.delete(id);
    yield* change((s) => {
      s.transport[id] = "inhouse";
      s.muted[id] = true;
    });
    yield* publish(id, "cmd/voice/mode", { mode: "inhouse" });
    yield* publish(id, "voice/ctl", { ev: "mute" });
  });

  const describe = (c: DeviceCommand): string =>
    c.op === "camera"
      ? "take one camera picture"
      : c.op === "reboot"
        ? "restart the device"
        : c.op === "item"
          ? `use ${c.itemId}${c.value === null || c.value === undefined ? "" : ` (${recordText(JSON.stringify(c.value), 60)})`}`
          : c.op;

  /** A registry item and its device, or why there is none. */
  const itemOf = Effect.fn("HomeDevices.itemOf")(function* (id: string, itemId: string) {
    const reg = yield* registry.get(id);
    const item = reg?.items.find((i) => i.id === itemId);
    if (reg === null || item === undefined)
      return yield* new DeviceRefusedError({
        why:
          reg === null
            ? `No device called ${id} is known here.`
            : `${reg.name} has no item ${itemId}.`,
      });
    return { reg, item };
  });

  const run = Effect.fn("HomeDevices.run")(function* (
    id: string,
    c: DeviceCommand,
    by: DeviceActor,
  ): Effect.fn.Return<DeviceOutcome, DeviceRefusedError> {
    const now = yield* Clock.currentTimeMillis;
    const done = (line: string): DeviceOutcome => ({ status: "done", line });
    switch (c.op) {
      case "eye":
        // Through the room loop, the device's one writer for the eyes; it holds a server mood for 30 s at most.
        yield* publish(id, "voice/intent/eye", {
          vessel: id,
          mood: c.mood,
          holdMs: Math.min(Math.max(c.holdMs ?? 6000, 500), 30_000),
          reason: `${by.who} asked`,
        });
        return done(`The eyes show ${c.mood}.`);
      case "led":
        yield* publish(id, "cmd/led/set", { ...LED[c.color], mode: "solid" });
        return done(`The light is ${c.color}.`);
      case "volume": {
        const reported = yield* registry.value(id, "audio.volume");
        const before =
          typeof reported === "number"
            ? reported
            : ((yield* readSaved).volume[id] ?? R1_DEFAULT_VOLUME);
        const after = volumeAfter(before, c.to, R1_DEFAULT_VOLUME);
        yield* change((s) => {
          s.volume[id] = after;
        });
        yield* publish(id, "cmd/volume", { pct: after });
        return done(volumeLine(before, after));
      }
      case "vibrate":
        yield* publish(id, "cmd/vibrate", { ms: Math.min(Math.max(Math.round(c.ms), 10), 1500) });
        return done("It buzzed.");
      case "say":
        yield* publish(id, "voice/say", { text: recordText(c.text, 400) });
        return done("Sent to the device to say.");
      case "mute":
        yield* change((s) => {
          s.muted[id] = c.muted;
        });
        yield* publish(id, "voice/ctl", { ev: c.muted ? "mute" : "unmute" });
        return done(c.muted ? "Muted: it does not listen or speak." : "Unmuted.");
      case "earcons":
        yield* change((s) => {
          if (c.on) delete s.earconsOff[id];
          else s.earconsOff[id] = true;
        });
        // Retained, so the room loop has it again after a restart.
        yield* publish(id, "cmd/voice/earcons", { on: c.on }, true);
        return done(
          c.on
            ? "Her listening and closing sounds are on."
            : "Her listening and closing sounds are off.",
        );
      case "keyBind": {
        const spec = R1_KEY_SLOTS[c.slot];
        const device = c.bind.kind === "device" ? c.bind.do : "none";
        if (typeof spec === "object" || (spec === "tessaya" && device !== "none"))
          return yield* new DeviceRefusedError({
            why: "The R1 does that press itself; it cannot be changed.",
          });
        yield* change((s) => {
          const k = (s.keys[id] ??= { device: {}, tessaya: {} });
          k.tessaya[c.slot] = c.bind.kind === "device" ? null : c.bind;
          // Shown at once; the R1's ack replaces it, or its refusal says so in keyNote.
          if (spec === "device") k.device[c.slot] = device;
        });
        if (spec === "tessaya") return done("Saved.");
        const [key, act] = c.slot.split(".");
        yield* publish(id, "cmd/key/bind", { key, act, do: device });
        return done("Saved. The R1 confirms it in a moment.");
      }
      case "display":
        yield* publish(
          id,
          "cmd/display/rotate",
          c.set === "normal" ? { deg: 0 } : c.set === "flipped" ? { deg: 180 } : { mode: c.set },
        );
        return done(
          c.set === "calibrate"
            ? "The way it stands now is upright."
            : c.set === "auto"
              ? "The screen turns with the R1."
              : `The screen stays ${c.set === "normal" ? "upright" : "upside down"}.`,
        );
      case "transport":
        if (c.transport === "inhouse") {
          trials.delete(id);
          yield* change((s) => {
            s.transport[id] = "inhouse";
          });
          yield* publish(id, "cmd/voice/mode", { mode: "inhouse" });
          return done("Voice runs through Tessaya's room loop.");
        }
        trials.set(id, now + TRIAL_MS);
        yield* change((s) => {
          s.transport[id] = c.transport;
        });
        yield* publish(id, "cmd/voice/mode", { mode: c.transport });
        return done(
          `Trying ${c.transport}. Unless you keep it within ${TRIAL_MS / 1000} seconds, it goes back to in-house, muted.`,
        );
      case "transportConfirm":
        if (!trials.delete(id)) return done("Nothing to keep: no trial is running.");
        return done("Kept.");
      case "transportRevert":
        yield* revert(id);
        return done("Back on in-house voice, muted. Unmute when it is ready.");
      case "enrol":
        if (c.cancel) {
          enrolling.delete(id);
          const card = heard.get(id);
          if (card !== undefined) card.enrol = null;
          yield* publish(id, "voice/enrol", { cancel: true });
          return done("Enrolment cancelled.");
        }
        enrolling.set(id, now + ENROL_MS);
        yield* publish(id, "voice/enrol", {});
        return done("Enrolling: read the sentences on the card aloud to the device.");
      case "diag":
        yield* publish(id, "cmd/diag/dump", {});
        yield* publish(id, "cmd/power/status", {});
        return done("Asked for a diagnostics snapshot; it appears in the log.");
      case "forget": {
        heard.delete(id);
        trials.delete(id);
        enrolling.delete(id);
        cameras.delete(id);
        yield* change((s) => {
          delete s.transport[id];
          delete s.muted[id];
          delete s.earconsOff[id];
          delete s.keys[id];
        });
        yield* publish(id, "cmd/voice/earcons", "", true);
        yield* registry.forget(id);
        if (device?.deviceId === id) yield* home.setDevice(null).pipe(Effect.ignore);
        return done("Forgotten. Set it up again in Settings → Home.");
      }
      case "speaker": {
        if (heard.get(id)?.speaker == null)
          return yield* new DeviceRefusedError({
            why: `${id}'s firmware cannot drive a Bluetooth speaker yet. Nothing was sent.`,
          });
        const target =
          c.mac !== undefined ? { mac: c.mac } : c.name !== undefined ? { name: c.name } : {};
        switch (c.action) {
          case "scan":
            yield* publish(id, "cmd/bt/scan", { secs: 10 });
            return done("Looking for Bluetooth speakers for about ten seconds.");
          case "pair":
          case "connect":
            yield* publish(id, `cmd/bt/${c.action}`, target);
            return done(
              c.action === "pair"
                ? "Pairing. Put the speaker in pairing mode if it is not already."
                : "Connecting to the speaker.",
            );
          case "disconnect":
            yield* publish(id, "cmd/bt/disconnect", {});
            return done("Disconnected. Replies play on the R1 until you connect again.");
          case "forget":
            yield* publish(id, "cmd/bt/forget", {});
            return done("Speaker forgotten. Pair it again to use it.");
          case "route":
            yield* publish(id, "cmd/bt/route", { out: c.output ?? "auto" });
            return done(
              c.output === "bt"
                ? "Replies play only on the Bluetooth speaker."
                : c.output === "onboard"
                  ? "Replies play on the R1's own speaker."
                  : "Replies play on the Bluetooth speaker when it is connected, else on the R1.",
            );
        }
        return done("Done.");
      }
      case "reboot":
        yield* publish(id, "cmd/reboot", {});
        yield* audit(by, id, "R1 restarted", "done");
        return done("Restarting; it is back in about half a minute.");
      case "camera":
        cameras.set(id, {
          armedUntil: now + CAMERA_WINDOW_MS,
          shot: null,
          line: "Waiting for the picture.",
        });
        yield* publish(id, "cmd/camera/capture", {});
        yield* audit(by, id, "R1 camera picture", "taken");
        return done("Taking one picture.");
      case "item": {
        const { reg, item } = yield* itemOf(id, c.itemId);
        if (item.privacy === true) yield* registry.markLive(id, c.itemId, LIVE_MS);
        // The R1's picture keeps its own path: the window the upload is accepted in.
        if (reg.via === "mqtt" && c.itemId === "camera.capture")
          return yield* run(id, { op: "camera" }, by);
        const out = yield* registry.write(id, c.itemId, c.value);
        const said =
          item.type === "action"
            ? `${item.label} on ${reg.name}`
            : `${item.label} on ${reg.name} to ${valueText(item, c.value)}`;
        yield* audit(by, id, said, out.status);
        return done(
          out.status === "sent"
            ? out.line
            : item.type === "action"
              ? `Done: ${item.label} on ${reg.name}.`
              : `${item.label} on ${reg.name} is now ${valueText(item, c.value)}.`,
        );
      }
    }
  });

  const command = Effect.fn("HomeDevices.command")(function* (
    id: string,
    c: DeviceCommand,
    by: DeviceActor,
  ): Effect.fn.Return<DeviceOutcome, DeviceRefusedError> {
    // A registry item is checked by its own class; the registry says when its device is away.
    let needsYes = RISKY_OPS.has(c.op);
    if (c.op === "item") {
      const { reg, item } = yield* itemOf(id, c.itemId);
      if (item.safety === "never" && by.surface !== "settings")
        return yield* new DeviceRefusedError({
          why: `${item.label} on ${reg.name} is changed only in Settings → Hardware.`,
        });
      // His yes in the conversation counts from her own turn, never from an agent's say-so.
      if (item.safety === "confirm" && by.surface === "assistant" && c.confirmed !== true)
        return {
          status: "confirm",
          line: `Ask him first, in a few words: ${item.label} on ${reg.name}${item.type === "action" ? "" : ` to ${valueText(item, c.value)}`}? Then call again with confirmed: true once he says yes.`,
        } satisfies DeviceOutcome;
      needsYes = item.safety === "owner" || (item.safety === "confirm" && by.surface === "agent");
    } else if (c.op !== "forget") yield* live(id);
    if (needsYes && by.surface !== "settings" && by.approved !== true) {
      const now = yield* Clock.currentTimeMillis;
      const askId = `device-${now.toString(36)}${(counter++ % 1296).toString(36)}`;
      const line = `${by.who} wants to ${describe(c)} on ${id}`;
      if (inbox._tag === "None")
        return yield* new DeviceRefusedError({
          why: "That needs the Director's yes, and his phone inbox is not here.",
        });
      yield* inbox.value.mirror({
        id: askId,
        title:
          c.op === "item"
            ? "Tessaya wants to use one of your devices"
            : "Tessaya wants to use the R1",
        detail: `${line}.`,
        buttons: ["Yes, do it", "No"],
        yes: 0,
        cancel: 1,
        needs: "cloud-approve",
      });
      asks.set(askId, { id, command: c, line, by, until: now + ASK_TTL_MS });
      yield* audit(by, id, line, "asked");
      return {
        status: "asked",
        line: `Sent to the Director's phone for a yes. Nothing happens unless he says yes within ${ASK_TTL_MS / 60_000} minutes.`,
      } satisfies DeviceOutcome;
    }
    return yield* run(id, c, by);
  });

  const tagList = (saved: Saved): ReadonlyArray<DeviceTag> =>
    Object.entries(saved.tags).map(([uid, t]) => ({ uid, label: t.label, action: t.action }));

  const viewOf = (
    id: string,
    d: Heard,
    saved: Saved,
    now: number,
    values: ReadonlyMap<string, unknown>,
  ): DeviceView => {
    const cam = cameras.get(id);
    const n = (itemId: string) => {
      const v = values.get(itemId);
      return typeof v === "number" ? v : null;
    };
    const t = (itemId: string) => {
      const v = values.get(itemId);
      return typeof v === "string" ? v : null;
    };
    const charging = values.get("power.charging");
    return {
      id,
      name: `Agora R1 (${id})`,
      kind: "agora-r1",
      configured: id === device?.deviceId,
      online: d.online,
      lastSeenAt: iso(d.lastSeen),
      batteryPct: n("power.battery_pct"),
      charging: typeof charging === "boolean" ? charging : null,
      rssi: n("wifi.rssi"),
      signal: t("wifi.quality"),
      firmware: t("system.firmware"),
      mode: "satellite",
      mood: t("eye.mood"),
      muted: saved.muted[id] === true,
      earcons: saved.earconsOff[id] !== true,
      volume: n("audio.volume"),
      keys: Object.fromEntries(
        (Object.keys(R1_KEY_SLOTS) as Array<R1KeySlot>)
          .filter((slot) => typeof R1_KEY_SLOTS[slot] !== "object")
          .map((slot) => [slot, keyBindingOf(saved, id, slot)]),
      ),
      keyNote: d.keyRefused ? "The R1 refused the last button change." : null,
      display: d.display,
      transport: DEVICE_TRANSPORTS.includes(saved.transport[id]!)
        ? saved.transport[id]!
        : "inhouse",
      revertAt: iso(trials.get(id) ?? null),
      enrolling: (enrolling.get(id) ?? 0) > now,
      enrol: d.enrol,
      ota: d.ota,
      camera: {
        armedUntil: iso(cam?.armedUntil ?? null),
        shotAt: iso(cam?.shot?.at ?? null),
        line: cam?.line ?? (d.camera === null ? null : `Camera: ${d.camera}`),
      },
      lastTag: d.lastTag === null ? null : { uid: d.lastTag.uid, at: iso(d.lastTag.at)! },
      speaker: d.speaker === null ? null : { ...d.speaker, scannedAt: iso(d.speaker.scannedAt) },
      stages: stagesOf(d),
      log: d.log.map((l) => ({ at: iso(l.at)!, topic: l.topic, text: l.text })).toReversed(),
    };
  };

  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    device = yield* home.device;
    const key =
      device?.mqttUrl == null ? null : `${device.mqttUrl}|${device.mqttUser}|${device.mqttPass}`;
    if (key !== linkKey) {
      link?.close();
      link = null;
      linkKey = key;
      if (device?.mqttUrl != null)
        link = yield* broker.connect({
          url: device.mqttUrl,
          user: device.mqttUser,
          pass: device.mqttPass,
          onMessage: (topic, payload) => {
            Queue.offerUnsafe(incoming, { topic, payload });
          },
        });
    }
    for (const [id, until] of trials) if (until <= now) yield* revert(id);
    for (const [id, until] of enrolling)
      if (until <= now) {
        enrolling.delete(id);
        // A read the room loop stopped reporting is dropped; a summary stays until he closes it.
        const d = heard.get(id);
        if (d?.enrol != null && ["reading", "saving"].includes(d.enrol.phase)) d.enrol = null;
      }
    for (const [id, cam] of cameras) {
      if (cam.armedUntil !== null && cam.armedUntil <= now && cam.shot === null)
        cameras.set(id, {
          armedUntil: null,
          shot: null,
          line: "No picture arrived. The R1 posts pictures to its upload address, which must point at this server.",
        });
      else if (cam.shot !== null && cam.shot.at + SHOT_KEEP_MS <= now) cameras.delete(id);
    }
    for (const [askId, ask] of asks) {
      const picked = inbox._tag === "None" ? null : yield* inbox.value.promptAnswer(askId);
      if (picked === null && ask.until > now) continue;
      asks.delete(askId);
      if (picked === 0) yield* run(ask.id, ask.command, ask.by).pipe(Effect.ignore);
      else {
        if (inbox._tag === "Some") yield* inbox.value.closePrompt(askId);
        yield* audit(ask.by, ask.id, ask.line, picked === null ? "expired" : "denied");
      }
    }
  });

  // Item writes go out as `cmd/item/<id>`; the R1 acknowledges each on `state/item/ack`.
  yield* registry.attachWriter("mqtt", (id, itemId, value) =>
    Effect.as(publish(id, `cmd/item/${itemId}`, { value }), null),
  );

  yield* Queue.take(incoming).pipe(
    Effect.flatMap(({ topic, payload }) => handle(topic, payload)),
    Effect.ignoreCause({ log: true }),
    Effect.forever,
    Effect.forkIn(scope),
  );
  yield* tick.pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => link?.close()));

  return HomeDevices.of({
    overview: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const saved = yield* readSaved;
      const ids = new Set(heard.keys());
      if (device?.deviceId != null) ids.add(device.deviceId);
      const registered = yield* registry.list;
      const valuesOf = (id: string) =>
        new Map(
          (registered.find((r) => r.deviceId === id)?.values ?? []).map((v) => [v.itemId, v.value]),
        );
      return {
        broker: {
          state: link === null ? "off" : link.connected() ? "connected" : "connecting",
          host: device?.mqttUrl == null ? null : new URL(device.mqttUrl).hostname,
        },
        devices: [...ids].map((id) =>
          viewOf(id, heard.get(id) ?? blank(), saved, now, valuesOf(id)),
        ),
        tags: tagList(saved),
        pending: [...asks.entries()].map(([id, a]) => ({ id, line: a.line })),
        registry: registered,
      } satisfies DevicesOverview;
    }),
    command,
    assignTag: Effect.fn("HomeDevices.assignTag")(function* (uid, label, action) {
      yield* change((s) => {
        s.tags[uid.toLowerCase()] = { label, action };
      });
      return tagList(yield* readSaved);
    }),
    removeTag: Effect.fn("HomeDevices.removeTag")(function* (uid) {
      yield* change((s) => {
        delete s.tags[uid.toLowerCase()];
      });
      return tagList(yield* readSaved);
    }),
    cameraView: Effect.fn("HomeDevices.cameraView")((id: string) =>
      Effect.sync(() => {
        const shot = cameras.get(id)?.shot;
        return shot == null
          ? null
          : {
              at: iso(shot.at)!,
              dataUrl: `data:image/jpeg;base64,${Buffer.from(shot.bytes).toString("base64")}`,
            };
      }),
    ),
    cameraClear: Effect.fn("HomeDevices.cameraClear")((id: string) =>
      Effect.sync(() => void cameras.delete(id)),
    ),
    acceptShot: Effect.fn("HomeDevices.acceptShot")(function* (id, bytes) {
      const now = yield* Clock.currentTimeMillis;
      const cam = cameras.get(id);
      if (cam?.armedUntil == null || cam.armedUntil < now || bytes.length > MAX_SHOT_BYTES)
        return false;
      cameras.set(id, { armedUntil: null, shot: { at: now, bytes }, line: null });
      return true;
    }),
    receive: handle,
    tick,
  });
});

export const layer = Layer.effect(HomeDevices, make);
