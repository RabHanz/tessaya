// @effect-diagnostics globalDate:off globalJsonInEffect:off preferSchemaOverJson:off
/**
 * The one owner of device state (R1-P13): every vessel's manifest and the latest value of each of its items. The R1
 * reaches it through the broker (HomeDevices), the desktop and phone through the devices door's `vessel` kind. A write
 * goes back the way the device came; this service checks it against the item and leaves the yes to its callers.
 */
import {
  DeviceManifest,
  type DeviceItem,
  type DeviceWrite,
  type RegisteredDevice,
} from "@t3tools/tessaya-contracts";
import { checkWrite, isTestVessel, withFloor } from "@t3tools/tessaya-shared/deviceItems";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

export class DeviceRefusedError extends Schema.TaggedError<DeviceRefusedError>()(
  "DeviceRefusedError",
  { why: Schema.String },
) {}

export type DeviceVia = RegisteredDevice["via"];

/** One item's value changed, or an event item fired. */
export interface DeviceChange {
  readonly deviceId: string;
  readonly kind: string;
  readonly itemId: string;
  readonly value: unknown;
  readonly previous: unknown;
  readonly at: number;
}

/** How a write reaches a broker device: send it and say whether the device took it. */
export type DeviceWriter = (
  deviceId: string,
  itemId: string,
  value: unknown,
) => Effect.Effect<{ readonly ok: boolean; readonly error?: string } | null>;

/** The server's own items on a device (its body): it answers their writes with a line, or refuses. */
export type OwnWriter = (
  deviceId: string,
  itemId: string,
  value: unknown,
) => Effect.Effect<string, DeviceRefusedError>;

export interface WriteOutcome {
  /** done: the device acknowledged it; sent: it went out but no acknowledgement came in time. */
  readonly status: "done" | "sent";
  readonly line: string;
}

interface Held {
  deviceId: string;
  kind: string;
  name: string;
  firmware: string | null;
  via: DeviceVia;
  version: string | null;
  items: Array<DeviceItem>;
  values: Map<string, { value: unknown; at: number }>;
  lastSeen: number | null;
  /** A broker device says so itself (state/online); a client vessel is online while it keeps calling. */
  online: boolean | null;
  /** Private items in use, until when. */
  live: Map<string, number>;
  /** The member whose session first reported this client vessel; null: a room vessel, or the owner's from before. */
  member: string | null;
}

/** A client vessel calls at least every 15 s while it runs. */
const CLIENT_ONLINE_MS = 45_000;
const ACK_WAIT_MS = 4_000;
/** A device away this long is shown as gone, with "forget it" offered. */
const STALE_MS = 14 * 24 * 60 * 60_000;
const MAX_VALUE_CHARS = 2_000;
const MAX_ITEMS = 300;
const decodeManifest = Schema.decodeUnknownOption(DeviceManifest);

export class DeviceRegistry extends Context.Service<
  DeviceRegistry,
  {
    /** A manifest arrived (on connect or on change). Undecodable ones are refused with a reason. */
    readonly publish: (via: DeviceVia, manifest: unknown) => Effect.Effect<string | null>;
    /** Values from a device, in its own words; unknown items are kept read-only. */
    readonly report: (
      via: DeviceVia,
      deviceId: string,
      values: ReadonlyArray<{ readonly itemId: string; readonly value: unknown }>,
    ) => Effect.Effect<void>;
    /** A broker device's own online flag (its last will). */
    readonly seen: (deviceId: string, online: boolean) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<RegisteredDevice>>;
    readonly get: (deviceId: string) => Effect.Effect<RegisteredDevice | null>;
    /** One value, for code that needs a number now (the R1's volume step). */
    readonly value: (deviceId: string, itemId: string) => Effect.Effect<unknown>;
    /** Checked against the item and routed; the caller has already had his yes where one is needed. */
    readonly write: (
      deviceId: string,
      itemId: string,
      value: unknown,
    ) => Effect.Effect<WriteOutcome, DeviceRefusedError>;
    readonly attachWriter: (via: "mqtt", writer: DeviceWriter) => Effect.Effect<void>;
    /** Items the server keeps for devices; a device shows one once the server has reported a value for it. */
    readonly own: (items: ReadonlyArray<DeviceItem>, writer: OwnWriter) => Effect.Effect<void>;
    /** A broker device acknowledged an item write. */
    readonly acked: (
      deviceId: string,
      itemId: string,
      result: { readonly ok: boolean; readonly error?: string },
    ) => Effect.Effect<void>;
    /** A client vessel collects writes for it (and reports how earlier ones went); waits up to `waitMs` for one. */
    readonly take: (
      deviceId: string,
      acks: ReadonlyArray<{ readonly id: string; readonly ok: boolean; readonly error?: string }>,
      waitMs: number,
    ) => Effect.Effect<ReadonlyArray<DeviceWrite>>;
    readonly forget: (deviceId: string) => Effect.Effect<void>;
    /**
     * A client vessel's member, from the session that reported it. The first claim stands: another member's session
     * reporting the same id never takes it over.
     */
    readonly claim: (deviceId: string, member: string) => Effect.Effect<void>;
    /** A private item was just used: its live light shows for `ms`. */
    readonly markLive: (deviceId: string, itemId: string, ms: number) => Effect.Effect<void>;
    readonly changes: Effect.Effect<PubSub.Subscription<DeviceChange>, never, Scope.Scope>;
  }
>()("t3/home/DeviceRegistry") {}

const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<DeviceChange>();
  const devices = new Map<string, Held>();
  const writers = new Map<DeviceVia, DeviceWriter>();
  const acks = new Map<string, Deferred.Deferred<{ ok: boolean; error?: string }>>();
  const queued = new Map<string, Array<DeviceWrite>>();
  const wake = new Map<string, Deferred.Deferred<void>>();
  let counter = 0;
  let owned: { items: ReadonlyArray<DeviceItem>; writer: OwnWriter } | null = null;
  const ownedOf = (d: Held) =>
    (owned?.items ?? []).filter((i) => d.values.has(i.id) && !d.items.some((x) => x.id === i.id));

  const rows = yield* sql<{
    id: string;
    kind: string;
    name: string;
    firmware: string | null;
    via: string;
    version: string | null;
    manifest: string;
    last_seen: number | null;
    member: string | null;
  }>`SELECT id, kind, name, firmware, via, version, manifest, last_seen, member FROM fabric_devices`.pipe(
    Effect.orDie,
  );
  // Pretend vessels kept before they were refused (13 Nov): removed at start.
  for (const row of rows.filter((r) => isTestVessel(r.id))) {
    yield* sql`DELETE FROM fabric_devices WHERE id = ${row.id}`.pipe(Effect.orDie);
    yield* sql`DELETE FROM fabric_device_state WHERE device_id = ${row.id}`.pipe(Effect.orDie);
  }
  for (const row of rows.filter((r) => !isTestVessel(r.id))) {
    const manifest = decodeManifest(parse(row.manifest));
    devices.set(row.id, {
      deviceId: row.id,
      kind: row.kind,
      name: row.name,
      firmware: row.firmware,
      via: row.via === "client" ? "client" : "mqtt",
      version: row.version,
      items: manifest._tag === "Some" ? manifest.value.items.map(withFloor) : [],
      values: new Map(),
      lastSeen: row.last_seen,
      online: null,
      live: new Map(),
      member: row.member,
    });
  }
  const state = yield* sql<{
    device_id: string;
    item_id: string;
    value: string;
    at: number;
  }>`SELECT device_id, item_id, value, at FROM fabric_device_state`.pipe(Effect.orDie);
  for (const id of new Set(state.map((r) => r.device_id).filter(isTestVessel)))
    yield* sql`DELETE FROM fabric_device_state WHERE device_id = ${id}`.pipe(Effect.orDie);
  for (const row of state)
    devices.get(row.device_id)?.values.set(row.item_id, { value: parse(row.value), at: row.at });

  const saveDevice = (d: Held, manifest: string) =>
    sql`
      INSERT INTO fabric_devices (id, kind, name, firmware, via, version, manifest, last_seen, updated_at)
      VALUES (${d.deviceId}, ${d.kind}, ${d.name}, ${d.firmware}, ${d.via}, ${d.version}, ${manifest}, ${d.lastSeen}, ${d.lastSeen ?? 0})
      ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, firmware = excluded.firmware,
        via = excluded.via, version = excluded.version, manifest = excluded.manifest, last_seen = excluded.last_seen,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.orDie);

  const held = (via: DeviceVia, deviceId: string, now: number): Held => {
    let d = devices.get(deviceId);
    if (d === undefined) {
      d = {
        deviceId,
        kind: via === "mqtt" ? "r1" : "device",
        name: deviceId,
        firmware: null,
        via,
        version: null,
        items: [],
        values: new Map(),
        lastSeen: now,
        online: null,
        live: new Map(),
        member: null,
      };
      devices.set(deviceId, d);
    }
    d.lastSeen = now;
    return d;
  };

  const onlineOf = (d: Held, now: number) =>
    d.via === "client"
      ? d.lastSeen !== null && now - d.lastSeen < CLIENT_ONLINE_MS
      : d.online === true;

  const view = (d: Held, now: number): RegisteredDevice => ({
    deviceId: d.deviceId,
    kind: d.kind,
    name: d.name,
    firmware: d.firmware,
    via: d.via,
    online: onlineOf(d, now),
    ...(!onlineOf(d, now) && d.lastSeen !== null && now - d.lastSeen > STALE_MS
      ? { stale: true }
      : {}),
    lastSeenAt: iso(d.lastSeen),
    version: d.version,
    ...(d.member === null ? {} : { member: d.member }),
    items: [...d.items, ...ownedOf(d)],
    values: [...d.values].map(([itemId, v]) => ({ itemId, value: v.value, at: iso(v.at)! })),
    live: [...d.live]
      .filter(([, until]) => until > now)
      .map(([itemId, until]) => ({ itemId, until: iso(until)! })),
  });

  const publish = Effect.fn("DeviceRegistry.publish")(function* (via: DeviceVia, raw: unknown) {
    const decoded = decodeManifest(raw);
    if (decoded._tag === "None")
      return "The manifest is not in the expected shape; it was ignored.";
    const m = decoded.value;
    // Taken and answered, never kept: a pretend vessel must not show as one of his devices.
    if (m.test === true || isTestVessel(m.deviceId)) return null;
    const now = yield* Clock.currentTimeMillis;
    const d = held(via, m.deviceId, now);
    d.kind = m.kind;
    d.name = m.name;
    d.firmware = m.firmware ?? d.firmware;
    d.via = via;
    d.version = m.version ?? null;
    // Later rows with an id already seen are dropped: one item, one meaning.
    const seenIds = new Set<string>();
    d.items = m.items
      .filter((item) => !seenIds.has(item.id) && seenIds.add(item.id))
      .map(withFloor);
    yield* saveDevice(d, JSON.stringify(m));
    return null;
  });

  const report = Effect.fn("DeviceRegistry.report")(function* (
    via: DeviceVia,
    deviceId: string,
    values: ReadonlyArray<{ readonly itemId: string; readonly value: unknown }>,
  ) {
    if (isTestVessel(deviceId)) return;
    const now = yield* Clock.currentTimeMillis;
    const d = held(via, deviceId, now);
    for (const { itemId, value } of values) {
      const text = JSON.stringify(value ?? null);
      if (text.length > MAX_VALUE_CHARS || itemId.length > 80) continue;
      const before = d.values.get(itemId);
      const event = d.items.find((i) => i.id === itemId)?.type === "event";
      if (before !== undefined && !event && same(before.value, value)) continue;
      if (before === undefined && d.values.size >= MAX_ITEMS) continue;
      d.values.set(itemId, { value, at: now });
      yield* sql`
        INSERT INTO fabric_device_state (device_id, item_id, value, at) VALUES (${deviceId}, ${itemId}, ${text}, ${now})
        ON CONFLICT (device_id, item_id) DO UPDATE SET value = excluded.value, at = excluded.at
      `.pipe(Effect.orDie);
      yield* PubSub.publish(changes, {
        deviceId,
        kind: d.kind,
        itemId,
        value,
        previous: before?.value,
        at: now,
      });
    }
  });

  /** Registered before the write goes out, so an ack that comes back at once is not missed. */
  const awaitAck = Effect.fn("DeviceRegistry.awaitAck")(function* (key: string) {
    const done = yield* Deferred.make<{ ok: boolean; error?: string }>();
    acks.set(key, done);
    return Deferred.await(done).pipe(
      Effect.timeoutOption(`${ACK_WAIT_MS} millis`),
      Effect.map((o) => (o._tag === "Some" ? o.value : null)),
      Effect.ensuring(Effect.sync(() => acks.delete(key))),
    );
  });

  const write = Effect.fn("DeviceRegistry.write")(function* (
    deviceId: string,
    itemId: string,
    value: unknown,
  ): Effect.fn.Return<WriteOutcome, DeviceRefusedError> {
    const now = yield* Clock.currentTimeMillis;
    const d = devices.get(deviceId);
    if (d === undefined)
      return yield* new DeviceRefusedError({ why: `No device called ${deviceId} is known here.` });
    const own = ownedOf(d).find((i) => i.id === itemId);
    const item = d.items.find((i) => i.id === itemId) ?? own;
    if (item === undefined)
      return yield* new DeviceRefusedError({ why: `${d.name} has no item ${itemId}.` });
    if (item.safety === "never")
      return yield* new DeviceRefusedError({
        why: `${item.label} on ${d.name} is changed only in Settings.`,
      });
    const checked = checkWrite(item, value);
    if (!checked.ok) return yield* new DeviceRefusedError({ why: checked.why });
    // The server's own item is answered here, whether or not the device is online.
    if (own !== undefined && owned !== null)
      return { status: "done", line: yield* owned.writer(deviceId, itemId, checked.value) };
    if (!onlineOf(d, now))
      return yield* new DeviceRefusedError({
        why: `${d.name} is offline right now. Nothing was sent.`,
      });
    let result: { ok: boolean; error?: string } | null;
    if (d.via === "mqtt") {
      const writer = writers.get("mqtt");
      if (writer === undefined)
        return yield* new DeviceRefusedError({ why: "The devices' broker is not connected." });
      const wait = yield* awaitAck(`${deviceId}|${itemId}`);
      const sent = yield* writer(deviceId, itemId, checked.value);
      result = sent ?? (yield* wait);
    } else {
      const id = `w${now.toString(36)}${(counter++ % 1296).toString(36)}`;
      const wait = yield* awaitAck(`${deviceId}|${id}`);
      const list = queued.get(deviceId) ?? [];
      list.push({ id, itemId, value: checked.value });
      queued.set(deviceId, list);
      const waiter = wake.get(deviceId);
      if (waiter !== undefined) yield* Deferred.succeed(waiter, undefined);
      result = yield* wait;
    }
    if (result !== null && !result.ok)
      return yield* new DeviceRefusedError({
        why: `${d.name} refused it${result.error === undefined ? "." : `: ${result.error}`}`,
      });
    return result === null
      ? { status: "sent", line: `Sent to ${d.name}; it has not confirmed yet.` }
      : { status: "done", line: `${d.name} took it.` };
  });

  const take = Effect.fn("DeviceRegistry.take")(function* (
    deviceId: string,
    done: ReadonlyArray<{ readonly id: string; readonly ok: boolean; readonly error?: string }>,
    waitMs: number,
  ) {
    for (const a of done) {
      const waiter = acks.get(`${deviceId}|${a.id}`);
      if (waiter !== undefined)
        yield* Deferred.succeed(waiter, a.error === undefined ? { ok: a.ok } : a);
    }
    if ((queued.get(deviceId)?.length ?? 0) === 0 && waitMs > 0) {
      const waiter = yield* Deferred.make<void>();
      wake.set(deviceId, waiter);
      yield* Deferred.await(waiter).pipe(
        Effect.timeoutOption(`${Math.min(15_000, Math.max(0, waitMs))} millis`),
      );
      if (wake.get(deviceId) === waiter) wake.delete(deviceId);
      // The long wait counts as being there.
      const d = devices.get(deviceId);
      if (d !== undefined) d.lastSeen = yield* Clock.currentTimeMillis;
    }
    const out = queued.get(deviceId) ?? [];
    queued.delete(deviceId);
    return out;
  });

  return DeviceRegistry.of({
    publish,
    report,
    seen: Effect.fn("DeviceRegistry.seen")(function* (deviceId: string, online: boolean) {
      if (isTestVessel(deviceId)) return;
      const now = yield* Clock.currentTimeMillis;
      const d = devices.get(deviceId) ?? held("mqtt", deviceId, now);
      d.online = online;
      if (online) d.lastSeen = now;
    }),
    list: Effect.map(Clock.currentTimeMillis, (now) =>
      [...devices.values()].map((d) => view(d, now)),
    ),
    get: Effect.fn("DeviceRegistry.get")(function* (deviceId: string) {
      const now = yield* Clock.currentTimeMillis;
      const d = devices.get(deviceId);
      return d === undefined ? null : view(d, now);
    }),
    value: Effect.fn("DeviceRegistry.value")((deviceId: string, itemId: string) =>
      Effect.sync(() => devices.get(deviceId)?.values.get(itemId)?.value ?? null),
    ),
    write,
    attachWriter: Effect.fn("DeviceRegistry.attachWriter")((via: "mqtt", writer: DeviceWriter) =>
      Effect.sync(() => void writers.set(via, writer)),
    ),
    acked: Effect.fn("DeviceRegistry.acked")(function* (
      deviceId: string,
      itemId: string,
      result: { readonly ok: boolean; readonly error?: string },
    ) {
      const waiter = acks.get(`${deviceId}|${itemId}`);
      if (waiter !== undefined) yield* Deferred.succeed(waiter, result);
    }),
    take,
    own: Effect.fn("DeviceRegistry.own")((items: ReadonlyArray<DeviceItem>, writer: OwnWriter) =>
      Effect.sync(() => {
        owned = { items: items.map(withFloor), writer };
      }),
    ),
    forget: Effect.fn("DeviceRegistry.forget")(function* (deviceId: string) {
      devices.delete(deviceId);
      queued.delete(deviceId);
      yield* sql`DELETE FROM fabric_devices WHERE id = ${deviceId}`;
      yield* sql`DELETE FROM fabric_device_state WHERE device_id = ${deviceId}`;
    }, Effect.orDie),
    claim: Effect.fn("DeviceRegistry.claim")(function* (deviceId: string, member: string) {
      const d = devices.get(deviceId);
      if (d === undefined || d.via !== "client" || d.member !== null) return;
      d.member = member;
      yield* sql`UPDATE fabric_devices SET member = ${member} WHERE id = ${deviceId}`;
    }, Effect.orDie),
    changes: PubSub.subscribe(changes),
    markLive: Effect.fn("DeviceRegistry.markLive")(function* (
      deviceId: string,
      itemId: string,
      ms: number,
    ) {
      const now = yield* Clock.currentTimeMillis;
      devices.get(deviceId)?.live.set(itemId, now + ms);
    }),
  });
});

export const layer = Layer.effect(DeviceRegistry, make);
