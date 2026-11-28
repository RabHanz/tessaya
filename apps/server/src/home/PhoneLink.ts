/**
 * The phone route (`/api/tessel/phone?device=&phone=&name=`): PCM 16 kHz mono s16le both ways, the mic only after
 * `{"t":"listen","on":true}`; text up is `route` and `talk`, down `listen`, `flush`, `haptic`. Near its Tessel the
 * phone lends it ears and voice; otherwise it is a vessel of its own on the hub (`phone-<phone>`), same room loop.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";

import { BT_KINDS, type BtKind } from "@t3tools/tessaya-contracts";
import { renderHaptic, type HapticHardware } from "@t3tools/tessaya-shared/haptics";
import { isFlush, PHONE, PHONE_VESSEL, type PhoneLink } from "./HomeDevices.ts";

export const PHONE_LINK_PATH = "/api/tessel/phone";

/** 16 kHz mono s16le. */
const BYTES_PER_MS = 32;
/** Mic kept ahead of the R1's clock at most this long; older audio is dropped so he is never heard late. */
const MIC_KEEP_MS = 400;
/** The R1 stopped streaming this long ago: its session ended, so the phone's mic goes off. */
const LISTEN_IDLE_MS = 1_500;

/**
 * On the R1's own network: the phone's Wi-Fi address shares the R1's /24, or both reach this server from one address
 * (one home router, through the tunnel). Pure.
 */
// shortcut: a /24 and one public address say "home", not "this room"; a Bluetooth sighting would say the room.
export const nearBy = (
  r1Remote: string | null,
  phone: { readonly ip: string | null; readonly remote: string | null },
): boolean => {
  if (r1Remote === null) return false;
  const v4 = (a: string | null) => a?.replace(/^::ffff:/i, "") ?? null;
  const r1 = v4(r1Remote)!;
  if (v4(phone.remote) === r1) return true;
  const net = (a: string) => a.split(".").slice(0, 3).join(".");
  const ip = v4(phone.ip);
  return ip !== null && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && net(ip) === net(r1);
};

/** A mic jitter buffer: the phone pushes, the R1's frames pull the same length, silence where it ran dry. Pure. */
export const makeMicBuffer = (keepMs = MIC_KEEP_MS) => {
  let held = Buffer.alloc(0);
  return {
    push: (pcm: Uint8Array) => {
      held = Buffer.concat([held, pcm]);
      const max = keepMs * BYTES_PER_MS;
      if (held.length > max) held = held.subarray(held.length - max);
    },
    take: (bytes: number) => {
      const out = Buffer.alloc(bytes);
      const n = Math.min(bytes, held.length - (held.length % 2));
      held.copy(out, 0, 0, n);
      held = held.subarray(n);
      return out;
    },
  };
};

export interface PhoneRoute {
  readonly kind: BtKind;
  readonly name: string | null;
  readonly ip: string | null;
  /** The phone's motor, as its native player reports it; null: it cannot buzz. */
  readonly haptic: HapticHardware | null;
  /** Its feel-test correction (1: as designed). */
  readonly gain: number;
}

const PRIMITIVES: ReadonlyArray<unknown> = ["CLICK", "TICK", "THUD", "QUICK_RISE"];
const hardwareOf = (v: unknown): HapticHardware | null => {
  if (typeof v !== "object" || v === null) return null;
  const h = v as Record<string, unknown>;
  if (h["kind"] === "core-haptics") return { kind: "core-haptics" };
  if (h["kind"] !== "android") return null;
  const primitives = Array.isArray(h["primitives"])
    ? h["primitives"].filter((x): x is "CLICK" => PRIMITIVES.includes(x))
    : [];
  return { kind: "android", primitives, amplitude: h["amplitude"] === true };
};

/**
 * A moment of its body, in a Tessel's own words so her one nervous system reads it the same (HomeDevices, tesselMotion):
 * picked up, shaken, where it is now. Only moments leave the phone, never its sensor stream.
 */
export interface PhoneMoment {
  readonly tail: "event/motion" | "state/placement";
  readonly body: string;
}
const MOTION_KINDS: ReadonlyArray<unknown> = ["lift", "shake", "shake_long", "drop"];
// face_down: a Sleeve turned over (she has gone to another body); handheld: raised to him
const PLACEMENTS: ReadonlyArray<unknown> = ["desk", "dock", "handheld", "carried", "face_down"];

/** A message from the phone: its route, its headset's button or a moment of its body; null for anything else. */
export const parsePhoneText = (text: string): PhoneRoute | PhoneMoment | "talk" | null => {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (v["t"] === "talk") return "talk";
    if (v["t"] === "motion")
      return MOTION_KINDS.includes(v["kind"])
        ? {
            tail: "event/motion",
            body: JSON.stringify({ kind: v["kind"], conf: 1, intensity: 60 }),
          }
        : null;
    if (v["t"] === "placement")
      return PLACEMENTS.includes(v["placement"])
        ? { tail: "state/placement", body: JSON.stringify({ placement: v["placement"] }) }
        : null;
    if (v["t"] !== "route") return null;
    const kind = (BT_KINDS as ReadonlyArray<unknown>).includes(v["kind"])
      ? (v["kind"] as BtKind)
      : "speaker";
    const str = (x: unknown) => (typeof x === "string" && x.length <= 80 ? x : null);
    const gain = v["gain"];
    return {
      kind,
      name: str(v["name"]),
      ip: str(v["ip"]),
      haptic: hardwareOf(v["haptic"]),
      // The same bounds as gainFromFeel, so a phone cannot max or mute its motor.
      gain:
        typeof gain === "number" && Number.isFinite(gain) ? Math.min(2, Math.max(0.4, gain)) : 1,
    };
  } catch {
    return null;
  }
};

/** One mic frame up in the loop's raw form (60 ms): not the 16-byte upformat, so the loop reads it as plain PCM. */
const VESSEL_FRAME_BYTES = 1920;

/** The phone's hold on its own device id on the hub (R1Hub `vessel`). */
export interface VesselBinding {
  readonly publish: (tail: string, payload: string | Uint8Array) => void;
  readonly close: () => void;
}

/**
 * The phone as a vessel of its own, on the same contract as a Tessel: its mic goes up as `voice/up` while a session is
 * open (`cmd/voice/start` to `cmd/voice/stop`), `voice/down` plays on it, a `voice/ctl` flush stops it, and its
 * button publishes `cmd/voice/start`. Pure but for the hub binding and the phone it is given.
 */
export const makePhoneVessel = (io: {
  readonly bind: (deliver: (tail: string, payload: Buffer) => void) => VesselBinding;
  readonly play: (pcm: Uint8Array) => void;
  readonly flush: () => void;
  readonly listen: (on: boolean) => void;
}) => {
  let binding: VesselBinding | null = null;
  let listening = false;
  let held = Buffer.alloc(0);
  const listen = (on: boolean) => {
    if (on === listening) return;
    listening = on;
    held = Buffer.alloc(0);
    io.listen(on);
  };
  const deliver = (tail: string, payload: Buffer) => {
    if (tail === "voice/down") io.play(payload);
    else if (tail === "voice/ctl" && isFlush(payload)) io.flush();
    // The loop opens a session itself to say something (a job notice, an answer later): he may answer it.
    else if (tail === "cmd/voice/start") listen(true);
    else if (tail === "cmd/voice/stop") listen(false);
  };
  const set = (on: boolean) => {
    if (on && binding === null) binding = io.bind(deliver);
    else if (!on && binding !== null) {
      binding.close();
      binding = null;
      listen(false);
    }
  };
  return {
    bound: () => binding !== null,
    /** Bound while no Tessel is near; let go when one is, so the phone lends that Tessel its ears instead. */
    set,
    /** His button: a session on the phone itself. False when bound to no vessel (a Tessel near takes it). */
    talk: () => {
      if (binding === null) return false;
      listen(true);
      binding.publish("cmd/voice/start", "{}");
      return true;
    },
    /** His mic while a session is open, in whole frames. */
    mic: (pcm: Uint8Array) => {
      if (binding === null || !listening) return;
      held = Buffer.concat([held, pcm]);
      // The same bound as the Tessel route's jitter buffer: a backlog is dropped, never heard late.
      if (held.length > MIC_KEEP_MS * BYTES_PER_MS)
        held = held.subarray(held.length - MIC_KEEP_MS * BYTES_PER_MS);
      while (held.length >= VESSEL_FRAME_BYTES) {
        binding.publish("voice/up", held.subarray(0, VESSEL_FRAME_BYTES));
        held = held.subarray(VESSEL_FRAME_BYTES);
      }
    },
    listening: () => listening,
    /** A moment of its body, onto the hub as a Tessel's; nothing while a Tessel near has its ears. */
    moment: (m: PhoneMoment) => binding?.publish(m.tail, m.body),
  };
};

/**
 * One phone's socket: near its Tessel it feeds HomeDevices.phoneLink on open, on every route change, and on close;
 * with no Tessel near (or none named) it is bound to the hub as its own vessel.
 */
export const runPhoneSocket = Effect.fn("PhoneLink.runSocket")(function* (
  socket: Socket.Socket,
  input: {
    /** The Tessel it lends its ears to when near; null: none, so it is always its own vessel. */
    readonly r1: string | null;
    readonly phoneId: string;
    readonly name: string;
    readonly remote: string | null;
    readonly r1Remote: () => string | null;
    readonly changed: (link: PhoneLink, open: boolean) => Effect.Effect<void>;
    /** Its headset's button was pressed near its Tessel. */
    readonly talk: (link: PhoneLink) => Effect.Effect<void>;
    /** Binds `phone-<phone>` on the hub (R1Hub `vessel`). */
    readonly bindVessel: (
      id: string,
      deliver: (tail: string, payload: Buffer) => void,
    ) => VesselBinding;
    /** Its button pressed with no Tessel near: a session on the phone vessel (HomeDevices.vesselTalk). */
    readonly vesselTalk: (vessel: string, link: PhoneLink) => Effect.Effect<void>;
  },
) {
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  // Bounded: a phone that cannot keep up loses reply frames rather than growing the server's memory.
  const out = yield* Queue.bounded<Uint8Array | string>(256);
  const mic = makeMicBuffer();
  let listening = false;
  /** Half-second ticks since the R1's last mic frame asked for the phone's. */
  let idleTicks = 0;
  const say = (msg: object) => void Queue.offerUnsafe(out, JSON.stringify(msg));
  const vesselId = `${PHONE_VESSEL}${input.phoneId}`;
  const vessel = makePhoneVessel({
    bind: (deliver) => input.bindVessel(vesselId, deliver),
    play: (pcm) => void Queue.offerUnsafe(out, new Uint8Array(pcm)),
    flush: () => say({ t: "flush" }),
    listen: (on) => say({ t: "listen", on }),
  });
  const linkOf = (route: PhoneRoute): PhoneLink => ({
    id: `${PHONE}${input.phoneId}`,
    name: route.name === null ? input.name : `${input.name} (${route.name})`,
    kind: route.kind,
    near: input.r1 !== null && nearBy(input.r1Remote(), { ip: route.ip, remote: input.remote }),
    play: (pcm) => void Queue.offerUnsafe(out, new Uint8Array(pcm)),
    flush: () => say({ t: "flush" }),
    buzz: (pattern, level) => {
      if (route.haptic !== null)
        say({ t: "haptic", r: renderHaptic(route.haptic, pattern, level, route.gain) });
    },
    mic: (bytes) => {
      idleTicks = 0;
      if (!listening) {
        listening = true;
        say({ t: "listen", on: true });
      }
      return mic.take(bytes);
    },
  });
  let route: PhoneRoute = { kind: "speaker", name: null, ip: null, haptic: null, gain: 1 };
  let link = linkOf(route);
  /** Near its Tessel it lends that Tessel its ears; anywhere else it is a vessel of its own. */
  const relink = Effect.gen(function* () {
    if (input.r1 !== null) yield* input.changed(link, true);
    vessel.set(!link.near);
  });
  yield* relink;
  const read = Effect.forever(
    Effect.gen(function* () {
      for (const frame of yield* reader.pull) {
        if (typeof frame !== "string") {
          if (vessel.bound()) vessel.mic(frame);
          else if (listening) mic.push(frame);
          continue;
        }
        const next = parsePhoneText(frame);
        if (next === null) continue;
        if (next === "talk") {
          if (vessel.bound()) {
            yield* input.vesselTalk(vesselId, link);
            vessel.talk();
          } else yield* input.talk(link);
          continue;
        }
        if ("tail" in next) {
          vessel.moment(next);
          continue;
        }
        route = next;
        link = linkOf(route);
        yield* relink;
      }
    }),
  );
  let checks = 0;
  const quiet = Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(500);
      // The R1 may reconnect from elsewhere; every 10 s whether the phone is still on its network.
      if (++checks % 20 === 0 && linkOf(route).near !== link.near) {
        link = linkOf(route);
        yield* relink;
      }
      if (listening && ++idleTicks * 500 > LISTEN_IDLE_MS) {
        listening = false;
        if (!vessel.listening()) say({ t: "listen", on: false });
      }
    }),
  );
  const write = Effect.forever(Effect.flatMap(Queue.take(out), (m) => writer.write(m)));
  yield* Effect.raceFirst(read, Effect.raceFirst(write, quiet)).pipe(
    Effect.ignore,
    Effect.ensuring(
      Effect.suspend(() => {
        vessel.set(false);
        return input.r1 === null ? Effect.void : input.changed(link, false);
      }),
    ),
  );
  yield* writer.write(new Socket.CloseEvent(1000)).pipe(Effect.ignore);
});

/** The phone's own id from its query, kept to what a device id may be. */
export const phoneIdOf = (raw: string | null) =>
  Option.fromNullishOr(raw).pipe(Option.filter((s) => /^[\w.-]{1,80}$/.test(s)));
