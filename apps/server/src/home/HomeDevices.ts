// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off preferSchemaOverJson:off
/**
 * Tessaya's hardware devices, the Agora R1 first. One MQTT subscriber on the broker the R1's record names
 * (Settings → Home) keeps each device's status, and every control goes out from here as `freya/r1/<id>/...`, so no
 * client ever speaks MQTT. Camera and reboot asked by anyone but him become a phone card first.
 */
import * as NodeCrypto from "node:crypto";

import {
  DEVICE_TRANSPORTS,
  R1_MOODS,
  type DeviceStage,
  type DeviceTag,
  type DeviceTagAction,
  type DeviceTransport,
  type DeviceView,
  type DevicesOverview,
} from "@t3tools/baton-contracts";
import { recordText } from "@t3tools/baton-shared/audit";
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
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { connectMqtt } from "./Mqtt.ts";

export class DeviceRefusedError extends Schema.TaggedError<DeviceRefusedError>()(
  "DeviceRefusedError",
  { why: Schema.String },
) {}

/** settings is him in Settings → Devices (the RPC checked his scope); anyone else asks before camera or reboot. */
export interface DeviceActor {
  readonly who: string;
  readonly surface: "settings" | "agent" | "assistant";
}

export type DeviceCommand =
  | { readonly op: "eye"; readonly mood: (typeof R1_MOODS)[number]; readonly holdMs?: number }
  | { readonly op: "led"; readonly color: "green" | "red" | "standby" }
  | { readonly op: "vibrate"; readonly ms: number }
  | { readonly op: "say"; readonly text: string }
  | { readonly op: "mute"; readonly muted: boolean }
  | { readonly op: "transport"; readonly transport: DeviceTransport }
  | { readonly op: "transportConfirm" }
  | { readonly op: "transportRevert" }
  | { readonly op: "enrol"; readonly cancel: boolean }
  | { readonly op: "diag" }
  | { readonly op: "forget" }
  | { readonly op: "reboot" }
  | { readonly op: "camera" };

export interface DeviceOutcome {
  readonly status: "done" | "asked";
  readonly line: string;
}

/** Owner ops: never run for an agent without his yes. */
export const RISKY_OPS: ReadonlySet<DeviceCommand["op"]> = new Set(["reboot", "camera"]);

export const TRIAL_MS = 60_000;
export const CAMERA_WINDOW_MS = 30_000;
export const SHOT_KEEP_MS = 10 * 60_000;
export const ASK_TTL_MS = 10 * 60_000;
const ENROL_MS = 2 * 60_000;
const REARM_AFTER_MS = [2_000, 8_000, 18_000] as const;
export const MAX_SHOT_BYTES = 512 * 1024;
const LOG_KEEP = 40;
const SAMPLES_KEEP = 50;
const SETTINGS_KEY = "devices.state";

/** The room loop's per-turn metrics, in pipeline order. */
export const STAGES = [
  ["endpointMs", "End of speech"],
  ["asrMs", "Speech to text"],
  ["brainFirstMs", "Brain, first words"],
  ["ttsFirstMs", "Voice, first sound"],
  ["firstSoundMs", "Heard to first sound"],
] as const;

/** What the broker has told us about one device. */
export interface Heard {
  online: boolean | null;
  lastSeen: number | null;
  batteryPct: number | null;
  charging: boolean | null;
  rssi: number | null;
  signal: string | null;
  firmware: string | null;
  mood: string | null;
  ota: { phase: string; line: string } | null;
  camera: string | null;
  lastTag: { uid: string; at: number } | null;
  samples: Record<string, Array<number>>;
  log: Array<{ at: number; topic: string; text: string }>;
}

const blank = (): Heard => ({
  online: null,
  lastSeen: null,
  batteryPct: null,
  charging: null,
  rssi: null,
  signal: null,
  firmware: null,
  mood: null,
  ota: null,
  camera: null,
  lastTag: null,
  samples: {},
  log: [],
});

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

export const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/**
 * Folds one broker message into what we know of its device. Pure. Returns the device id and what the service must
 * react to: the device coming online (re-arm in-house voice) or a tag tapped. Payloads are the firmware's, so data.
 */
export const applyMessage = (
  devices: Map<string, Heard>,
  topic: string,
  payload: string,
  now: number,
): { readonly id: string; readonly cameOnline: boolean; readonly tag: string | null } | null => {
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
  let line = recordText(payload, 160);
  switch (rest) {
    case "state/online": {
      const up = payload.trim() === "1";
      cameOnline = up && d.online !== true;
      d.online = up;
      break;
    }
    case "state/battery": {
      const pct = Number.parseInt(payload, 10);
      if (Number.isFinite(pct) && pct >= 0) d.batteryPct = pct;
      break;
    }
    case "state/power":
      d.batteryPct =
        (num(body?.["battery_pct"]) ?? -1) >= 0 ? num(body?.["battery_pct"]) : d.batteryPct;
      if (typeof body?.["charging"] === "boolean") d.charging = body["charging"];
      break;
    case "state/wifi":
      d.rssi = num(body?.["rssi"]) ?? d.rssi;
      d.signal = str(body?.["quality"]) ?? d.signal;
      break;
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
      d.mood = str(body?.["mood"]) ?? (recordText(payload.trim(), 20) || d.mood);
      break;
    case "state/camera":
      d.camera = str(body?.["ev"]) ?? d.camera;
      break;
    case "event/announce":
    case "event/wake/boot":
      d.firmware = str(body?.["fw_ver"]) ?? str(body?.["fw"]) ?? d.firmware;
      break;
    case "event/nfc": {
      const uid = payload.trim();
      if (/^[0-9a-fA-F:]{4,40}$/.test(uid)) {
        tag = uid.toLowerCase();
        d.lastTag = { uid: tag, at: now };
      }
      break;
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
  return { id, cameOnline, tag };
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
  tags: Record<string, { label: string; action: DeviceTagAction }>;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export interface DeviceLink {
  readonly publish: (topic: string, payload: string) => void;
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
        publish: (topic: string, payload: string) => client.publish(topic, payload),
        connected: client.connected,
        close: client.close,
      };
    });
  }),
});

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
  const record = yield* Effect.serviceOption(BatonRecordService);
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
        tags: (value["tags"] ?? {}) as Saved["tags"],
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

  const publish = (id: string, path: string, payload: unknown) =>
    Effect.sync(() => {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      link?.publish(`freya/r1/${id}/${path}`, text);
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

  const handle = Effect.fn("HomeDevices.handle")(function* (topic: string, payload: string) {
    const now = yield* Clock.currentTimeMillis;
    const result = applyMessage(heard, topic, payload, now);
    if (result === null) return;
    if (result.cameOnline) yield* rearm(result.id).pipe(Effect.forkIn(scope));
    if (result.tag !== null) yield* runTag(result.id, result.tag);
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
    c.op === "camera" ? "take one camera picture" : c.op === "reboot" ? "restart the device" : c.op;

  const run = Effect.fn("HomeDevices.run")(function* (
    id: string,
    c: DeviceCommand,
    by: DeviceActor,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const done = (line: string): DeviceOutcome => ({ status: "done", line });
    switch (c.op) {
      case "eye":
        yield* publish(id, "cmd/eye/set", {
          mood: c.mood,
          priority: "sensor",
          hold_ms: Math.min(Math.max(c.holdMs ?? 6000, 500), 60_000),
        });
        return done(`The eyes show ${c.mood}.`);
      case "led":
        yield* publish(id, "cmd/led/set", { ...LED[c.color], mode: "solid" });
        return done(`The light is ${c.color}.`);
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
          yield* publish(id, "voice/enrol", { cancel: true });
          return done("Enrolment cancelled.");
        }
        enrolling.set(id, now + ENROL_MS);
        yield* publish(id, "voice/enrol", {});
        return done("Enrolling: speak to the device as it asks.");
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
        });
        if (device?.deviceId === id) yield* home.setDevice(null).pipe(Effect.ignore);
        return done("Forgotten. Set it up again in Settings → Home.");
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
    }
  });

  const command = Effect.fn("HomeDevices.command")(function* (
    id: string,
    c: DeviceCommand,
    by: DeviceActor,
  ): Effect.fn.Return<DeviceOutcome, DeviceRefusedError> {
    if (c.op !== "forget") yield* live(id);
    if (RISKY_OPS.has(c.op) && by.surface !== "settings") {
      const now = yield* Clock.currentTimeMillis;
      const askId = `device-${now.toString(36)}${(counter++ % 1296).toString(36)}`;
      const line = `${by.who} wants to ${describe(c)} on ${id}`;
      if (inbox._tag === "None")
        return yield* new DeviceRefusedError({
          why: "That needs the Director's yes, and his phone inbox is not here.",
        });
      yield* inbox.value.mirror({
        id: askId,
        title: "Tessaya wants to use the R1",
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

  const viewOf = (id: string, d: Heard, saved: Saved, now: number): DeviceView => {
    const cam = cameras.get(id);
    return {
      id,
      name: `Agora R1 (${id})`,
      kind: "agora-r1",
      configured: id === device?.deviceId,
      online: d.online,
      lastSeenAt: iso(d.lastSeen),
      batteryPct: d.batteryPct,
      charging: d.charging,
      rssi: d.rssi,
      signal: d.signal,
      firmware: d.firmware,
      mode: "satellite",
      mood: d.mood,
      muted: saved.muted[id] === true,
      transport: DEVICE_TRANSPORTS.includes(saved.transport[id]!)
        ? saved.transport[id]!
        : "inhouse",
      revertAt: iso(trials.get(id) ?? null),
      enrolling: (enrolling.get(id) ?? 0) > now,
      ota: d.ota,
      camera: {
        armedUntil: iso(cam?.armedUntil ?? null),
        shotAt: iso(cam?.shot?.at ?? null),
        line: cam?.line ?? (d.camera === null ? null : `Camera: ${d.camera}`),
      },
      lastTag: d.lastTag === null ? null : { uid: d.lastTag.uid, at: iso(d.lastTag.at)! },
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
    for (const [id, until] of enrolling) if (until <= now) enrolling.delete(id);
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
      return {
        broker: {
          state: link === null ? "off" : link.connected() ? "connected" : "connecting",
          host: device?.mqttUrl == null ? null : new URL(device.mqttUrl).hostname,
        },
        devices: [...ids].map((id) => viewOf(id, heard.get(id) ?? blank(), saved, now)),
        tags: tagList(saved),
        pending: [...asks.entries()].map(([id, a]) => ({ id, line: a.line })),
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
