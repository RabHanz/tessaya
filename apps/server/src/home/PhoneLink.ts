/**
 * The phone route (`/api/tessel/phone?device=&phone=&name=`): binary is her reply down and its mic up (PCM 16 kHz
 * mono s16le), the mic only after `{"t":"listen","on":true}`. Text up is `route` (kind, name, ip, haptic, gain) on
 * every change and `talk` for its headset's button; text down is `listen`, `flush` and `haptic` (a rendering for the
 * motor its route named). HomeDevices decides when the phone is used.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";

import { BT_KINDS, type BtKind } from "@t3tools/tessaya-contracts";
import { renderHaptic, type HapticHardware } from "@t3tools/tessaya-shared/haptics";
import { PHONE, type PhoneLink } from "./HomeDevices.ts";

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

/** A message from the phone: its route, or its headset's button; null for anything else. Its payload is data. */
export const parsePhoneText = (text: string): PhoneRoute | "talk" | null => {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (v["t"] === "talk") return "talk";
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

/** One phone's socket for one R1: feeds HomeDevices.phoneLink on open, on every route change, and on close. */
export const runPhoneSocket = Effect.fn("PhoneLink.runSocket")(function* (
  socket: Socket.Socket,
  input: {
    readonly r1: string;
    readonly phoneId: string;
    readonly name: string;
    readonly remote: string | null;
    readonly r1Remote: () => string | null;
    readonly changed: (link: PhoneLink, open: boolean) => Effect.Effect<void>;
    /** Its headset's button was pressed. */
    readonly talk: (link: PhoneLink) => Effect.Effect<void>;
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
  const linkOf = (route: PhoneRoute): PhoneLink => ({
    id: `${PHONE}${input.phoneId}`,
    name: route.name === null ? input.name : `${input.name} (${route.name})`,
    kind: route.kind,
    near: nearBy(input.r1Remote(), { ip: route.ip, remote: input.remote }),
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
  yield* input.changed(link, true);
  const read = Effect.forever(
    Effect.gen(function* () {
      for (const frame of yield* reader.pull) {
        if (typeof frame !== "string") {
          if (listening) mic.push(frame);
          continue;
        }
        const next = parsePhoneText(frame);
        if (next === null) continue;
        if (next === "talk") {
          yield* input.talk(link);
          continue;
        }
        route = next;
        link = linkOf(route);
        yield* input.changed(link, true);
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
        yield* input.changed(link, true);
      }
      if (listening && ++idleTicks * 500 > LISTEN_IDLE_MS) {
        listening = false;
        say({ t: "listen", on: false });
      }
    }),
  );
  const write = Effect.forever(Effect.flatMap(Queue.take(out), (m) => writer.write(m)));
  yield* Effect.raceFirst(read, Effect.raceFirst(write, quiet)).pipe(
    Effect.ignore,
    Effect.ensuring(input.changed(link, false)),
  );
  yield* writer.write(new Socket.CloseEvent(1000)).pipe(Effect.ignore);
});

/** The phone's own id from its query, kept to what a device id may be. */
export const phoneIdOf = (raw: string | null) =>
  Option.fromNullishOr(raw).pipe(Option.filter((s) => /^[\w.-]{1,80}$/.test(s)));
