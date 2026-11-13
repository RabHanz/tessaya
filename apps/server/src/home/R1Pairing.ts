// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pairing an R1 with this server: claim (a new R1 shows a one-time key; the server makes its device key and seals it,
 * with the addresses, so only that R1 can open it) and rotate (a new key over the live link, the old one kept until
 * the R1 logs in with the new). Forget is HomeDevices' `forget`, which also closes the R1's hub link.
 */
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { DeviceRefusedError } from "./DeviceRegistry.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import { R1Hub } from "./R1Hub.ts";
import { R1Reach, type R1Endpoints } from "./R1Reach.ts";

const DEVICE_ID = /^[A-Za-z0-9_-]{1,60}$/;
/** A key use from another machine this recent makes a rotation ask first. */
const OUTSIDE_RECENT_MS = 30 * 24 * 60 * 60_000;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const claimKey = (oneTimeKey: string, deviceId: string) =>
  Buffer.from(NodeCrypto.hkdfSync("sha256", oneTimeKey, deviceId, "tessaya-r1-claim", 32));

/**
 * The provisioning blob: AES-256-GCM under HKDF-SHA256(one-time key, salt = device id, info "tessaya-r1-claim"), as
 * base64 of iv (12) | ciphertext | tag (16). The firmware's setup link opens it with the key on its eye.
 */
export const sealClaim = (oneTimeKey: string, deviceId: string, plain: string): string => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", claimKey(oneTimeKey, deviceId), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
};

/** The firmware's side of `sealClaim`, for tests and the bench; null when the key or the blob is wrong. */
export const openClaim = (oneTimeKey: string, deviceId: string, blob: string): string | null => {
  try {
    const bytes = Buffer.from(blob, "base64");
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      claimKey(oneTimeKey, deviceId),
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
};

export interface R1Claimed {
  readonly deviceId: string;
  /** For the app to hand to the R1 with the Wi-Fi details; it cannot read it. */
  readonly blob: string;
  readonly endpoints: R1Endpoints;
}

export class R1Pairing extends Context.Service<
  R1Pairing,
  {
    readonly claim: (input: {
      readonly deviceId: string;
      readonly oneTimeKey: string;
    }) => Effect.Effect<R1Claimed, DeviceRefusedError>;
    /** `confirmed`: he saw the warning that something on another machine uses the key. */
    readonly rotate: (
      id: string,
      confirmed: boolean,
    ) => Effect.Effect<
      { readonly status: "done" | "confirm"; readonly line: string },
      DeviceRefusedError
    >;
  }
>()("t3/home/R1Pairing") {}

const refuse = (why: string) => new DeviceRefusedError({ why });

export const layer = Layer.effect(
  R1Pairing,
  Effect.gen(function* () {
    const home = yield* HomeAssistantService;
    const hub = yield* R1Hub;
    const reach = yield* R1Reach;
    const newKey = () => NodeCrypto.randomBytes(32).toString("hex");
    const store = (device: Parameters<typeof home.setDevice>[0]) =>
      home.setDevice(device).pipe(Effect.mapError((e) => refuse(e.why)));

    return R1Pairing.of({
      claim: Effect.fn("R1Pairing.claim")(function* ({ deviceId, oneTimeKey }) {
        if (!DEVICE_ID.test(deviceId)) return yield* refuse("That is not an R1 id.");
        if (oneTimeKey.length < 6) return yield* refuse("That is not the code on the R1's eye.");
        const current = yield* home.device;
        // shortcut: one R1 per server until per-device records land (next PR).
        if (current !== null && current.deviceId !== deviceId)
          return yield* refuse(
            `This server already has ${current.deviceId ?? "an R1"}. Forget it in Settings → Hardware first.`,
          );
        const key = newKey();
        yield* store({ deviceKey: key, deviceId, mqttUrl: null, mqttUser: null, mqttPass: null });
        // A claimed again R1 (reset, re-paired) must not keep a link made with its old key.
        hub.dropDevice(deviceId);
        const { endpoints } = yield* reach.status;
        return {
          deviceId,
          blob: sealClaim(oneTimeKey, deviceId, encodeJson({ deviceId, key, ...endpoints })),
          endpoints,
        };
      }),
      rotate: Effect.fn("R1Pairing.rotate")(function* (id, confirmed) {
        const device = yield* home.device;
        if (device === null || device.deviceId !== id)
          return yield* refuse(`${id} is not set up on this server.`);
        if (device.mqttUrl !== null || !hub.connected(id))
          return yield* refuse(
            "The R1 must be online on this server to take a new key. Try again once it shows online.",
          );
        if (device.previousKey != null)
          return yield* refuse(
            "The last new key has not reached the R1 yet. Wait until it reconnects, then try again.",
          );
        const outside = hub.keyUsedOutside();
        const now = yield* Clock.currentTimeMillis;
        if (!confirmed && outside !== null && now - outside < OUTSIDE_RECENT_MS)
          return {
            status: "confirm",
            line: "Something on another machine (a room loop or another server) uses this R1's key. After a new key it stops working until it gets the new one. Rotate anyway?",
          };
        const key = newKey();
        yield* store({ ...device, deviceKey: key, previousKey: device.deviceKey });
        hub.publish(`freya/r1/${id}/cmd/net/key`, encodeJson({ key }));
        return {
          status: "done",
          line: "The R1 gets a new key. The old one stops working once it logs in with the new one.",
        };
      }),
    });
  }),
);
