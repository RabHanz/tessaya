// @effect-diagnostics globalJsonInEffect:off
/**
 * Where an R1 on this server's hub should connect: every one of his servers' hubs in his order (DeviceSync), each its
 * LAN then its tunnel, sent as `cmd/net/endpoints` whenever `state/net/endpoints` differs. Every server computes the
 * same list, so a device on a standby hub keeps the order and moves back to the first when it returns.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG } from "../cloud/config.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import type { DeviceHub } from "@t3tools/tessaya-contracts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { DeviceSync, HUBS_RECORD } from "./DeviceSync.ts";
import { R1Loop } from "./R1Loop.ts";
import { HomeAssistantService, r1ById } from "./HomeAssistantService.ts";
import { deviceSetting, R1_HUB_PATH, R1Hub } from "./R1Hub.ts";
import { DEVICE } from "@t3tools/tessaya-shared/productNames";

/** The firmware keeps four broker URLs of up to 96 characters (`r1bt_endpoints.c`). */
const EP_MAX = 4;
const EP_LEN = 96;
const AWAY_SECRET = "r1-away";
/** Set once he has answered the setup's one question about away-from-home, either way. */
const OFFERED_SECRET = "r1-away-offered";
/** The tunnel's hostname, remembered: cloudflared reports it only while connected, and a restart must not drop it. */
const TUNNEL_SECRET = "r1-tunnel-host";
/** The same list is not sent again sooner than this when the R1 does not take it (an older firmware). */
const RESEND_MS = 10 * 60_000;

export interface R1Endpoints {
  readonly broker: ReadonlyArray<string>;
  readonly proxy: string;
}

/**
 * This server's own hub addresses: its LAN entries (`http://<ip>:<port>/` bases) as hub URLs, then the tunnel when away
 * is on. A server with no LAN address (a cloud box) is reached only through its tunnel, so it gives that.
 */
export const ownHubUrls = (input: {
  readonly lan: ReadonlyArray<string>;
  readonly tunnelHost: string | null;
  readonly away: boolean;
}): Array<string> => [
  ...input.lan.map((base) => `${base.replace(/^http/, "ws").replace(/\/$/, "")}${R1_HUB_PATH}`),
  ...(input.tunnelHost !== null && (input.away || input.lan.length === 0)
    ? [`wss://${input.tunnelHost}${R1_HUB_PATH}`]
    : []),
];

/** Pictures go to this server: its first LAN base, else its tunnel. */
export const ownProxy = (input: {
  readonly lan: ReadonlyArray<string>;
  readonly tunnelHost: string | null;
  readonly away: boolean;
}): string =>
  input.lan[0]?.replace(/\/$/, "") ??
  (input.tunnelHost !== null ? `https://${input.tunnelHost}` : "");

/**
 * The device's list: his hubs in his order, then fallback brokers in what is left of the firmware's four. Every hub
 * gets one slot before any gets a second; cut short, a hub keeps its first address (its LAN), then its last (the
 * tunnel): kept alone, the tunnel's TLS starved her wake heap at home. The firmware moves back to the first entry.
 */
export const composeEndpoints = (input: {
  readonly hubs: ReadonlyArray<ReadonlyArray<string>>;
  readonly fallback: ReadonlyArray<string>;
  readonly proxy: string;
}): R1Endpoints => {
  const seen = new Set<string>();
  const fresh = (g: ReadonlyArray<string>) =>
    g.filter((u) => u.length <= EP_LEN && !seen.has(u) && (seen.add(u), true));
  const hubs = input.hubs.map(fresh).filter((g) => g.length > 0);
  const slots = hubs.map(() => 0);
  let left = EP_MAX;
  for (let i = 0; i < hubs.length && left > 0; i++, left--) slots[i] = 1;
  for (let i = 0; i < hubs.length && left > 0; i++) {
    const more = Math.min(left, hubs[i]!.length - slots[i]!);
    slots[i]! += more;
    left -= more;
  }
  const broker = [
    ...hubs.flatMap((g, i) =>
      slots[i]! >= g.length
        ? g
        : slots[i]! <= 1
          ? g.slice(0, slots[i])
          : [...g.slice(0, slots[i]! - 1), g.at(-1)!],
    ),
    ...fresh(input.fallback),
  ];
  return { broker: broker.slice(0, EP_MAX), proxy: input.proxy };
};

/**
 * The hubs she may be sent to, in his order: his first (home) hub always, so the device's home check can take her back
 * (19 Nov 07:16: on the standby its list had no home LAN, so she never went home), then only the others that say a
 * room loop hears her there (a loop-less hub, his laptop's, left her deaf; one too old to say is left out). All of
 * them when that leaves none.
 */
export const heardHubs = <H extends { readonly room?: boolean }>(hubs: ReadonlyArray<H>) => {
  const heard = hubs.filter((h, i) => i === 0 || h.room === true);
  return heard.length > 0 ? heard : hubs;
};

/**
 * His hub order for one device: the order he saved, then every other known hub by name. With no saved order, the hub
 * that holds its key first (where it was paired), so every server computes the same list without asking.
 */
export const hubOrder = (input: {
  readonly saved: ReadonlyArray<string> | null;
  readonly known: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly first: string;
}): Array<string> => {
  const ids = new Set(input.known.map((h) => h.id));
  const head = (input.saved ?? [input.first]).filter(
    (id, i, all) => ids.has(id) && all.indexOf(id) === i,
  );
  const rest = input.known
    .filter((h) => !head.includes(h.id))
    .toSorted((a, b) => a.label.localeCompare(b.label))
    .map((h) => h.id);
  return [...head, ...rest];
};

/** Whether what the R1 reports (`state/net/endpoints`) is already this list. Anything unreadable is not. */
export const reportMatches = (reported: string | undefined, want: R1Endpoints): boolean => {
  if (reported === undefined) return false;
  try {
    const r = JSON.parse(reported) as { broker?: unknown; proxy?: unknown };
    return (
      Array.isArray(r.broker) &&
      JSON.stringify(r.broker) === JSON.stringify(want.broker) &&
      (r.proxy ?? "") === want.proxy
    );
  } catch {
    return false;
  }
};

export interface R1ReachStatus {
  readonly away: boolean;
  /** He was asked at setup, or changed it since: setup asks only while this is false. */
  readonly offered: boolean;
  /** This server is linked to T3 Connect and has (or had) its tunnel's hostname. */
  readonly tunnel: boolean;
  readonly endpoints: R1Endpoints;
  readonly line: string;
}

export class R1Reach extends Context.Service<
  R1Reach,
  {
    readonly status: Effect.Effect<R1ReachStatus>;
    /** The one door for "Away from home": Settings, her voice, an agent with his yes, the phone card. */
    readonly setAway: (on: boolean) => Effect.Effect<R1ReachStatus>;
    /** His servers' hubs for one device, first choice first; empty when this server knows no other. */
    readonly hubs: (id: string) => Effect.Effect<ReadonlyArray<DeviceHub>>;
    /** His hub order for one device (environment ids, first choice first), kept on every server. */
    readonly setHubs: (id: string, order: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("t3/home/R1Reach") {}

const HubEntry = Schema.Struct({
  label: Schema.String.check(Schema.isMaxLength(80)),
  urls: Schema.Array(Schema.String.check(Schema.isMaxLength(EP_LEN))).check(Schema.isMaxLength(8)),
  /** Whether a room loop can hear her on that hub; absent from older servers, which are kept. */
  room: Schema.optionalKey(Schema.Boolean),
});
const decodeHub = Schema.decodeUnknownOption(HubEntry);
const decodeOrder = Schema.decodeUnknownOption(
  Schema.Array(Schema.String.check(Schema.isMaxLength(80))),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export const layer = Layer.effect(
  R1Reach,
  Effect.gen(function* () {
    const hub = yield* R1Hub;
    const home = yield* HomeAssistantService;
    const secrets = yield* ServerSecretStore;
    const direct = yield* Effect.serviceOption(DirectEndpoints);
    const runtime = yield* Effect.serviceOption(CloudManagedEndpointRuntime);
    const devices = yield* Effect.serviceOption(DeviceSync);
    const loop = yield* Effect.serviceOption(R1Loop);
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    const selfLabel = Option.isSome(environment)
      ? (yield* environment.value.getDescriptor).label
      : "this server";
    // shortcut: an operator list for a migration's old broker, read once; a setting if users ever need it.
    const fallback = (yield* deviceSetting("FALLBACK_BROKERS").pipe(Effect.orDie))
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");

    const reported = new Map<string, string>();
    const online = new Set<string>();
    const sent = new Map<string, { json: string; at: number }>();
    const wake = yield* Queue.sliding<string>(16);

    const read = (name: string) =>
      secrets.get(name).pipe(
        Effect.map(Option.map(text)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    const away = Effect.map(read(AWAY_SECRET), (v) => Option.getOrNull(v) === "on");

    const tunnelHost = Effect.gen(function* () {
      const linked = Option.isSome(
        yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG).pipe(Effect.orElseSucceed(Option.none)),
      );
      if (!linked) return null;
      const now = Option.isSome(runtime)
        ? ((yield* runtime.value.inspectConnector)?.hostname ?? null)
        : null;
      const kept = Option.getOrNull(yield* read(TUNNEL_SECRET));
      if (now !== null && now !== kept)
        yield* secrets.set(TUNNEL_SECRET, new TextEncoder().encode(now)).pipe(Effect.ignore);
      return now ?? kept;
    });

    /** The device's own list as it reported it: its first entry is the hub it was given as first choice. */
    const reportedOf = (id: string): { broker: Array<string>; current: string } => {
      try {
        const r = JSON.parse(reported.get(id) ?? "{}") as { broker?: unknown; current?: unknown };
        return {
          broker: Array.isArray(r.broker) ? r.broker.filter((u) => typeof u === "string") : [],
          current: typeof r.current === "string" ? r.current : "",
        };
      } catch {
        return { broker: [], current: "" };
      }
    };

    /** The list for one device (null: a device not paired yet), with his hubs in its order. */
    const compose = Effect.fn("R1Reach.compose")(function* (id: string | null) {
      const lan = Option.isSome(direct)
        ? (yield* direct.value.resolveAvailable())
            .filter((e) => e.kind === "lan")
            .map((e) => e.httpBaseUrl)
        : [];
      const host = yield* tunnelHost;
      const on = yield* away;
      const own = { lan, tunnelHost: host, away: on };
      const mine = ownHubUrls(own);
      const proxy = ownProxy(own);
      if (Option.isNone(devices))
        return {
          on,
          host,
          hubs: [] as Array<{ id: string; label: string; urls: ReadonlyArray<string> }>,
          order: [] as Array<string>,
          endpoints: composeEndpoints({ hubs: [mine], fallback, proxy }),
        };
      const s = devices.value;
      // This server's own entry, for his other servers to give the device; a no-op until it changes.
      const room = Option.isSome(loop) ? yield* loop.value.serves : true;
      yield* s.put(HUBS_RECORD, s.self, { label: selfLabel, urls: mine, room }, "changed");
      const known = Object.entries(yield* s.get(HUBS_RECORD)).flatMap(([env, stamp]) => {
        if (env === s.self) return [{ id: env, label: selfLabel, urls: mine, room }];
        const entry = decodeHub(stamp.v);
        return Option.isSome(entry) ? [{ id: env, ...entry.value }] : [];
      });
      const record = id === null ? {} : yield* s.get(id);
      const saved = record["hubs"] === undefined ? null : decodeOrder(record["hubs"].v);
      const givenFirst =
        id === null
          ? undefined
          : known.find((h) => h.urls.includes(reportedOf(id).broker[0] ?? ""));
      const order = hubOrder({
        saved: saved === null ? null : Option.getOrNull(saved),
        known,
        first: givenFirst?.id ?? record["key"]?.by ?? s.self,
      });
      const hubs = order.flatMap((env) => known.filter((h) => h.id === env));
      return {
        on,
        host,
        hubs,
        order,
        endpoints: composeEndpoints({ hubs: heardHubs(hubs).map((h) => h.urls), fallback, proxy }),
      };
    });

    /** Sends the list to one R1 on this hub when it reports another. Only the R1 this server's record names. */
    const sync = Effect.fn("R1Reach.sync")(function* (id: string) {
      const device = r1ById(yield* home.devices, id);
      if (device === null || device.mqttUrl !== null || !online.has(id)) return;
      const { endpoints } = yield* compose(id);
      if (endpoints.broker.length === 0 || reportMatches(reported.get(id), endpoints)) return;
      const json = yield* encodeJson(endpoints).pipe(Effect.orDie);
      const now = yield* Clock.currentTimeMillis;
      const last = sent.get(id);
      if (last !== undefined && last.json === json && now - last.at < RESEND_MS) return;
      sent.set(id, { json, at: now });
      hub.publish(`freya/r1/${id}/cmd/net/endpoints`, json);
    });

    const link = hub.attach(
      ["freya/r1/+/state/online", "freya/r1/+/state/net/endpoints"],
      (topic, payload) => {
        const [, , id, , what] = topic.split("/");
        if (id === undefined) return;
        if (what === "online") {
          if (payload.toString("utf8") === "0") online.delete(id);
          else online.add(id);
        } else reported.set(id, payload.toString("utf8"));
        Queue.offerUnsafe(wake, id);
      },
    );
    yield* Effect.addFinalizer(() => Effect.sync(link.close));
    yield* Queue.take(wake).pipe(
      Effect.flatMap(sync),
      Effect.ignoreCause({ log: true }),
      Effect.forever,
      Effect.forkScoped,
    );
    // A DHCP change or a relink is noticed here; the list is compared, not resent, so this is cheap.
    yield* Effect.forEach([...online], sync, { discard: true }).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );

    const status = Effect.gen(function* () {
      const { on, host, endpoints } = yield* compose(null);
      const line = !on
        ? `Home only: the ${DEVICE} connects to this server on your network.`
        : host === null
          ? `Away from home is on, but this server is not linked to T3 Connect. Link it in Settings → Connections; the ${DEVICE} gets the new address by itself.`
          : `The ${DEVICE} connects at home first, and through T3 Connect when it is away.`;
      const offered = Option.isSome(yield* read(OFFERED_SECRET));
      return {
        away: on,
        offered,
        tunnel: host !== null,
        endpoints,
        line,
      } satisfies R1ReachStatus;
    });

    return R1Reach.of({
      status,
      setAway: Effect.fn("R1Reach.setAway")(function* (on: boolean) {
        yield* secrets
          .set(AWAY_SECRET, new TextEncoder().encode(on ? "on" : "off"))
          .pipe(Effect.ignore);
        yield* secrets.set(OFFERED_SECRET, new TextEncoder().encode("yes")).pipe(Effect.ignore);
        sent.clear();
        yield* Effect.forEach([...online], sync, { discard: true });
        return yield* status;
      }),
      hubs: Effect.fn("R1Reach.hubs")(function* (id: string) {
        const { hubs } = yield* compose(id);
        const current = reportedOf(id).current;
        return hubs.length < 2
          ? []
          : hubs.map((h) => ({ ...h, urls: [...h.urls], current: h.urls.includes(current) }));
      }),
      setHubs: Effect.fn("R1Reach.setHubs")(function* (id: string, order: ReadonlyArray<string>) {
        if (Option.isNone(devices)) return;
        yield* devices.value.put(id, "hubs", order.slice(0, 8), "changed");
        sent.delete(id);
        yield* sync(id);
      }),
    });
  }),
);
