// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off globalJsonInEffect:off
/**
 * Home Assistant stays the house's brain: one WebSocket feeds a cache that never streams to clients, and every write
 * is risk-checked (`homeRisk`), snapshotted with HA's `scene.create` for undo, and logged to the Record and HA's logbook.
 * Temporary automations carry a time condition too, so they go inert on time even with this server down.
 */
import * as NodeCrypto from "node:crypto";
import type {
  HomeActionRow,
  HomeAutomationKind,
  HomeAutomationRow,
  HomeEntity,
  HomeOutcome,
  HomeStatus,
} from "@t3tools/baton-contracts";
import { PROMPT_TTL_MS } from "@t3tools/baton-shared/phoneRelay";
import { recordText } from "@t3tools/baton-shared/audit";
import { isDeviceRule } from "@t3tools/baton-shared/deviceRules";
import {
  actionCalls,
  higherTier,
  homeRisk,
  type HomeEntityFacts,
  type HomeOverrides,
  type HomeTier,
  type HomeVerdict,
} from "@t3tools/baton-shared/homeRisk";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BatonHomeCallResult } from "@t3tools/baton-contracts";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { BatonPhoneInbox } from "../baton/BatonPhoneInbox.ts";
import { BatonRecordService } from "../baton/BatonRecordService.ts";
import {
  HomeAssistantConnection,
  isHomeCallError,
  type HomeCallError,
  type HomeLink,
} from "./HomeAssistantConnection.ts";

export const TOKEN_SECRET = "home-assistant-token";
/** Before several R1s: one record. Read when DEVICES_SECRET is missing, and kept as the first R1 for a rollback. */
const DEVICE_SECRET = "r1-device";
const DEVICES_SECRET = "r1-devices";
const MAX_R1 = 16;
const R1_ID = /^[A-Za-z0-9_-]{1,60}$/;
const URL_KEY = "home.url";
/** A second address for the same Home Assistant (another route to the house), tried when the first is unreachable. */
const FALLBACK_KEY = "home.fallbackUrl";
const OVERRIDES_KEY = "home.overrides";
export const DONE_EVENT = "tessaya_automation_done";
const LABEL = "Tessaya";
const UNDO_KEEP_MS = 24 * 3_600_000;
/** An undo snapshot's scene id: this, then the action id, whose first part is its time in base 36. */
const UNDO_PREFIX = "tessaya_undo_";
const DELETED_KEEP_MS = 7 * 86_400_000;
const SCRATCH_MS = 24 * 3_600_000;
const TICK = "5 seconds";
/** Domains whose state a scene snapshot can put back. */
const RESTORABLE = new Set([
  "light",
  "fan",
  "switch",
  "input_boolean",
  "input_number",
  "input_select",
  "input_text",
  "cover",
  "climate",
  "media_player",
  "number",
  "select",
  "humidifier",
  "lock",
  "valve",
  "siren",
  "water_heater",
  "vacuum",
]);
/** Attributes worth a model's glance; the rest stay in the cache. */
const KEY_ATTRIBUTES = [
  "device_class",
  "unit_of_measurement",
  "brightness",
  "color_temp_kelvin",
  "percentage",
  "temperature",
  "current_temperature",
  "hvac_mode",
  "hvac_action",
  "media_title",
  "volume_level",
  "current_position",
  "preset_mode",
];

export class HomeRefusedError extends Schema.TaggedError<HomeRefusedError>()("HomeRefusedError", {
  /** A sentence for a person: why it was not done. */
  why: Schema.String,
}) {
  override get message(): string {
    return this.why;
  }
}

export type HomeSurface = "assistant" | "agent" | "r1" | "settings" | "standing" | "phone";
export interface HomeActor {
  readonly who: string;
  readonly surface: HomeSurface;
  /** His yes was already given through his own gate (spoken or clicked on the desktop). Never true from the R1. */
  readonly approved?: boolean;
  /** The tool suite's pretend R1: checked and judged as for real, then nothing is written, asked or run. */
  readonly dryRun?: boolean;
}

export interface HomeCallRequest {
  readonly domain: string;
  readonly service: string;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly why: string;
}

export interface HomeAutomationInput {
  /** Replace this automation; omitted for a new one. */
  readonly id?: string;
  readonly alias: string;
  readonly description?: string;
  readonly kind: HomeAutomationKind;
  /** A one-off delay: the server sets a time trigger this far ahead, runs it once and removes it. */
  readonly runInMinutes?: number;
  readonly expiresInMinutes?: number;
  readonly expiresAt?: string;
  readonly once?: boolean;
  readonly triggers?: ReadonlyArray<unknown>;
  readonly conditions?: ReadonlyArray<unknown>;
  readonly actions: ReadonlyArray<unknown>;
  readonly mode?: string;
  /** His words, quoted in the description and the Record. */
  readonly request: string;
}

/**
 * The R1's own settings, kept whole in the secret store: its key to reach Tessaya and the broker it listens on. No
 * broker means this server's own hub (`R1Hub`).
 */
export interface R1Device {
  readonly deviceKey: string;
  readonly mqttUrl: string | null;
  readonly mqttUser: string | null;
  readonly mqttPass: string | null;
  readonly deviceId: string | null;
  /** The password the R1 already logs in with, when it is not the device key (an R1 moved from a broker of its own). */
  readonly devicePass?: string | null;
  /** The key before a rotation, accepted until the R1 first logs in with the new one. */
  readonly previousKey?: string | null;
}

export class HomeAssistantService extends Context.Service<
  HomeAssistantService,
  {
    readonly status: Effect.Effect<HomeStatus>;
    /** The house's own time zone from Home Assistant's config ("UTC" until connected), for anything said aloud. */
    readonly timeZone: Effect.Effect<string>;
    /** Validates first (an admin user, since automations need one), then stores the token in the secret store. */
    readonly connect: (input: {
      readonly url: string;
      readonly fallbackUrl?: string;
      readonly token: string;
    }) => Effect.Effect<HomeStatus, HomeRefusedError>;
    readonly disconnect: Effect.Effect<HomeStatus>;
    readonly find: (input: {
      readonly text?: string;
      readonly area?: string;
      readonly domain?: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<HomeEntity>, HomeRefusedError>;
    readonly state: (entityId: string) => Effect.Effect<HomeEntity | null, HomeRefusedError>;
    readonly history: (
      entityId: string,
      since: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly at: string; readonly state: string }>,
      HomeRefusedError
    >;
    readonly services: (domain?: string) => Effect.Effect<unknown, HomeRefusedError>;
    readonly call: (
      request: HomeCallRequest,
      by: HomeActor,
    ) => Effect.Effect<HomeOutcome, HomeRefusedError>;
    /** Undo a call by its undo id, or the last change to an automation by its id. */
    readonly undo: (id: string, by: HomeActor) => Effect.Effect<HomeOutcome, HomeRefusedError>;
    readonly saveAutomation: (
      input: HomeAutomationInput,
      by: HomeActor,
    ) => Effect.Effect<HomeOutcome, HomeRefusedError>;
    readonly setAutomation: (
      input: { readonly id: string; readonly op: "pause" | "resume" | "delete" },
      by: HomeActor,
    ) => Effect.Effect<HomeOutcome, HomeRefusedError>;
    readonly automations: (input: {
      readonly all?: boolean;
    }) => Effect.Effect<ReadonlyArray<HomeAutomationRow>, HomeRefusedError>;
    readonly actions: (limit: number) => Effect.Effect<ReadonlyArray<HomeActionRow>>;
    /** What waits for his yes. */
    readonly pending: Effect.Effect<ReadonlyArray<HomeActionRow>>;
    /** His yes or no to one that waited; runs it on yes. */
    readonly answer: (id: string, yes: boolean) => Effect.Effect<HomeOutcome, HomeRefusedError>;
    readonly overrides: Effect.Effect<HomeOverrides>;
    readonly setOverride: (entityId: string, tier: HomeTier | null) => Effect.Effect<HomeOverrides>;
    /** Every R1 set up here, with its key. Never sent to a client. */
    readonly devices: Effect.Effect<ReadonlyArray<R1Device>>;
    /** The first R1, for what needs only one (warming the room's brain). */
    readonly device: Effect.Effect<R1Device | null>;
    /** Adds an R1, or replaces the one with its id. */
    readonly putDevice: (
      device: R1Device,
    ) => Effect.Effect<{ readonly configured: boolean }, HomeRefusedError>;
    /** Removes one R1 by id, or every R1 for null. */
    readonly removeDevice: (id: string | null) => Effect.Effect<{ readonly configured: boolean }>;
    /** One pass of the sweep and the approval check; the layer runs it on its own clock. */
    readonly tick: Effect.Effect<void>;
  }
>()("t3/home/HomeAssistantService") {}

/** What a toggle script may flip, each with its own idempotent turn_on and turn_off. */
const SWITCHED: ReadonlySet<string> = new Set(["fan", "light", "switch", "input_boolean"]);

interface Cached {
  s: string;
  a: Record<string, unknown>;
}
interface EntityEntry {
  readonly name: string | null;
  readonly areaId: string | null;
  readonly deviceId: string | null;
  readonly aliases: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
  readonly disabled: boolean;
}
interface ActionRow {
  readonly id: string;
  readonly at: number;
  readonly actor: string;
  readonly surface: string;
  readonly why: string;
  readonly request: string;
  readonly status: string;
  readonly tier: string;
  readonly reasons: string;
  readonly undo_scene: string | null;
  readonly prompt_id: string | null;
  readonly expires_at: number;
  readonly line: string;
}
interface AutomationRowDb {
  readonly id: string;
  readonly kind: string;
  readonly expires_at: number | null;
  readonly once: number;
  readonly actor: string;
  readonly surface: string;
  readonly request: string;
  readonly config: string;
  readonly previous: string | null;
  readonly last_op: string;
  readonly status: string;
}
/** What an approval runs on his yes. */
type Later =
  | { readonly type: "call"; readonly request: HomeCallRequest }
  | { readonly type: "undo"; readonly id: string }
  | { readonly type: "automationSave"; readonly input: HomeAutomationInput }
  | {
      readonly type: "automationSet";
      readonly input: { id: string; op: "pause" | "resume" | "delete" };
    };

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asList = (value: unknown): ReadonlyArray<string> =>
  value === undefined || value === null
    ? []
    : (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");
const short = (value: unknown, max = 80): string => {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
const iso = (ms: number) => new Date(ms).toISOString();

const SETTLE_MS = 3_000;
const SETTLE_STEP_MS = 250;
/** The state a call should leave its entities in, as a test of one; null where it cannot be told. */
const expectedAfter = (request: {
  readonly domain: string;
  readonly service: string;
  readonly data?: unknown;
}): ((entity: { s: string; a: Record<string, unknown> }) => boolean) | null => {
  const data = asRecord(request.data);
  const is =
    (...states: ReadonlyArray<string>) =>
    (e: { s: string }) =>
      states.includes(e.s);
  if (request.domain === "fan" && request.service === "set_percentage")
    return (e) =>
      Number(e.a["percentage"]) === Number(data["percentage"]) ||
      (data["percentage"] === 0 && e.s === "off");
  if (request.domain === "climate" && request.service === "set_hvac_mode")
    return is(String(data["hvac_mode"]));
  if (
    request.domain === "climate" &&
    request.service === "set_temperature" &&
    data["temperature"] !== undefined
  )
    return (e) => Number(e.a["temperature"]) === Number(data["temperature"]);
  if (request.domain === "cover")
    return request.service === "open_cover"
      ? is("open", "opening")
      : request.service === "close_cover"
        ? is("closed", "closing")
        : null;
  if (request.domain === "lock")
    return request.service === "lock"
      ? is("locked", "locking")
      : request.service === "unlock"
        ? is("unlocked", "unlocking", "open")
        : null;
  if (SWITCHED.has(request.domain) || request.domain === "media_player")
    return request.service === "turn_on"
      ? (e) => e.s !== "off" && e.s !== "unavailable"
      : request.service === "turn_off"
        ? is("off", "standby")
        : null;
  return null;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const deviceLock = yield* Semaphore.make(1);
  const readJson = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((bytes) => {
        if (Option.isNone(bytes)) return null;
        try {
          return JSON.parse(new TextDecoder().decode(bytes.value)) as unknown;
        } catch {
          return null;
        }
      }),
      Effect.orElseSucceed(() => null),
    );
  // Every R1 on this server, in the order they were set up; a server from before keeps its one record.
  const devices: Effect.Effect<ReadonlyArray<R1Device>> = Effect.gen(function* () {
    const many = yield* readJson(DEVICES_SECRET);
    if (Array.isArray(many)) return many as ReadonlyArray<R1Device>;
    const one = yield* readJson(DEVICE_SECRET);
    return one !== null && typeof one === "object" ? [one as R1Device] : [];
  });
  const writeDevices = Effect.fn("HomeAssistant.writeDevices")(function* (
    all: ReadonlyArray<R1Device>,
  ) {
    yield* secrets
      .set(DEVICES_SECRET, new TextEncoder().encode(JSON.stringify(all)))
      .pipe(
        Effect.mapError(
          () => new HomeRefusedError({ why: "The device settings could not be stored." }),
        ),
      );
    // The first R1 is kept in the old place too, so a rollback to a build from before still finds it.
    yield* (
      all[0] === undefined
        ? secrets.remove(DEVICE_SECRET)
        : secrets.set(DEVICE_SECRET, new TextEncoder().encode(JSON.stringify(all[0])))
    ).pipe(Effect.ignore);
  });
  const connection = yield* HomeAssistantConnection;
  const record = yield* Effect.serviceOption(BatonRecordService);
  const inbox = yield* Effect.serviceOption(BatonPhoneInbox);
  const peerLinks = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peerMcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  const scope = yield* Effect.scope;

  // The cache: only this server holds it.
  const states = new Map<string, Cached>();
  const registry = {
    areas: new Map<string, string>(),
    devices: new Map<string, { name: string | null; areaId: string | null }>(),
    entities: new Map<string, EntityEntry>(),
  };
  let link: HomeLink | null = null;
  let status: HomeStatus = {
    state: "off",
    host: null,
    version: null,
    entities: 0,
    line: "Home Assistant is not connected.",
  };
  let timeZone = "UTC";
  let loop: Fiber.Fiber<void> | null = null;
  // Settles when the newest session first connects or fails, so `connect` answers with where it landed.
  let settled = yield* Deferred.make<void>();
  let counter = 0;

  const newId = Effect.map(
    Clock.currentTimeMillis,
    (now) => `${now.toString(36)}${(counter++ % 1296).toString(36).padStart(2, "0")}`,
  );

  const setting = (key: string) =>
    sql<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows[0]?.value ?? null),
      Effect.orDie,
    );
  const setSetting = (key: string, value: string | null) =>
    (value === null
      ? sql`DELETE FROM fabric_settings WHERE key = ${key}`
      : sql`INSERT INTO fabric_settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    ).pipe(Effect.asVoid, Effect.orDie);
  const readToken = secrets.get(TOKEN_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const unavailable = () =>
    new HomeRefusedError({
      why:
        status.state === "off"
          ? "Home Assistant is not connected. Connect it in Settings → Home."
          : status.state === "unauthorized"
            ? "Home Assistant refused Tessaya's token. Reconnect it in Settings → Home."
            : "Home is unreachable right now: the house's network or Home Assistant is down. Nothing was changed.",
    });
  const live = Effect.suspend(() =>
    link === null ? Effect.fail(unavailable()) : Effect.succeed(link),
  );
  const said = (error: HomeCallError) =>
    new HomeRefusedError({
      why:
        error.code === "closed" || error.code === "unreachable" || error.code === "timeout"
          ? "Home is unreachable right now. Nothing was changed."
          : `Home Assistant said no: ${error.said || error.code}`,
    });
  const command = (message: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(live, (l) => l.command(message)).pipe(
      Effect.mapError((e) => (isHomeCallError(e) ? said(e) : e)),
    );
  /** `missing` names HA codes that mean "not there", answered as null instead of an error. */
  const rest = (
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    missing: ReadonlyArray<string> = [],
  ) =>
    Effect.flatMap(live, (l) => l.rest(method, path, body)).pipe(
      Effect.catchIf(
        (e) => isHomeCallError(e) && missing.includes(e.code),
        () => Effect.succeed(null),
      ),
      Effect.mapError((e) => (isHomeCallError(e) ? said(e) : e)),
    );

  const applyDiff = (event: unknown) => {
    const diff = asRecord(event);
    for (const [id, raw] of Object.entries(asRecord(diff["a"]))) {
      const entry = asRecord(raw);
      states.set(id, { s: String(entry["s"] ?? ""), a: { ...asRecord(entry["a"]) } });
    }
    for (const [id, raw] of Object.entries(asRecord(diff["c"]))) {
      const current = states.get(id) ?? { s: "", a: {} };
      const change = asRecord(raw);
      const plus = asRecord(change["+"]);
      if (plus["s"] !== undefined) current.s = String(plus["s"]);
      Object.assign(current.a, asRecord(plus["a"]));
      for (const key of asList(asRecord(change["-"])["a"])) delete current.a[key];
      states.set(id, current);
    }
    for (const id of asList(diff["r"])) states.delete(id);
    status = { ...status, entities: states.size };
  };
  const loadRegistries = Effect.fn("HomeAssistant.loadRegistries")(function* (l: HomeLink) {
    const [areas, devices, entities] = yield* Effect.all(
      [
        l.command({ type: "config/area_registry/list" }),
        l.command({ type: "config/device_registry/list" }),
        l.command({ type: "config/entity_registry/list" }),
      ],
      { concurrency: 3 },
    );
    registry.areas.clear();
    for (const a of Array.isArray(areas) ? areas : [])
      registry.areas.set(String(asRecord(a)["area_id"]), String(asRecord(a)["name"] ?? ""));
    registry.devices.clear();
    for (const d of Array.isArray(devices) ? devices : []) {
      const r = asRecord(d);
      registry.devices.set(String(r["id"]), {
        name: (r["name_by_user"] ?? r["name"] ?? null) as string | null,
        areaId: (r["area_id"] ?? null) as string | null,
      });
    }
    registry.entities.clear();
    for (const e of Array.isArray(entities) ? entities : []) {
      const r = asRecord(e);
      registry.entities.set(String(r["entity_id"]), {
        name: (r["name"] ?? null) as string | null,
        areaId: (r["area_id"] ?? null) as string | null,
        deviceId: (r["device_id"] ?? null) as string | null,
        aliases: asList(r["aliases"]),
        labels: asList(r["labels"]),
        disabled: r["disabled_by"] !== null && r["disabled_by"] !== undefined,
      });
    }
  });

  const areaOf = (entityId: string): string | null => {
    const entry = registry.entities.get(entityId);
    const areaId =
      entry?.areaId ??
      (entry?.deviceId ? registry.devices.get(entry.deviceId)?.areaId : null) ??
      null;
    return areaId === null ? null : (registry.areas.get(areaId) ?? areaId);
  };
  const nameOf = (entityId: string): string =>
    String(
      states.get(entityId)?.a["friendly_name"] ?? registry.entities.get(entityId)?.name ?? entityId,
    );
  /** HA has it, but its integration has given no state yet: a device that is off the network, not a missing one. */
  const offline = (entityId: string): boolean => {
    const entry = registry.entities.get(entityId);
    return states.has(entityId)
      ? states.get(entityId)!.s === "unavailable"
      : entry !== undefined && !entry.disabled;
  };
  const summary = (entityId: string): HomeEntity | null => {
    const cached =
      states.get(entityId) ?? (offline(entityId) ? { s: "unavailable", a: {} } : undefined);
    if (cached === undefined) return null;
    const attributes: Record<string, string> = {};
    for (const key of KEY_ATTRIBUTES)
      if (cached.a[key] !== undefined && cached.a[key] !== null)
        attributes[key] = short(cached.a[key], 60);
    return {
      entityId,
      name: short(nameOf(entityId), 80),
      area: areaOf(entityId),
      state: short(cached.s, 60),
      attributes,
    };
  };
  const facts = (entityId: string): HomeEntityFacts => ({
    entityId,
    name: nameOf(entityId),
    deviceClass: (states.get(entityId)?.a["device_class"] as string | undefined) ?? null,
  });

  // A once-automation's last action fires DONE_EVENT; the next tick removes it.
  const finished = new Set<string>();
  const sweepOnce = (event: unknown) => {
    const id = String(asRecord(asRecord(event)["data"])["id"] ?? "");
    if (id.startsWith("tessaya_")) finished.add(id);
  };
  const session = (url: string, fallback: string | null, token: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        status = {
          ...status,
          state: "connecting",
          host: hostOf(url),
          line: "Connecting to Home Assistant…",
        };
        const opened = yield* connection.open(url, token).pipe(
          Effect.catchIf(
            (e) => e.reason === "unreachable" && fallback !== null,
            () => connection.open(fallback!, token),
          ),
          Effect.result,
        );
        if (opened._tag === "Failure") {
          yield* Deferred.succeed(settled, undefined);
          const reason = opened.failure.reason;
          status = {
            ...status,
            state: reason,
            line:
              reason === "unauthorized"
                ? "Home Assistant refused Tessaya's token. Reconnect it in Settings → Home."
                : "Home is unreachable: the house's network or Home Assistant is down. Tessaya keeps trying.",
          };
          return reason;
        }
        const l = opened.success;
        const config = asRecord(
          yield* l.command({ type: "get_config" }).pipe(Effect.orElseSucceed(() => ({}))),
        );
        timeZone = typeof config["time_zone"] === "string" ? config["time_zone"] : "UTC";
        yield* loadRegistries(l).pipe(Effect.ignore);
        states.clear();
        yield* l.subscribe({ type: "subscribe_entities" }, applyDiff).pipe(Effect.ignore);
        yield* l
          .subscribe({ type: "subscribe_events", event_type: DONE_EVENT }, sweepOnce)
          .pipe(Effect.ignore);
        link = l;
        status = {
          state: "connected",
          host: hostOf(url),
          version: typeof config["version"] === "string" ? config["version"] : null,
          entities: states.size,
          line: "Connected to Home Assistant.",
        };
        yield* Deferred.succeed(settled, undefined);
        yield* l.closed;
        link = null;
        status = {
          ...status,
          state: "unreachable",
          line: "Home is unreachable: the connection dropped. Tessaya keeps trying.",
        };
        return "unreachable" as const;
      }),
    );
  const start = Effect.gen(function* () {
    settled = yield* Deferred.make<void>();
    if (loop !== null) yield* Fiber.interrupt(loop);
    link = null;
    const url = yield* setting(URL_KEY);
    const token = yield* readToken;
    if (url === null || Option.isNone(token)) {
      status = {
        state: "off",
        host: null,
        version: null,
        entities: 0,
        line: "Home Assistant is not connected.",
      };
      loop = null;
      return;
    }
    // Reconnect with backoff, up to a minute apart; a refused token waits for a new one.
    const fallback = yield* setting(FALLBACK_KEY);
    loop = yield* session(url, fallback, token.value).pipe(
      Effect.repeat({
        while: (reason) => reason !== "unauthorized",
        schedule: Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]),
      }),
      Effect.asVoid,
      Effect.forkIn(scope),
    );
  });

  const readOverrides = Effect.map(setting(OVERRIDES_KEY), (value): HomeOverrides => {
    try {
      return value === null ? {} : (JSON.parse(value) as HomeOverrides);
    } catch {
      return {};
    }
  });

  /** Every entity a target reaches, and whether it could not see the end of it. */
  const expand = (
    target: Readonly<Record<string, unknown>>,
    depth = 0,
  ): { ids: Set<string>; unbounded: boolean } => expandWith(target, depth, new Map());
  const scriptActions = new Map<string, unknown>();
  const expandWith = (
    target: Readonly<Record<string, unknown>>,
    depth: number,
    seen: Map<string, true>,
  ): { ids: Set<string>; unbounded: boolean } => {
    const ids = new Set<string>();
    let unbounded = false;
    const add = (id: string) => {
      if (seen.has(id)) return;
      seen.set(id, true);
      ids.add(id);
      const domain = id.split(".")[0];
      if (domain === "scene") for (const e of asList(states.get(id)?.a["entity_id"])) add(e);
      if (domain === "group") for (const e of asList(states.get(id)?.a["entity_id"])) add(e);
      if (domain === "script" && depth < 3) {
        const actions = scriptActions.get(id);
        if (actions === undefined) unbounded = true;
        else
          for (const call of actionCalls(actions)) {
            const inner = expandWith(call.target, depth + 1, seen);
            for (const e of inner.ids) ids.add(e);
            unbounded ||= inner.unbounded;
          }
      }
    };
    for (const id of asList(target["entity_id"])) {
      if (id === "all") unbounded = true;
      else if (id.includes("{{")) unbounded = true;
      else add(id);
    }
    for (const deviceId of asList(target["device_id"]))
      for (const [id, entry] of registry.entities) if (entry.deviceId === deviceId) add(id);
    for (const areaId of asList(target["area_id"]))
      for (const id of registry.entities.keys())
        if (
          registry.entities.get(id)?.areaId === areaId ||
          (registry.entities.get(id)?.deviceId &&
            registry.devices.get(registry.entities.get(id)!.deviceId!)?.areaId === areaId)
        )
          add(id);
    for (const labelId of asList(target["label_id"]))
      for (const [id, entry] of registry.entities) if (entry.labels.includes(labelId)) add(id);
    if (target["floor_id"] !== undefined) unbounded = true;
    return { ids, unbounded };
  };
  /** Scripts are read before judging, so a harmless-sounding script that unlocks a door still asks. */
  const loadScripts = Effect.fn("HomeAssistant.loadScripts")(function* (
    target: Readonly<Record<string, unknown>>,
    domain: string,
    service: string,
  ) {
    const ids = [
      ...asList(target["entity_id"]).filter((id) => id.startsWith("script.")),
      ...(domain === "script" && !["turn_on", "turn_off", "toggle", "reload"].includes(service)
        ? [`script.${service}`]
        : []),
    ];
    for (const id of ids) {
      if (scriptActions.has(id)) continue;
      const config = yield* command({ type: "script/config", entity_id: id }).pipe(Effect.option);
      if (Option.isSome(config))
        scriptActions.set(id, asRecord(asRecord(config.value)["config"])["sequence"] ?? []);
    }
  });
  const isToggleScript = (id: string) =>
    id.startsWith("script.") &&
    (/toggle/i.test(`${id} ${nameOf(id)}`) ||
      actionCalls(scriptActions.get(id) ?? []).some((c) => c.service === "toggle"));
  const callTarget = (request: HomeCallRequest): Record<string, unknown> => {
    const target = { ...asRecord(request.target) };
    const data = asRecord(request.data);
    if (target["entity_id"] === undefined && data["entity_id"] !== undefined)
      target["entity_id"] = data["entity_id"];
    if (
      request.domain === "script" &&
      !["turn_on", "turn_off", "toggle", "reload"].includes(request.service)
    )
      target["entity_id"] = [...asList(target["entity_id"]), `script.${request.service}`];
    return target;
  };
  const judge = Effect.fn("HomeAssistant.judge")(function* (request: HomeCallRequest) {
    const target = callTarget(request);
    yield* loadScripts(target, request.domain, request.service);
    const { ids, unbounded } = expand(target);
    const verdict = homeRisk(
      {
        domain: request.domain,
        service: request.service,
        data: asRecord(request.data),
        entities: [...ids].map(facts),
        unbounded,
      },
      yield* readOverrides,
    );
    return { verdict, ids };
  });

  const audit = Effect.fn("HomeAssistant.audit")(function* (input: {
    id: string;
    by: HomeActor;
    line: string;
    status: string;
    why: string;
  }) {
    if (record._tag === "Some")
      yield* record.value.append({
        kind: "home",
        actor: input.by.who,
        ref: input.id,
        subject: input.line,
        outcome: input.status,
        detail: `${input.by.surface}: ${JSON.stringify(recordText(input.why, 200))}`,
      });
    if (input.status === "done" || input.status === "undone")
      yield* command({
        type: "call_service",
        domain: "logbook",
        service: "log",
        service_data: {
          name: LABEL,
          message: `${input.line}, for ${input.by.who} (${input.by.surface}): ${recordText(input.why, 120)}`,
        },
      }).pipe(Effect.ignore);
  });

  const lineOf = (request: HomeCallRequest, ids: ReadonlySet<string>) => {
    const names = [...ids].slice(0, 4).map(nameOf);
    const more = ids.size > 4 ? ` and ${ids.size - 4} more` : "";
    return `${request.domain}.${request.service}${names.length === 0 ? "" : ` on ${names.join(", ")}${more}`}`;
  };

  const saveAction = Effect.fn("HomeAssistant.saveAction")(function* (
    row: Omit<ActionRow, "expires_at"> & { expires_at?: number },
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
        INSERT INTO fabric_home_actions (id, at, actor, surface, why, request, status, tier, reasons, undo_scene, prompt_id, expires_at, line)
        VALUES (${row.id}, ${row.at}, ${recordText(row.actor, 60)}, ${row.surface}, ${recordText(row.why, 300)}, ${row.request},
                ${row.status}, ${row.tier}, ${row.reasons}, ${row.undo_scene}, ${row.prompt_id}, ${row.expires_at ?? now + UNDO_KEEP_MS}, ${recordText(row.line, 300)})
        ON CONFLICT (id) DO UPDATE SET status = excluded.status, undo_scene = excluded.undo_scene,
          prompt_id = excluded.prompt_id, expires_at = excluded.expires_at, line = excluded.line
      `.pipe(Effect.orDie);
  });

  /**
   * One door for every write: refused for never; asked (a phone card, and Settings → Home) for ask without his yes;
   * held for an unattended job; otherwise run. The R1 can never carry a yes: anyone in the room can speak to it.
   */
  const gate = Effect.fn("HomeAssistant.gate")(function* (input: {
    readonly by: HomeActor;
    readonly verdict: HomeVerdict;
    readonly line: string;
    readonly why: string;
    readonly deferred: Later;
    readonly run: (id: string) => Effect.Effect<HomeOutcome, HomeRefusedError>;
    readonly id?: string;
  }) {
    const id = input.id ?? (yield* newId);
    const now = yield* Clock.currentTimeMillis;
    const approved = input.by.approved === true && input.by.surface !== "r1";
    const base = {
      id,
      at: now,
      actor: input.by.who,
      surface: input.by.surface,
      why: input.why,
      request: JSON.stringify(input.deferred),
      tier: input.verdict.tier,
      reasons: JSON.stringify(input.verdict.reasons),
      undo_scene: null,
      prompt_id: null,
      line: input.line,
    };
    const reasons = input.verdict.reasons.join("; ");
    // The suite's pretend R1: the words she would get for real, so her reply is the one he would hear; nothing is kept.
    if (input.by.dryRun === true) {
      if (input.verdict.tier === "never")
        return outcome(
          "refused",
          null,
          `Not done: ${reasons}. That one is done in Home Assistant itself.`,
        );
      if (input.verdict.tier === "ask" && !approved)
        return outcome("asked", null, `Sent to the Director's phone for a yes (${reasons}).`);
      return outcome("done", null, `Done: ${input.line}.`);
    }
    if (input.verdict.tier === "never") {
      yield* saveAction({ ...base, status: "refused" });
      yield* audit({ id, by: input.by, line: input.line, status: "refused", why: input.why });
      return outcome(
        "refused",
        id,
        `Not done: ${reasons}. That one is done in Home Assistant itself.`,
      );
    }
    if (input.verdict.tier === "ask" && !approved) {
      if (input.by.surface === "standing") {
        yield* saveAction({ ...base, status: "held" });
        yield* audit({ id, by: input.by, line: input.line, status: "held", why: input.why });
        return outcome(
          "held",
          id,
          `Held: ${input.line} needs the Director's yes (${reasons}), and an unattended job cannot ask.`,
        );
      }
      const promptId = `home-${id}`;
      if (inbox._tag === "Some")
        yield* inbox.value.mirror({
          id: promptId,
          title: "Tessaya wants to change something at home",
          detail: `${input.line}. Asked by ${input.by.who} (${input.by.surface}): "${recordText(input.why, 200)}". Needs a yes because ${reasons}.`,
          buttons: ["Yes, do it", "No"],
          yes: 0,
          cancel: 1,
          needs: "cloud-approve",
        });
      yield* saveAction({
        ...base,
        status: "asked",
        prompt_id: promptId,
        expires_at: now + PROMPT_TTL_MS,
      });
      yield* audit({ id, by: input.by, line: input.line, status: "asked", why: input.why });
      return outcome(
        "asked",
        id,
        `Sent to the Director's phone for a yes (${reasons}). Nothing happens unless he says yes within ${Math.round(PROMPT_TTL_MS / 60_000)} minutes.`,
      );
    }
    yield* saveAction({ ...base, status: "running" });
    const result = yield* input
      .run(id)
      .pipe(
        Effect.catchTags({ HomeRefusedError: (e) => Effect.succeed(outcome("failed", id, e.why)) }),
      );
    yield* sql`UPDATE fabric_home_actions SET status = ${result.status}, line = ${recordText(result.status === "done" ? input.line : result.line, 300)} WHERE id = ${id}`.pipe(
      Effect.orDie,
    );
    yield* audit({ id, by: input.by, line: input.line, status: result.status, why: input.why });
    return result;
  });

  const outcome = (
    s: HomeOutcome["status"],
    id: string | null,
    line: string,
    undoId: string | null = null,
    entityIds: Iterable<string> = [],
  ): HomeOutcome => ({
    status: s,
    id,
    line,
    undoId,
    states: [...entityIds].slice(0, 20).flatMap((e) => summary(e) ?? []),
  });

  /**
   * A server with no connection of its own (his laptop) asks the linked server that has one, through that server's
   * own home tools: its risk check and his yes apply there. Null when this server holds the connection itself.
   * shortcut: the first linked server that answers wins; with two servers connected to two houses, pick by name.
   */
  const viaPeer = Effect.fn("HomeAssistant.viaPeer")(function* (
    tool: string,
    args: Record<string, unknown>,
  ) {
    if (status.state !== "off" || peerLinks._tag === "None" || peerMcp._tag === "None") return null;
    if (!(yield* peerLinks.value.enabled)) return null;
    const links = (yield* peerLinks.value.list.pipe(Effect.orElseSucceed(() => []))).filter(
      (l) => l.status !== "expired",
    );
    for (const link of links) {
      const answer = yield* peerMcp.value
        .call({
          environmentId: link.environmentId,
          tool,
          arguments: args,
          limits: { runtimeMode: "approval-required", interactionMode: "default" },
          success: BatonHomeCallResult,
        })
        .pipe(Effect.timeout("20 seconds"), Effect.option);
      if (answer._tag === "None") continue;
      // A linked server that is not connected either says so; try the next.
      if (!answer.value.ok && /not connected/i.test(answer.value.error ?? "")) continue;
      if (!answer.value.ok)
        return yield* new HomeRefusedError({ why: answer.value.error ?? "That was not done." });
      return answer.value.value ?? null;
    }
    return null;
  });

  /** The entities a call names that have not reached what it asked for after SETTLE; none where that cannot be told. */
  const lagged = Effect.fnUntraced(function* (
    request: HomeCallRequest,
    named: ReadonlyArray<string>,
  ) {
    const want = expectedAfter(request);
    if (want === null) return [];
    const watched = named.filter((e) => e.startsWith(`${request.domain}.`) && states.has(e));
    const lagging = () => watched.filter((e) => !want(states.get(e)!));
    for (let waited = 0; lagging().length > 0 && waited < SETTLE_MS; waited += SETTLE_STEP_MS)
      yield* Effect.sleep(SETTLE_STEP_MS);
    return lagging();
  });

  const call = Effect.fn("HomeAssistant.call")(function* (
    request: HomeCallRequest,
    by: HomeActor,
    id?: string,
  ) {
    const forwarded = yield* viaPeer("home_do", { ...request });
    if (forwarded !== null) return forwarded as HomeOutcome;
    yield* live;
    // HA answers a call on an entity it does not have, or cannot reach, with success and does nothing, so "done"
    // would be a lie. One it has but cannot reach is offline, not missing (his office fan, 07:20 13 Nov).
    const named = asList(callTarget(request)["entity_id"]).filter(
      (e) => e !== "all" && !e.includes("{{"),
    );
    const away = named.filter(offline);
    if (away.length > 0)
      return yield* new HomeRefusedError({
        why: `${away.map(nameOf).join(", ")} is offline: Home Assistant has it but cannot reach it now, so nothing was sent. Say it is offline, not missing.`,
      });
    const missing = named.filter((e) => !states.has(e));
    if (missing.length > 0)
      return yield* new HomeRefusedError({
        why: `There is no ${missing.join(", ")} in the house; use an id from home_find.`,
      });
    // A blind flip turns an on device off; the state is known, so the call that says what he wants is.
    if (request.service === "toggle" && request.domain !== "script" && named.length > 0)
      return yield* new HomeRefusedError({
        why: `Toggle flips without looking. ${named.map((e) => `${nameOf(e)} is ${states.get(e)!.s}`).join(", ")}; call turn_on or turn_off for what he asked.`,
      });
    const { verdict, ids } = yield* judge(request);
    // A toggle script flips what it runs on, so "turn on" ran on an on fan turns it off (00:42, 13 Nov). Where the
    // flipped entity has a state, its own turn_on and turn_off are the way; where it has none (his office fan, 01:29),
    // nobody can tell on from off, so it runs only as an explicit flip (script.toggle) after asking him.
    if (request.domain === "script" && request.service !== "toggle") {
      const toggles = asList(callTarget(request)["entity_id"]).filter((e) => isToggleScript(e));
      const flipped = [...ids].filter(
        (e) => SWITCHED.has(e.split(".")[0] ?? "") && !e.startsWith("script."),
      );
      const known = flipped.filter((e) => states.has(e));
      if (toggles.length > 0 && known.length > 0)
        return yield* new HomeRefusedError({
          why: `${toggles.map(nameOf).join(", ")} only flips ${known
            .map((e) => `${e} (now ${states.get(e)!.s})`)
            .join(
              ", ",
            )}. Call turn_on or turn_off on that entity itself instead; it does nothing when it is already so.`,
        });
      if (toggles.length > 0)
        return yield* new HomeRefusedError({
          why: `${toggles.map(nameOf).join(", ")} only flips ${flipped.length > 0 ? flipped.join(", ") : "its device"}, and the house cannot tell whether it is on, so turning it on or off cannot be promised. Tell him that and ask whether to flip it; only on his yes, call script.toggle on ${toggles.join(", ")}.`,
        });
    }
    const line = lineOf(request, ids);
    return yield* gate({
      by,
      verdict,
      line,
      why: request.why,
      deferred: { type: "call", request },
      ...(id === undefined ? {} : { id }),
      // Inside the gate's own span.
      run: Effect.fnUntraced(function* (actionId: string) {
        const snapshot = [...ids].filter(
          (e) => RESTORABLE.has(e.split(".")[0] ?? "") && states.has(e),
        );
        const scene = snapshot.length === 0 ? null : `${UNDO_PREFIX}${actionId}`;
        if (scene !== null)
          yield* command({
            type: "call_service",
            domain: "scene",
            service: "create",
            service_data: { scene_id: scene, snapshot_entities: snapshot },
          });
        const send = command({
          type: "call_service",
          domain: request.domain,
          service: request.service,
          ...(request.target === undefined ? {} : { target: request.target }),
          service_data: asRecord(request.data),
        });
        yield* send;
        if (scene !== null)
          yield* sql`UPDATE fabric_home_actions SET undo_scene = ${scene} WHERE id = ${actionId}`.pipe(
            Effect.orDie,
          );
        // HA's yes is not the device's: his fan stayed off after "done" (07:39, 13 Nov). Look, send once more, look.
        const undoId = scene === null ? null : actionId;
        let lagging = yield* lagged(request, named);
        if (lagging.length > 0) {
          yield* send;
          lagging = yield* lagged(request, named);
        }
        if (lagging.length > 0)
          return outcome(
            "failed",
            actionId,
            `Home Assistant took ${line} twice, but ${lagging.map((e) => `${nameOf(e)} is still ${states.get(e)?.s ?? "unknown"}`).join(", ")}. Say so; it may be offline or slow.`,
            undoId,
            ids,
          );
        return outcome("done", actionId, `Done: ${line}.`, undoId, ids);
      }),
    });
  });

  /** Tried once a run: an HA that cannot delete it is not asked every tick. */
  const dropped = new Set<string>();
  const dropScene = (entityId: string) =>
    dropped.has(entityId)
      ? Effect.void
      : Effect.sync(() => dropped.add(entityId)).pipe(
          Effect.andThen(
            command({
              type: "call_service",
              domain: "scene",
              service: "delete",
              target: { entity_id: entityId },
            }),
          ),
          Effect.ignore,
        );

  const undo = Effect.fn("HomeAssistant.undo")(function* (id: string, by: HomeActor) {
    if (isDeviceRule(id)) return yield* undoDeviceRule(id, by);
    const forwarded = yield* viaPeer("home_undo", { id });
    if (forwarded !== null) return forwarded as HomeOutcome;
    yield* live;
    const automation =
      yield* sql<AutomationRowDb>`SELECT * FROM fabric_home_automations WHERE id = ${id}`.pipe(
        Effect.orDie,
      );
    if (automation[0] !== undefined) return yield* undoAutomation(automation[0], by);
    const rows = yield* sql<ActionRow>`SELECT * FROM fabric_home_actions WHERE id = ${id}`.pipe(
      Effect.orDie,
    );
    const row = rows[0];
    const now = yield* Clock.currentTimeMillis;
    if (row === undefined || row.undo_scene === null)
      return yield* new HomeRefusedError({ why: "There is nothing to undo by that id." });
    if (row.status === "undone")
      return yield* new HomeRefusedError({ why: "That was already undone." });
    if (row.at + UNDO_KEEP_MS < now)
      return yield* new HomeRefusedError({ why: "That is too old to undo (undo lasts 24 hours)." });
    const sceneEntity = `scene.${row.undo_scene}`;
    if (!states.has(sceneEntity))
      return yield* new HomeRefusedError({
        why: "Home Assistant no longer has the snapshot (it restarted since), so it cannot be put back automatically.",
      });
    // Put back is judged again: unlocking is risky even as an undo.
    const restored = asList(states.get(sceneEntity)?.a["entity_id"]);
    const verdict = homeRisk(
      { domain: "scene", service: "turn_on", entities: restored.map(facts) },
      yield* readOverrides,
    );
    const line = `put back ${row.line}`;
    return yield* gate({
      by,
      verdict,
      line,
      why: `undo of ${row.id}`,
      deferred: { type: "undo", id },
      // Inside the gate's own span.
      run: Effect.fnUntraced(function* () {
        yield* command({
          type: "call_service",
          domain: "scene",
          service: "turn_on",
          target: { entity_id: sceneEntity },
        });
        yield* dropScene(sceneEntity);
        yield* sql`UPDATE fabric_home_actions SET status = 'undone' WHERE id = ${row.id}`.pipe(
          Effect.orDie,
        );
        return outcome("undone", row.id, `Put back as it was before: ${row.line}.`, null, restored);
      }),
    });
  });

  const automationEntity = (id: string): string | null => {
    for (const [entityId, cached] of states)
      if (entityId.startsWith("automation.") && cached.a["id"] === id) return entityId;
    return null;
  };
  const clockTime = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
  const localTime = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(
      new Date(ms),
    );

  const labelAutomation = Effect.fn("HomeAssistant.labelAutomation")(
    function* (id: string) {
      const labels = yield* command({ type: "config/label_registry/list" });
      let label = (Array.isArray(labels) ? labels : [])
        .map(asRecord)
        .find((l) => l["name"] === LABEL);
      if (label === undefined)
        label = asRecord(
          yield* command({
            type: "config/label_registry/create",
            name: LABEL,
            icon: "mdi:robot-happy-outline",
          }),
        );
      const labelId = String(label["label_id"] ?? "");
      // The entity appears once HA has reloaded its automations.
      const entityId = yield* Effect.suspend(() => {
        const found = automationEntity(id);
        return found === null ? Effect.fail("not yet" as const) : Effect.succeed(found);
      }).pipe(Effect.retry(Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(20)])));
      const entry = asRecord(
        asRecord(yield* command({ type: "config/entity_registry/get", entity_id: entityId }))[
          "labels"
        ] ?? [],
      );
      const current = Array.isArray(entry) ? (entry as Array<string>) : [];
      if (!current.includes(labelId))
        yield* command({
          type: "config/entity_registry/update",
          entity_id: entityId,
          labels: [...current, labelId],
        });
    },
    (effect) => Effect.ignore(effect),
  );

  const writeConfig = (id: string, config: Record<string, unknown>) =>
    rest("POST", `/api/config/automation/config/${encodeURIComponent(id)}`, config);
  const readConfig = (id: string) =>
    rest("GET", `/api/config/automation/config/${encodeURIComponent(id)}`, undefined, [
      "http_404",
      "http_400",
    ]).pipe(Effect.map((value) => (value === null ? null : asRecord(value))));

  const automationRisk = Effect.fn("HomeAssistant.automationRisk")(function* (
    actions: ReadonlyArray<unknown>,
  ) {
    let tier: HomeTier = "auto";
    const reasons: Array<string> = [];
    for (const inner of actionCalls(actions)) {
      const { verdict } = yield* judge({
        domain: inner.domain,
        service: inner.service,
        target: inner.target,
        data: inner.data,
        why: "",
      });
      tier = higherTier(tier, verdict.tier);
      reasons.push(...verdict.reasons);
    }
    return { tier, reasons } satisfies HomeVerdict;
  });

  const saveAutomation = Effect.fn("HomeAssistant.saveAutomation")(function* (
    input: HomeAutomationInput,
    by: HomeActor,
  ) {
    const forwarded = yield* viaPeer("home_automation_save", { ...input });
    if (forwarded !== null) return forwarded as HomeOutcome;
    yield* live;
    const now = yield* Clock.currentTimeMillis;
    const mine = input.id === undefined || input.id.startsWith("tessaya_");
    const runAt = input.runInMinutes === undefined ? null : now + input.runInMinutes * 60_000;
    // A delay has an end by nature, whatever kind was asked for.
    const kind: HomeAutomationKind =
      runAt !== null && input.kind === "permanent" ? "temporary" : input.kind;
    const id = input.id ?? `tessaya_${kind}_${yield* newId}`;
    const triggers =
      runAt === null ? (input.triggers ?? []) : [{ trigger: "time", at: clockTime(runAt) }];
    const expiresAt =
      runAt !== null && input.expiresAt === undefined && input.expiresInMinutes === undefined
        ? runAt + 10 * 60_000
        : kind === "permanent"
          ? null
          : input.expiresAt !== undefined && !Number.isNaN(Date.parse(input.expiresAt))
            ? Date.parse(input.expiresAt)
            : input.expiresInMinutes !== undefined
              ? now + input.expiresInMinutes * 60_000
              : kind === "scratch"
                ? now + SCRATCH_MS
                : null;
    if (kind === "temporary" && expiresAt === null)
      return yield* new HomeRefusedError({
        why: "A temporary automation needs expiresInMinutes or expiresAt.",
      });
    if (expiresAt !== null && expiresAt <= now)
      return yield* new HomeRefusedError({ why: "That end time has already passed." });
    const once = (input.once === true || runAt !== null) && mine;
    const conditions = [
      ...(input.conditions ?? []),
      ...(expiresAt === null
        ? []
        : [
            {
              condition: "template",
              value_template: `{{ now() < as_datetime('${iso(expiresAt)}') }}`,
            },
          ]),
    ];
    const actions = [
      ...input.actions,
      ...(once ? [{ event: DONE_EVENT, event_data: { id } }] : []),
    ];
    // HA's own check first: a broken automation is refused with its words, never saved.
    const checked = asRecord(
      yield* command({ type: "validate_config", triggers, conditions, actions }),
    );
    for (const part of ["triggers", "conditions", "actions"]) {
      const result = asRecord(checked[part]);
      if (result["valid"] === false)
        return yield* new HomeRefusedError({
          why: `Home Assistant found a problem in the ${part}: ${short(result["error"], 300)}`,
        });
    }
    const verdict = yield* automationRisk(input.actions);
    const editsHis = !mine
      ? {
          tier: "ask" as const,
          reasons: [...verdict.reasons, "it changes an automation Tessaya did not make"],
        }
      : verdict;
    const ends = expiresAt === null ? "" : `, ends ${localTime(expiresAt)}`;
    const mark = mine
      ? `Made by Tessaya for ${recordText(by.who, 40)}: "${recordText(input.request, 160)}". ${kind}${once ? ", runs once" : ""}${ends}.`
      : `Edited by Tessaya for ${recordText(by.who, 40)}: "${recordText(input.request, 160)}".`;
    const config = {
      id,
      alias: recordText(input.alias, 120),
      description: `${input.description === undefined ? "" : `${recordText(input.description, 400)}\n\n`}${mark}`,
      triggers,
      conditions,
      actions,
      mode: input.mode ?? "single",
    };
    const line = `${input.id === undefined ? "create" : "change"} the ${mine ? kind : "existing"} automation "${config.alias}"`;
    return yield* gate({
      by,
      verdict: editsHis,
      line,
      why: input.request,
      deferred: { type: "automationSave", input },
      // Inside the gate's own span.
      run: Effect.fnUntraced(function* () {
        const previous = yield* readConfig(id);
        yield* writeConfig(id, config);
        const stamp = yield* Clock.currentTimeMillis;
        yield* sql`
            INSERT INTO fabric_home_automations (id, kind, expires_at, once, actor, surface, request, config, previous, last_op, status, created_at, updated_at)
            VALUES (${id}, ${mine ? kind : "his"}, ${expiresAt}, ${once ? 1 : 0}, ${recordText(by.who, 60)}, ${by.surface},
                    ${recordText(input.request, 300)}, ${JSON.stringify(config)}, ${previous === null ? null : JSON.stringify(previous)},
                    ${previous === null ? "create" : "edit"}, 'active', ${stamp}, ${stamp})
            ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, expires_at = excluded.expires_at, once = excluded.once,
              request = excluded.request, config = excluded.config, previous = excluded.previous, last_op = excluded.last_op,
              status = 'active', updated_at = excluded.updated_at
          `.pipe(Effect.orDie);
        if (mine) yield* labelAutomation(id).pipe(Effect.forkIn(scope));
        return outcome(
          "done",
          id,
          `Saved "${config.alias}" (${mine ? kind : "his"}${ends}) as ${id}.`,
          id,
        );
      }),
    });
  });

  const removeAutomation = Effect.fn("HomeAssistant.removeAutomation")(function* (
    id: string,
    status: "deleted" | "expired" | "finished",
  ) {
    const previous = yield* readConfig(id);
    yield* rest("DELETE", `/api/config/automation/config/${encodeURIComponent(id)}`, undefined, [
      "http_404",
      "http_400",
    ]);
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
        UPDATE fabric_home_automations SET status = ${status}, last_op = 'delete', updated_at = ${now},
          previous = COALESCE(${previous === null ? null : JSON.stringify(previous)}, config)
        WHERE id = ${id}
      `.pipe(Effect.orDie);
    if (status !== "deleted" && record._tag === "Some")
      yield* record.value.append({
        kind: "home",
        actor: "tessaya",
        ref: id,
        subject: `removed automation ${id}`,
        outcome: status,
      });
  });

  /**
   * Rules on device state (DeviceTriggers) live in this table with Home Assistant's, but run on this server: pause,
   * resume, delete and undo change only the row, with no Home Assistant behind them.
   */
  const deviceRule = Effect.fn("HomeAssistant.deviceRule")(function* (id: string) {
    const rows =
      yield* sql<AutomationRowDb>`SELECT * FROM fabric_home_automations WHERE id = ${id}`.pipe(
        Effect.orDie,
      );
    const row = rows[0];
    if (row === undefined || (row.status === "deleted" && row.last_op !== "delete"))
      return yield* new HomeRefusedError({ why: `There is no rule ${id}.` });
    return row;
  });
  const setDeviceRule = Effect.fn("HomeAssistant.setDeviceRule")(function* (
    input: { readonly id: string; readonly op: "pause" | "resume" | "delete" },
    by: HomeActor,
  ) {
    const row = yield* deviceRule(input.id);
    const now = yield* Clock.currentTimeMillis;
    const status = input.op === "pause" ? "paused" : input.op === "resume" ? "active" : "deleted";
    if (status !== "deleted" && row.status !== "active" && row.status !== "paused")
      return yield* new HomeRefusedError({ why: `The rule ${input.id} has ${row.status}.` });
    yield* sql`
      UPDATE fabric_home_automations SET status = ${status}, previous = ${row.status}, last_op = ${input.op}, updated_at = ${now}
      WHERE id = ${input.id}
    `.pipe(Effect.orDie);
    if (record._tag === "Some")
      yield* record.value.append({
        kind: "home",
        actor: by.who,
        ref: input.id,
        subject: `${input.op} rule ${input.id}`,
        outcome: "done",
        detail: by.surface,
      });
    return outcome(
      "done",
      input.id,
      input.op === "delete"
        ? `Deleted ${input.id}. Undo puts it back for 7 days.`
        : `${input.op === "pause" ? "Paused" : "Resumed"} ${input.id}.`,
      input.op === "delete" ? input.id : null,
    );
  });
  /** Undo a rule's last change: a new one is removed, a deleted or paused one comes back as it was. */
  const undoDeviceRule = Effect.fn("HomeAssistant.undoDeviceRule")(function* (
    id: string,
    by: HomeActor,
  ) {
    const row = yield* deviceRule(id);
    const now = yield* Clock.currentTimeMillis;
    const back = row.last_op === "create" ? "deleted" : (row.previous ?? "active");
    yield* sql`
      UPDATE fabric_home_automations SET status = ${back}, previous = NULL, last_op = 'restore', updated_at = ${now}
      WHERE id = ${id}
    `.pipe(Effect.orDie);
    if (record._tag === "Some")
      yield* record.value.append({
        kind: "home",
        actor: by.who,
        ref: id,
        subject: `undo of rule ${id}`,
        outcome: back,
        detail: by.surface,
      });
    return outcome(
      "undone",
      id,
      back === "deleted" ? `Removed ${id} again.` : `Put ${id} back as it was.`,
    );
  });

  const setAutomation = Effect.fn("HomeAssistant.setAutomation")(function* (
    input: { readonly id: string; readonly op: "pause" | "resume" | "delete" },
    by: HomeActor,
  ) {
    if (isDeviceRule(input.id)) return yield* setDeviceRule(input, by);
    const forwarded = yield* viaPeer("home_automation_set", { ...input });
    if (forwarded !== null) return forwarded as HomeOutcome;
    yield* live;
    const mine = input.id.startsWith("tessaya_");
    const entityId = automationEntity(input.id);
    if (entityId === null && input.op !== "delete")
      return yield* new HomeRefusedError({ why: `Home Assistant has no automation ${input.id}.` });
    const verdict: HomeVerdict = mine
      ? { tier: "auto", reasons: [] }
      : { tier: "ask", reasons: ["it changes an automation Tessaya did not make"] };
    const line = `${input.op} the automation ${entityId === null ? input.id : nameOf(entityId)}`;
    return yield* gate({
      by,
      verdict,
      line,
      why: `${input.op} ${input.id}`,
      deferred: { type: "automationSet", input },
      // Inside the gate's own span.
      run: Effect.fnUntraced(function* () {
        if (input.op === "delete") {
          if (!mine) {
            // His own: kept for undo like hers.
            const config = yield* readConfig(input.id);
            const now = yield* Clock.currentTimeMillis;
            if (config !== null)
              yield* sql`
                  INSERT INTO fabric_home_automations (id, kind, expires_at, once, actor, surface, request, config, previous, last_op, status, created_at, updated_at)
                  VALUES (${input.id}, 'his', NULL, 0, ${by.who}, ${by.surface}, '', ${JSON.stringify(config)}, ${JSON.stringify(config)}, 'delete', 'active', ${now}, ${now})
                  ON CONFLICT (id) DO NOTHING
                `.pipe(Effect.orDie);
          }
          yield* removeAutomation(input.id, "deleted");
          return outcome(
            "done",
            input.id,
            `Deleted ${input.id}. Undo puts it back for 7 days.`,
            input.id,
          );
        }
        yield* command({
          type: "call_service",
          domain: "automation",
          service: input.op === "pause" ? "turn_off" : "turn_on",
          target: { entity_id: entityId },
        });
        return outcome(
          "done",
          input.id,
          `${input.op === "pause" ? "Paused" : "Resumed"} ${input.id}.`,
          null,
          [entityId!],
        );
      }),
    });
  });

  const undoAutomation = Effect.fn("HomeAssistant.undoAutomation")(function* (
    row: AutomationRowDb,
    by: HomeActor,
  ): Effect.fn.Return<HomeOutcome, HomeRefusedError> {
    const previous = row.previous === null ? null : asRecord(JSON.parse(row.previous));
    const restore = row.last_op === "create" || previous === null ? "remove" : "restore";
    const verdict =
      restore === "restore"
        ? yield* automationRisk(
            Array.isArray(previous?.["actions"]) ? (previous["actions"] as Array<unknown>) : [],
          )
        : ({ tier: "auto", reasons: [] } satisfies HomeVerdict);
    const line =
      restore === "remove"
        ? `remove the new automation ${row.id}`
        : `put back the automation ${row.id}`;
    return yield* gate({
      by,
      verdict,
      line,
      why: `undo of ${row.id}`,
      deferred: { type: "undo", id: row.id },
      // Inside the gate's own span.
      run: Effect.fnUntraced(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (restore === "remove") {
          yield* removeAutomation(row.id, "deleted");
          return outcome("undone", row.id, `Removed ${row.id} again.`);
        }
        yield* writeConfig(row.id, previous!);
        yield* sql`UPDATE fabric_home_automations SET status = 'active', config = ${row.previous}, last_op = 'restore', updated_at = ${now} WHERE id = ${row.id}`.pipe(
          Effect.orDie,
        );
        return outcome("undone", row.id, `Put ${row.id} back as it was.`);
      }),
    });
  });

  const automations = Effect.fn("HomeAssistant.automations")(function* (input: {
    readonly all?: boolean;
  }) {
    const forwarded = yield* viaPeer("home_automations", { ...input });
    if (forwarded !== null) return forwarded as ReadonlyArray<HomeAutomationRow>;
    // Rules on device state need no Home Assistant: without it they are listed alone.
    const rules = (yield* sql<AutomationRowDb>`
      SELECT * FROM fabric_home_automations WHERE id LIKE 'tessaya_device_%' AND status IN ('active', 'paused')
      ORDER BY created_at DESC LIMIT 200
    `.pipe(Effect.orDie)).map((r): HomeAutomationRow => ({
      id: r.id,
      alias: String(asRecord(JSON.parse(r.config))["name"] ?? r.id),
      kind: r.kind === "temporary" ? "temporary" : "permanent",
      mine: true,
      expiresAt: r.expires_at === null ? null : iso(r.expires_at),
      once: r.once === 1,
      paused: r.status === "paused",
      status: "active",
      request: r.request,
      entityId: null,
    }));
    if (link === null) return rules;
    const rows =
      yield* sql<AutomationRowDb>`SELECT * FROM fabric_home_automations WHERE kind != 'his' ORDER BY created_at DESC LIMIT 200`.pipe(
        Effect.orDie,
      );
    const ours = new Map(rows.map((r) => [r.id, r]));
    const out: Array<HomeAutomationRow> = rows
      .filter((r) => !isDeviceRule(r.id))
      .map((r) => {
        const entityId = automationEntity(r.id);
        return {
          id: r.id,
          alias: String(asRecord(JSON.parse(r.config))["alias"] ?? r.id),
          kind: r.kind as HomeAutomationKind,
          mine: true,
          expiresAt: r.expires_at === null ? null : iso(r.expires_at),
          once: r.once === 1,
          paused: entityId !== null && states.get(entityId)?.s === "off",
          status: r.status === "active" && entityId === null ? "missing" : r.status,
          request: r.request,
          entityId,
        };
      });
    out.push(...rules);
    if (input.all === true)
      for (const [entityId, cached] of states) {
        if (!entityId.startsWith("automation.")) continue;
        const id = String(cached.a["id"] ?? entityId);
        if (ours.has(id)) continue;
        out.push({
          id,
          alias: short(nameOf(entityId), 120),
          kind: null,
          mine: id.startsWith("tessaya_"),
          expiresAt: null,
          once: false,
          paused: cached.s === "off",
          status: "active",
          request: null,
          entityId,
        });
      }
    return out;
  });

  const runDeferred = (
    deferred: Later,
    by: HomeActor,
    id: string,
  ): Effect.Effect<HomeOutcome, HomeRefusedError> => {
    switch (deferred.type) {
      case "call":
        return call(deferred.request, by, id);
      case "undo":
        return undo(deferred.id, by);
      case "automationSave":
        return saveAutomation(deferred.input, by);
      case "automationSet":
        return setAutomation(deferred.input, by);
    }
  };
  const answer = Effect.fn("HomeAssistant.answer")(function* (id: string, yes: boolean) {
    const rows = yield* sql<ActionRow>`SELECT * FROM fabric_home_actions WHERE id = ${id}`.pipe(
      Effect.orDie,
    );
    const row = rows[0];
    const now = yield* Clock.currentTimeMillis;
    if (row === undefined || row.status !== "asked")
      return yield* new HomeRefusedError({ why: "That request is not waiting for an answer." });
    if (row.prompt_id !== null && inbox._tag === "Some")
      yield* inbox.value.closePrompt(row.prompt_id);
    const by: HomeActor = { who: row.actor, surface: row.surface as HomeSurface, approved: true };
    if (row.expires_at <= now) {
      yield* sql`UPDATE fabric_home_actions SET status = 'expired' WHERE id = ${id}`.pipe(
        Effect.orDie,
      );
      return outcome(
        "expired",
        id,
        "That request expired before an answer. Ask again if it is still wanted.",
      );
    }
    if (!yes) {
      yield* sql`UPDATE fabric_home_actions SET status = 'denied' WHERE id = ${id}`.pipe(
        Effect.orDie,
      );
      yield* audit({ id, by, line: row.line, status: "denied", why: row.why });
      return outcome("denied", id, `The Director said no: ${row.line}.`);
    }
    yield* sql`UPDATE fabric_home_actions SET status = 'approved' WHERE id = ${id}`.pipe(
      Effect.orDie,
    );
    const deferred = JSON.parse(row.request) as Later;
    // The yes is his, so the R1 surface it came from no longer matters for running it.
    return yield* runDeferred(
      deferred,
      { ...by, surface: by.surface === "r1" ? "phone" : by.surface },
      id,
    );
  });

  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    // Undo snapshots past their day: his scene list is his (13 Nov: six of his six scenes were these).
    const stale = [...states.keys()].filter((id) => {
      const born = id.startsWith(`scene.${UNDO_PREFIX}`)
        ? parseInt(id.slice(`scene.${UNDO_PREFIX}`.length, -2), 36)
        : Number.NaN;
      return !Number.isNaN(born) && born + UNDO_KEEP_MS < now;
    });
    if (link !== null) for (const id of stale) yield* dropScene(id);
    // His answers on the phone card.
    const asked =
      yield* sql<ActionRow>`SELECT * FROM fabric_home_actions WHERE status = 'asked'`.pipe(
        Effect.orDie,
      );
    for (const row of asked) {
      const picked =
        row.prompt_id === null || inbox._tag === "None"
          ? null
          : yield* inbox.value.promptAnswer(row.prompt_id);
      if (picked !== null) yield* answer(row.id, picked === 0).pipe(Effect.ignore);
      else if (row.expires_at <= now)
        yield* sql`UPDATE fabric_home_actions SET status = 'expired' WHERE id = ${row.id} AND status = 'asked'`.pipe(
          Effect.orDie,
        );
    }
    // Rules on device state past their end: only their row.
    yield* sql`
      UPDATE fabric_home_automations SET status = 'expired', updated_at = ${now}
      WHERE id LIKE 'tessaya_device_%' AND status IN ('active', 'paused') AND expires_at IS NOT NULL AND expires_at <= ${now}
    `.pipe(Effect.orDie);
    // Temporary and scratch automations past their end.
    if (link !== null) {
      const due = yield* sql<{ id: string }>`
        SELECT id FROM fabric_home_automations WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ${now}
          AND id NOT LIKE 'tessaya_device_%'
      `.pipe(Effect.orDie);
      for (const { id } of due) yield* removeAutomation(id, "expired").pipe(Effect.ignore);
      for (const id of finished) {
        finished.delete(id);
        yield* removeAutomation(id, "finished").pipe(Effect.ignore);
      }
    }
    yield* sql`DELETE FROM fabric_home_automations WHERE status NOT IN ('active', 'paused') AND updated_at <= ${now - DELETED_KEEP_MS}`.pipe(
      Effect.orDie,
    );
    yield* sql`DELETE FROM fabric_home_actions WHERE at <= ${now - DELETED_KEEP_MS}`.pipe(
      Effect.orDie,
    );
  });

  const entitiesOf = (request: string): ReadonlyArray<string> => {
    try {
      const stored = asRecord(JSON.parse(request));
      const call = asRecord(stored["request"]);
      return stored["type"] === "call"
        ? asList(asRecord(call["target"])["entity_id"] ?? asRecord(call["data"])["entity_id"])
        : [];
    } catch {
      return [];
    }
  };
  const toRow = (r: ActionRow): HomeActionRow => ({
    id: r.id,
    at: iso(r.at),
    actor: r.actor,
    surface: r.surface,
    line: r.line,
    why: r.why,
    status: r.status,
    tier: (r.tier as HomeTier) ?? "ask",
    canUndo: r.undo_scene !== null && r.status === "done",
    entities: entitiesOf(r.request),
  });

  const find = Effect.fn("HomeAssistant.find")(function* (input: {
    readonly text?: string;
    readonly area?: string;
    readonly domain?: string;
    readonly limit?: number;
  }) {
    const forwarded = yield* viaPeer("home_find", { ...input });
    if (forwarded !== null) return forwarded as ReadonlyArray<HomeEntity>;
    yield* live;
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10)));
    const words = (input.text ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 0);
    const area = input.area?.toLowerCase();
    const scored: Array<{ id: string; score: number }> = [];
    // An offline device is found too (marked unavailable), so it is never called missing.
    for (const id of new Set([
      ...states.keys(),
      ...[...registry.entities.keys()].filter(offline),
    ])) {
      if (input.domain !== undefined && !id.startsWith(`${input.domain}.`)) continue;
      const areaName = areaOf(id)?.toLowerCase() ?? "";
      if (area !== undefined && !areaName.includes(area)) continue;
      const entry = registry.entities.get(id);
      const deviceName = entry?.deviceId ? (registry.devices.get(entry.deviceId)?.name ?? "") : "";
      const hay =
        `${id} ${nameOf(id)} ${areaName} ${deviceName} ${(entry?.aliases ?? []).join(" ")}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      if (words.length > 0 && hits === 0) continue;
      const unavailable = offline(id) ? 0.5 : 0;
      scored.push({
        id,
        score: hits - unavailable + (nameOf(id).toLowerCase().includes(words.join(" ")) ? 1 : 0),
      });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const found = scored.slice(0, limit).flatMap(({ id }) => summary(id) ?? []);
    // Two called "Lamp" are told apart by room, and the one she last used is marked, so she can ask which.
    const shared = new Set(found.map((e) => e.name).filter((n, i, all) => all.indexOf(n) !== i));
    if (shared.size === 0) return found;
    const recent = new Map<string, string>();
    for (const row of yield* sql<ActionRow>`SELECT * FROM fabric_home_actions WHERE status = 'done' ORDER BY at DESC LIMIT 50`.pipe(
      Effect.orElseSucceed(() => []),
    ))
      for (const e of entitiesOf(row.request)) if (!recent.has(e)) recent.set(e, localTime(row.at));
    return found.map((e) =>
      shared.has(e.name)
        ? {
            ...e,
            name: `${e.name} (${e.area ?? e.entityId})`,
            attributes: {
              ...e.attributes,
              ...(recent.has(e.entityId) ? { last_used: recent.get(e.entityId)! } : {}),
            },
          }
        : e,
    );
  });

  const connect = Effect.fn("HomeAssistant.connect")(function* (input: {
    readonly url: string;
    readonly fallbackUrl?: string;
    readonly token: string;
  }) {
    const url = input.url.trim().replace(/\/+$/, "");
    const fallback = input.fallbackUrl?.trim().replace(/\/+$/, "") || null;
    if (
      !/^https?:\/\/[^/\s]+$/.test(url) ||
      (fallback !== null && !/^https?:\/\/[^/\s]+$/.test(fallback))
    )
      return yield* new HomeRefusedError({
        why: "Give Home Assistant's address like http://192.168.1.10:8123.",
      });
    if (input.token.trim().length < 20)
      return yield* new HomeRefusedError({ why: "That token is too short." });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const probe = yield* connection.open(url, input.token.trim()).pipe(
          Effect.catchIf(
            (e) => e.reason === "unreachable" && fallback !== null,
            () => connection.open(fallback!, input.token.trim()),
          ),
          Effect.mapError(
            (e) =>
              new HomeRefusedError({
                why:
                  e.reason === "unauthorized"
                    ? "Home Assistant refused that token."
                    : "Home Assistant could not be reached at that address.",
              }),
          ),
        );
        const user = asRecord(
          yield* probe.command({ type: "auth/current_user" }).pipe(Effect.mapError(said)),
        );
        if (user["is_admin"] !== true)
          return yield* new HomeRefusedError({
            why: "That token's user is not an administrator; writing automations needs one.",
          });
      }),
    );
    yield* secrets.set(TOKEN_SECRET, new TextEncoder().encode(input.token.trim())).pipe(
      Effect.mapError(
        () =>
          new HomeRefusedError({
            why: "The token could not be stored in this server's secret store.",
          }),
      ),
    );
    yield* setSetting(URL_KEY, url);
    yield* setSetting(FALLBACK_KEY, fallback);
    yield* start;
    yield* Deferred.await(settled).pipe(Effect.timeout("15 seconds"), Effect.ignore);
    return status;
  });

  const disconnect = Effect.gen(function* () {
    yield* secrets.remove(TOKEN_SECRET).pipe(Effect.ignore);
    yield* setSetting(URL_KEY, null);
    yield* setSetting(FALLBACK_KEY, null);
    yield* start;
    return status;
  });

  yield* start;
  yield* tick.pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced(TICK)),
    Effect.forkIn(scope),
  );

  return HomeAssistantService.of({
    status: Effect.sync(() => ({ ...status, entities: states.size })),
    timeZone: Effect.sync(() => timeZone),
    connect,
    disconnect,
    find,
    state: Effect.fn("HomeAssistant.state")(function* (entityId: string) {
      const forwarded = yield* viaPeer("home_state", { entityId });
      if (forwarded !== null) return forwarded as HomeEntity;
      yield* live;
      return summary(entityId);
    }),
    history: Effect.fn("HomeAssistant.history")(function* (entityId: string, since: string) {
      const start = Number.isNaN(Date.parse(since))
        ? (yield* Clock.currentTimeMillis) - 86_400_000
        : Date.parse(since);
      const result = asRecord(
        yield* command({
          type: "history/history_during_period",
          start_time: iso(start),
          entity_ids: [entityId],
          minimal_response: true,
          no_attributes: true,
          significant_changes_only: false,
        }),
      );
      const rows = Array.isArray(result[entityId]) ? (result[entityId] as Array<unknown>) : [];
      return rows.slice(-100).map((r) => {
        const row = asRecord(r);
        const at = Number(row["lu"] ?? row["lc"] ?? 0) * 1000;
        return { at: iso(at), state: short(row["s"] ?? row["state"], 60) };
      });
    }),
    services: Effect.fn("HomeAssistant.services")(function* (domain?: string) {
      const all = asRecord(yield* command({ type: "get_services" }));
      if (domain === undefined)
        return Object.fromEntries(
          Object.entries(all).map(([d, s]) => [d, Object.keys(asRecord(s))]),
        );
      return asRecord(all[domain]);
    }),
    call: Effect.fn("HomeAssistant.callFor")(function* (request: HomeCallRequest, by: HomeActor) {
      return yield* call(request, by);
    }),
    undo,
    saveAutomation,
    setAutomation,
    automations,
    actions: Effect.fn("HomeAssistant.actions")(function* (limit: number) {
      const rows =
        yield* sql<ActionRow>`SELECT * FROM fabric_home_actions ORDER BY at DESC LIMIT ${Math.max(1, Math.min(100, limit))}`.pipe(
          Effect.orDie,
        );
      return rows.map(toRow);
    }),
    pending:
      sql<ActionRow>`SELECT * FROM fabric_home_actions WHERE status = 'asked' ORDER BY at DESC`.pipe(
        Effect.map((rows) => rows.map(toRow)),
        Effect.orDie,
      ),
    answer,
    overrides: readOverrides,
    setOverride: Effect.fn("HomeAssistant.setOverride")(function* (
      entityId: string,
      tier: HomeTier | null,
    ) {
      const current = { ...(yield* readOverrides) };
      if (tier === null) delete current[entityId];
      else current[entityId] = tier;
      yield* setSetting(OVERRIDES_KEY, JSON.stringify(current));
      return current;
    }),
    devices,
    device: Effect.map(devices, (all) => all[0] ?? null),
    putDevice: Effect.fn("HomeAssistant.putDevice")(function* (device: R1Device) {
      if (device.deviceKey.length < 24)
        return yield* new HomeRefusedError({ why: "The device key is too short." });
      if (device.deviceId === null || !R1_ID.test(device.deviceId))
        return yield* new HomeRefusedError({ why: "Give the R1's id, such as r1-a1b2c3." });
      const id = device.deviceId;
      return yield* deviceLock.withPermits(1)(
        Effect.gen(function* () {
          const all = yield* devices;
          if (all.length >= MAX_R1 && !all.some((d) => d.deviceId === id))
            return yield* new HomeRefusedError({
              why: `This server already has ${MAX_R1} R1s. Forget one first.`,
            });
          // Replaced in place, so the order they were set up in stays.
          yield* writeDevices(
            all.some((d) => d.deviceId === id)
              ? all.map((d) => (d.deviceId === id ? device : d))
              : [...all, device],
          );
          return { configured: true };
        }),
      );
    }),
    removeDevice: Effect.fn("HomeAssistant.removeDevice")(function* (id: string | null) {
      return yield* deviceLock.withPermits(1)(
        Effect.gen(function* () {
          const left = id === null ? [] : (yield* devices).filter((d) => d.deviceId !== id);
          yield* writeDevices(left).pipe(Effect.ignore);
          return { configured: left.length > 0 };
        }),
      );
    }),
    tick,
  });
});

export const layer = Layer.effect(HomeAssistantService, make);

/** The R1 with this id, if it is set up here. */
export const r1ById = (all: ReadonlyArray<R1Device>, id: string): R1Device | null =>
  all.find((d) => d.deviceId === id) ?? null;

const keyDigest = (s: string) => NodeCrypto.createHash("sha256").update(s).digest();
/** The R1 whose device key this is (the room loop's and the camera's bearer), compared in constant time. */
export const r1ByKey = (all: ReadonlyArray<R1Device>, key: string): R1Device | null =>
  key === ""
    ? null
    : (all.find((d) => NodeCrypto.timingSafeEqual(keyDigest(key), keyDigest(d.deviceKey))) ?? null);
