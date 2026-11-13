// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off
/**
 * Firmware updates for the R1s on this server's hub, served by this server (R1-CONNECT-UNIVERSAL §4, §8.3): the pinned
 * image is downloaded once and checked, offered on a short-lived link, and installed only when the R1 is idle, with a
 * spoken notice before and after. An R1 that does not report the new version within 420 s gets the previous image
 * back, and that version is not tried again by itself.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { R1_FIRMWARE, type R1FirmwarePin } from "@t3tools/baton-shared/r1Firmware";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import { R1Hub } from "./R1Hub.ts";
import { R1Reach } from "./R1Reach.ts";

export const ROLLBACK_AFTER_MS = 420_000;
/** In use: anything it did in the last 5 minutes (a voice turn, a press). */
export const IDLE_MS = 5 * 60_000;
const TICKET_MS = 10 * 60_000;
export const R1_FIRMWARE_PATH = "/api/r1/firmware/";
const SAY_BEFORE = "I'm updating; back in a minute.";
const SAY_AFTER = "I've updated.";

export interface R1Watch {
  online: boolean;
  fw: string | null;
  lastUse: number;
  /** Something it did since the last pass; the pass stamps the time. */
  used: boolean;
  enrolling: boolean;
  bluetoothAudio: boolean;
  /** The install in flight: the version it should come back on, and whether this is already the way back. */
  update: { version: string; startedAt: number; rollback: boolean } | null;
  /** A version that failed here: not tried again by itself; he sees why. */
  stopped: { version: string; why: string } | null;
}

export const blankWatch = (): R1Watch => ({
  online: false,
  fw: null,
  lastUse: 0,
  used: false,
  enrolling: false,
  bluetoothAudio: false,
  update: null,
  stopped: null,
});

export type OtaStep = "wait" | "start" | "done" | "rollback" | "give-up";

/** What to do for one R1 now. Pure. */
export const otaStep = (
  w: R1Watch,
  pin: R1FirmwarePin | null,
  previous: R1FirmwarePin | null,
  now: number,
): OtaStep => {
  if (w.update !== null) {
    if (w.fw === w.update.version) return "done";
    if (now - w.update.startedAt < ROLLBACK_AFTER_MS) return "wait";
    return w.update.rollback || previous === null ? "give-up" : "rollback";
  }
  if (pin === null || !w.online || w.fw === null || w.fw === pin.version) return "wait";
  if (w.stopped?.version === pin.version) return "wait";
  if (w.enrolling || w.bluetoothAudio || now - w.lastUse < IDLE_MS) return "wait";
  return "start";
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export interface R1UpdateView {
  readonly pinned: string | null;
  readonly devices: ReadonlyArray<{
    readonly id: string;
    readonly firmware: string | null;
    readonly line: string;
  }>;
}

export class R1Updates extends Context.Service<
  R1Updates,
  {
    readonly view: Effect.Effect<R1UpdateView>;
    /** The image a ticketed link asks for, or null when the ticket is wrong or old. */
    readonly image: (file: string, ticket: string) => Effect.Effect<Uint8Array | null>;
    /** One pass over every R1; the layer runs it every 30 s. */
    readonly tick: Effect.Effect<void>;
  }
>()("t3/home/R1Updates") {}

const Kept = Schema.Struct({
  current: Schema.NullOr(Schema.Unknown),
  previous: Schema.NullOr(Schema.Unknown),
});
const decodeKept = Schema.decodeUnknownOption(Schema.fromJsonString(Kept));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.fn("R1Updates.make")(function* (options: {
  readonly pin: R1FirmwarePin | null;
  /** The image from our releases; the default is an HTTP GET. Null when it could not be had. */
  readonly download?: (url: string) => Effect.Effect<Uint8Array | null>;
}) {
  const hub = yield* R1Hub;
  const home = yield* HomeAssistantService;
  const reach = yield* R1Reach;
  const config = yield* ServerConfig.ServerConfig;
  const http = yield* HttpClient.HttpClient;
  const dir = NodePath.join(NodePath.dirname(config.dbPath), "r1-firmware");
  const keptFile = NodePath.join(dir, "kept.json");
  const download =
    options.download ??
    ((url: string) =>
      http.get(url).pipe(
        Effect.flatMap((r) => r.arrayBuffer),
        Effect.map((b): Uint8Array | null => new Uint8Array(b)),
        Effect.orElseSucceed(() => null),
      ));
  const watches = new Map<string, R1Watch>();
  const tickets = new Map<string, { readonly sha256: string; readonly until: number }>();
  const watchOf = (id: string) => {
    let w = watches.get(id);
    if (w === undefined) watches.set(id, (w = blankWatch()));
    return w;
  };

  // What the R1s say about themselves: online, their firmware, and anything that means he is using one.
  const link = hub.attach(
    [
      "freya/r1/+/state/online",
      "freya/r1/+/state/caps",
      "freya/r1/+/state/voice",
      "freya/r1/+/voice/up",
      "freya/r1/+/event/#",
      "freya/r1/+/voice/enrol",
      "freya/r1/+/state/bt",
    ],
    (topic, payload) => {
      const [, , id, ...rest] = topic.split("/");
      if (id === undefined) return;
      const what = rest.join("/");
      const w = watchOf(id);
      const text = payload.toString("utf8");
      const body = (() => {
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      if (what === "state/online") w.online = text !== "0";
      else if (what === "state/caps" && typeof body?.["fw"] === "string") w.fw = body["fw"];
      else if (what === "voice/enrol") w.enrolling = body?.["cancel"] !== true;
      else if (what === "state/bt") w.bluetoothAudio = body?.["streaming"] === true;
      else w.used = true;
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(link.close));

  const readKept = Effect.promise(() => NodeFSP.readFile(keptFile, "utf8").catch(() => "")).pipe(
    Effect.map((text) =>
      Option.match(decodeKept(text), {
        onNone: () => ({ current: null, previous: null }),
        onSome: (k) => ({
          current: k.current as R1FirmwarePin | null,
          previous: k.previous as R1FirmwarePin | null,
        }),
      }),
    ),
  );

  /** The pinned image on disk, checked; downloaded once. Records the one before it for a rollback. */
  const ensureImage = Effect.fn("R1Updates.ensureImage")(function* (pin: R1FirmwarePin) {
    const file = NodePath.join(dir, `${pin.sha256}.rbl`);
    const have = yield* Effect.promise(() => NodeFSP.readFile(file).catch(() => null));
    if (have !== null && sha256(have) === pin.sha256) return true;
    const bytes = yield* download(pin.url);
    if (bytes === null || bytes.length !== pin.size || sha256(bytes) !== pin.sha256) {
      yield* Effect.logWarning("R1 firmware image did not match its pin", {
        version: pin.version,
      });
      return false;
    }
    const kept = yield* readKept;
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(dir, { recursive: true });
      await NodeFSP.writeFile(file, bytes);
      const previous =
        kept.current !== null && kept.current.sha256 !== pin.sha256 ? kept.current : kept.previous;
      await NodeFSP.writeFile(keptFile, encodeJson({ current: pin, previous }));
    });
    return true;
  });

  const offer = Effect.fn("R1Updates.offer")(function* (id: string, image: R1FirmwarePin) {
    const base = (yield* reach.status).endpoints.proxy;
    if (base === "") return false;
    const ticket = NodeCrypto.randomBytes(16).toString("hex");
    tickets.set(ticket, {
      sha256: image.sha256,
      until: (yield* Clock.currentTimeMillis) + TICKET_MS,
    });
    hub.publish(
      `freya/r1/${id}/cmd/ota/start`,
      encodeJson({
        url: `${base}${R1_FIRMWARE_PATH}${image.sha256}.rbl?t=${ticket}`,
        sha256: image.sha256,
        size: image.size,
        // The release pipeline's signature, passed on as it came; the R1 checks it.
        sig: image.sig,
      }),
    );
    return true;
  });
  const say = (id: string, text: string) =>
    hub.publish(`freya/r1/${id}/voice/say`, encodeJson({ text }));

  // One pass at a time: a second must not start the same install while the first downloads.
  const lock = yield* Semaphore.make(1);
  const tick = lock.withPermits(1)(
    Effect.gen(function* () {
      const pin = options.pin;
      const now = yield* Clock.currentTimeMillis;
      for (const [t, v] of tickets) if (v.until <= now) tickets.delete(t);
      const kept = yield* readKept;
      for (const device of yield* home.devices) {
        // Only an R1 on this server's own hub fetches from this server.
        if (device.deviceId === null || device.mqttUrl !== null) continue;
        const id = device.deviceId;
        const w = watchOf(id);
        if (w.used) {
          w.used = false;
          w.lastUse = now;
        }
        const step = otaStep(w, pin, kept.previous, now);
        if (step === "start" && pin !== null) {
          if (!(yield* ensureImage(pin))) continue;
          say(id, SAY_BEFORE);
          if (yield* offer(id, pin))
            w.update = { version: pin.version, startedAt: now, rollback: false };
        } else if (step === "done") {
          if (w.update?.rollback === true && pin !== null)
            w.stopped = {
              version: pin.version,
              why: `${pin.version} did not come back within 7 minutes, so the R1 went back to ${w.fw}.`,
            };
          else say(id, SAY_AFTER);
          w.update = null;
        } else if (step === "rollback" && kept.previous !== null) {
          const failed = w.update?.version ?? "";
          if (yield* offer(id, kept.previous))
            w.update = { version: kept.previous.version, startedAt: now, rollback: true };
          w.stopped = {
            version: failed,
            why: `${failed} did not come back within 7 minutes; going back.`,
          };
        } else if (step === "give-up") {
          w.stopped = {
            version: pin?.version ?? w.update?.version ?? "",
            why: "The update did not finish and there was no earlier image to go back to.",
          };
          w.update = null;
        }
      }
    }),
  );

  yield* tick.pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.forkScoped,
  );

  return R1Updates.of({
    tick,
    view: Effect.gen(function* () {
      const devices = (yield* home.devices).filter(
        (d) => d.deviceId !== null && d.mqttUrl === null,
      );
      return {
        pinned: options.pin?.version ?? null,
        devices: devices.map((d) => {
          const w = watchOf(d.deviceId!);
          const line =
            w.update !== null
              ? `Updating to ${w.update.version}…`
              : w.stopped !== null
                ? w.stopped.why
                : options.pin === null || w.fw === options.pin.version
                  ? "Up to date."
                  : "An update installs when it has been idle for 5 minutes.";
          return { id: d.deviceId!, firmware: w.fw, line };
        }),
      };
    }),
    image: Effect.fn("R1Updates.image")(function* (file: string, ticket: string) {
      const t = tickets.get(ticket);
      const now = yield* Clock.currentTimeMillis;
      if (t === undefined || t.until <= now || file !== `${t.sha256}.rbl`) return null;
      const bytes = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(dir, file)).catch(() => null),
      );
      return bytes === null || sha256(bytes) !== t.sha256 ? null : new Uint8Array(bytes);
    }),
  });
});

export const layer = Layer.effect(R1Updates, make({ pin: R1_FIRMWARE })).pipe(
  Layer.provide(FetchHttpClient.layer),
);
