/**
 * Where an R1 on this server's hub should connect, kept current by the server: its LAN addresses first, then the T3
 * Connect tunnel when "Away from home" is on. The list goes to the R1 as `cmd/net/endpoints` whenever what it reports
 * on `state/net/endpoints` differs (a DHCP change, the setting, a relink), so the user never re-pairs.
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
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import { HomeAssistantService, r1ById } from "./HomeAssistantService.ts";
import { deviceSetting, R1_HUB_PATH, R1Hub } from "./R1Hub.ts";
import { DEVICE } from "@t3tools/baton-shared/productNames";

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
 * The list for the R1: LAN entries (`http://<ip>:<port>/` bases) as hub URLs, then the tunnel when away is on, then
 * any fallback brokers (a migration's old broker). The tail is kept; LAN entries give way to it.
 */
export const composeEndpoints = (input: {
  readonly lan: ReadonlyArray<string>;
  readonly tunnelHost: string | null;
  readonly away: boolean;
  readonly fallback: ReadonlyArray<string>;
}): R1Endpoints => {
  const lan = input.lan.map(
    (base) => `${base.replace(/^http/, "ws").replace(/\/$/, "")}${R1_HUB_PATH}`,
  );
  const tunnel =
    input.away && input.tunnelHost !== null ? [`wss://${input.tunnelHost}${R1_HUB_PATH}`] : [];
  const tail = [...tunnel, ...input.fallback].slice(0, EP_MAX - 1);
  const broker = [...lan.slice(0, EP_MAX - tail.length), ...tail].filter((u) => u.length <= EP_LEN);
  const proxy =
    input.lan[0]?.replace(/\/$/, "") ?? (tunnel.length > 0 ? `https://${input.tunnelHost}` : "");
  return { broker, proxy };
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
  }
>()("t3/home/R1Reach") {}

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

    const compose = Effect.gen(function* () {
      const lan = Option.isSome(direct)
        ? (yield* direct.value.resolveAvailable())
            .filter((e) => e.kind === "lan")
            .map((e) => e.httpBaseUrl)
        : [];
      const host = yield* tunnelHost;
      const on = yield* away;
      return {
        on,
        host,
        endpoints: composeEndpoints({ lan, tunnelHost: host, away: on, fallback }),
      };
    });

    /** Sends the list to one R1 on this hub when it reports another. Only the R1 this server's record names. */
    const sync = Effect.fn("R1Reach.sync")(function* (id: string) {
      const device = r1ById(yield* home.devices, id);
      if (device === null || device.mqttUrl !== null || !online.has(id)) return;
      const { endpoints } = yield* compose;
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
      const { on, host, endpoints } = yield* compose;
      const line = !on
        ? `Home only: the ${DEVICE} connects to this server on your network.`
        : host === null
          ? `Away from home is on, but this server is not linked to T3 Connect. Link it in Settings → Connections; the ${DEVICE} gets the new address by itself.`
          : `The ${DEVICE} connects at home first, and through T3 Connect when it is away.`;
      const offered = Option.isSome(yield* read(OFFERED_SECRET));
      return { away: on, offered, tunnel: host !== null, endpoints, line } satisfies R1ReachStatus;
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
    });
  }),
);
