// @effect-diagnostics nodeBuiltinImport:off
/**
 * A spare phone as a room satellite, like the R1. The phone never speaks MQTT: it keeps one RPC stream to its server,
 * which opens a broker connection for that phone alone (on the broker the R1's record names, Settings → Home) and
 * relays the R1's device contract both ways under the phone's own id. Ids are always `phone-…`, so a phone can never
 * speak for an R1, and only the uplink topics the contract gives a device are accepted.
 */
import * as NodeCrypto from "node:crypto";

import type { CompanionDown, CompanionLinkInput, CompanionUpInput } from "@t3tools/baton-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { HomeAssistantService } from "./HomeAssistantService.ts";
import { DeviceRefusedError } from "./HomeDevices.ts";
import { connectMqtt } from "./Mqtt.ts";

export interface SatelliteLink {
  readonly publish: (topic: string, payload: Uint8Array | string, retain?: boolean) => void;
  readonly close: () => void;
}

/** The broker, behind a seam so tests run without a socket. */
export class SatelliteBroker extends Context.Service<
  SatelliteBroker,
  {
    readonly connect: (input: {
      readonly url: string;
      readonly user: string | null;
      readonly pass: string | null;
      readonly subscribe: ReadonlyArray<string>;
      readonly onMessage: (topic: string, payload: Uint8Array) => void;
    }) => Effect.Effect<SatelliteLink>;
  }
>()("t3/home/PhoneSatellite/SatelliteBroker") {}

export const brokerLayer = Layer.succeed(SatelliteBroker, {
  connect: Effect.fn("SatelliteBroker.connect")((input) =>
    Effect.sync((): SatelliteLink => {
      const url = new URL(input.url);
      const client = connectMqtt({
        host: url.hostname,
        port: Number(url.port || 1883),
        clientId: `tessaya-phone-${NodeCrypto.randomBytes(3).toString("hex")}`,
        ...(input.user === null ? {} : { user: input.user }),
        ...(input.pass === null ? {} : { pass: input.pass }),
        subscribe: input.subscribe,
        onMessage: (topic, payload) => input.onMessage(topic, payload),
        log: () => {},
      });
      return { publish: client.publish, close: client.close };
    }),
  ),
});

const json = (payload: Uint8Array): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** One message from the room for this phone, as the phone's screen needs it; null for what it ignores. */
export const downOf = (tail: string, payload: Uint8Array): CompanionDown | null => {
  switch (tail) {
    case "voice/down":
      return { kind: "audio", pcm: Buffer.from(payload).toString("base64") };
    case "cmd/voice/start":
      return { kind: "start" };
    case "cmd/voice/stop":
      return { kind: "stop" };
    case "voice/ctl":
      return json(payload)["ev"] === "flush" ? { kind: "flush" } : null;
    case "cmd/eye/set": {
      const mood = json(payload)["mood"];
      return typeof mood === "string" ? { kind: "face", mood: mood.slice(0, 40) } : null;
    }
    case "cmd/eye/persona": {
      const name = json(payload)["name"];
      return typeof name === "string" ? { kind: "persona", name: name.slice(0, 40) } : null;
    }
    default:
      return null;
  }
};

export class PhoneSatellite extends Context.Service<
  PhoneSatellite,
  {
    /** While the stream runs the phone is online in the room; it ends when the phone leaves companion mode. */
    readonly link: (input: CompanionLinkInput) => Stream.Stream<CompanionDown, DeviceRefusedError>;
    /** What the phone's microphone and sessions send, batched. */
    readonly up: (input: CompanionUpInput) => Effect.Effect<void, DeviceRefusedError>;
  }
>()("t3/home/PhoneSatellite") {}

export const make = Effect.gen(function* () {
  const home = yield* HomeAssistantService;
  const broker = yield* SatelliteBroker;
  const links = new Map<string, SatelliteLink>();

  const open = Effect.fn("PhoneSatellite.open")(function* (
    input: CompanionLinkInput,
    deliver: (down: CompanionDown) => void,
  ) {
    const device = yield* home.device;
    if (device?.mqttUrl == null)
      return yield* new DeviceRefusedError({
        why: "No broker is set up. Add the R1's broker in Settings → Home, then turn companion mode on again.",
      });
    const base = `freya/r1/${input.id}`;
    const link = yield* broker.connect({
      url: device.mqttUrl,
      user: device.mqttUser,
      pass: device.mqttPass,
      subscribe: [`${base}/voice/down`, `${base}/voice/ctl`, `${base}/cmd/#`],
      onMessage: (topic, payload) => {
        const down = downOf(topic.slice(base.length + 1), payload);
        if (down !== null) deliver(down);
      },
    });
    // A second link for the same phone (a reconnect) replaces the first.
    links.get(input.id)?.close();
    links.set(input.id, link);
    link.publish(`${base}/state/name`, input.name, true);
    link.publish(`${base}/state/online`, "1", true);
    return link;
  });

  return PhoneSatellite.of({
    link: (input) =>
      Stream.callback<CompanionDown, DeviceRefusedError>((queue) =>
        Effect.acquireRelease(
          open(input, (down) => Queue.offerUnsafe(queue, down)),
          (link) =>
            Effect.sync(() => {
              link.publish(`freya/r1/${input.id}/state/online`, "0", true);
              link.close();
              if (links.get(input.id) === link) links.delete(input.id);
            }),
        ).pipe(Effect.catch((error) => Queue.fail(queue, error))),
      ),
    up: Effect.fn("PhoneSatellite.up")(function* (input) {
      const link = links.get(input.id);
      if (link === undefined)
        return yield* new DeviceRefusedError({
          why: "This phone is not linked. Open companion mode again.",
        });
      for (const item of input.items) {
        const voice = item.topic === "voice/up" || item.topic === "voice/wake";
        link.publish(
          `freya/r1/${input.id}/${item.topic}`,
          voice ? new Uint8Array(Buffer.from(item.data, "base64")) : item.data,
        );
      }
    }),
  });
});

export const layer = Layer.effect(PhoneSatellite, make);
