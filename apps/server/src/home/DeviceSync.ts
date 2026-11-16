// @effect-diagnostics preferSchemaOverJson:off globalJsonInEffect:off
/**
 * A Tessel's key, his choices for it and every server's hub, alike on all his linked servers (B-044, `device_sync`).
 * Last writer wins per field, so merges commute and repeat harmlessly; a value never confirmed (stamp 0) only fills a
 * gap, so a stale key never overwrites the one the device logs in with. State only: the device's hub answers it.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { fromPeers } from "../peer/PeerVessels.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { R1Hub } from "./R1Hub.ts";

/** The linked-server tool the records travel by. */
const DEVICE_SYNC_TOOL = "device_sync";
/** The record of every server's hub: one field per environment id, `{label, urls}`. */
export const HUBS_RECORD = "@hubs";
const SETTINGS_KEY = "devices.sync";
const MAX_RECORDS = 64;
const MAX_FIELDS = 64;

export interface Stamp {
  readonly v: unknown;
  /** When it was set (ms); 0: seen here but never confirmed, so it only fills a gap. */
  readonly at: number;
  /** The environment that set it; breaks a tie. */
  readonly by: string;
}
export type SyncRecords = Readonly<Record<string, Readonly<Record<string, Stamp>>>>;

const StampSchema = Schema.Struct({
  v: Schema.Unknown,
  at: Schema.Number,
  by: Schema.String.check(Schema.isMaxLength(80)),
});
const RecordsSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, StampSchema));
const decodeRecords = Schema.decodeUnknownOption(RecordsSchema);

/** Whether `a` replaces `b`: a confirmed value, newer, or as new from a later environment id. */
const replaces = (a: Stamp, b: Stamp | undefined): boolean =>
  b === undefined || (a.at > 0 && (a.at > b.at || (a.at === b.at && a.by > b.by)));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Theirs over mine, field by field. Pure; the changed values are what this server applies. */
export const mergeRecords = (
  mine: SyncRecords,
  theirs: SyncRecords,
): {
  readonly next: SyncRecords;
  readonly changed: ReadonlyArray<{
    readonly record: string;
    readonly field: string;
    readonly v: unknown;
  }>;
} => {
  const next: Record<string, Record<string, Stamp>> = Object.fromEntries(
    Object.entries(mine).map(([id, fields]) => [id, { ...fields }]),
  );
  const changed: Array<{ record: string; field: string; v: unknown }> = [];
  for (const [id, fields] of Object.entries(theirs).slice(0, MAX_RECORDS)) {
    const kept = (next[id] ??= {});
    for (const [field, stamp] of Object.entries(fields).slice(0, MAX_FIELDS)) {
      if (!replaces(stamp, kept[field])) continue;
      if (kept[field] === undefined || !same(kept[field]!.v, stamp.v))
        changed.push({ record: id, field, v: stamp.v });
      kept[field] = stamp;
    }
  }
  return { next, changed };
};

export type Applier = (record: string, v: unknown) => Effect.Effect<void>;

export class DeviceSync extends Context.Service<
  DeviceSync,
  {
    /** This environment's id, as stamps and hub entries name it. */
    readonly self: string;
    /**
     * This server's value of one field. `changed`: made here now (confirmed, and sent to his other servers); `seen`:
     * found here, kept unconfirmed and only if nothing is known yet.
     */
    readonly put: (
      record: string,
      field: string,
      v: unknown,
      how: "changed" | "seen",
    ) => Effect.Effect<void>;
    readonly get: (record: string) => Effect.Effect<Readonly<Record<string, Stamp>>>;
    /** Runs whenever a field's value came from another server; owners write it to their own state. */
    readonly onMerged: (field: string, apply: Applier) => Effect.Effect<void>;
    /** A linked server's records merged here; answers this server's, so one call syncs both ways. */
    readonly exchange: (theirs: unknown) => Effect.Effect<SyncRecords>;
  }
>()("t3/home/DeviceSync") {}

/** The key fields a hub admits the device by; never logged. */
const keyOf = (d: R1Device) => ({
  deviceKey: d.deviceKey,
  previousKey: d.previousKey ?? null,
  devicePass: d.devicePass ?? null,
});
const KeyValue = Schema.Struct({
  deviceKey: Schema.String.check(Schema.isMinLength(24), Schema.isMaxLength(200)),
  previousKey: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  devicePass: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
});
const decodeKey = Schema.decodeUnknownOption(KeyValue);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const home = yield* HomeAssistantService;
  const hub = yield* R1Hub;
  const self = String(yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peerMcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);

  const rows = yield* sql<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${SETTINGS_KEY}`.pipe(
    Effect.orElseSucceed(() => []),
  );
  let state: SyncRecords = (() => {
    try {
      return Option.getOrElse(decodeRecords(JSON.parse(rows[0]?.value ?? "{}")), () => ({}));
    } catch {
      return {};
    }
  })();
  const persist = Effect.suspend(() =>
    sql`INSERT INTO fabric_settings (key, value) VALUES (${SETTINGS_KEY}, ${JSON.stringify(state)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
      Effect.ignore,
    ),
  );
  const appliers = new Map<string, Array<Applier>>();
  const push = yield* Queue.sliding<void>(1);

  const applyAll = Effect.fn("DeviceSync.applyAll")(function* (
    changed: ReadonlyArray<{
      readonly record: string;
      readonly field: string;
      readonly v: unknown;
    }>,
  ) {
    for (const c of changed)
      for (const apply of appliers.get(c.field) ?? [])
        yield* apply(c.record, c.v).pipe(Effect.ignoreCause({ log: true }));
  });

  const merge = Effect.fn("DeviceSync.merge")(function* (theirs: unknown) {
    const decoded = decodeRecords(theirs);
    if (Option.isNone(decoded)) return;
    const { next, changed } = mergeRecords(state, decoded.value);
    state = next;
    if (changed.length === 0) return;
    yield* persist;
    yield* applyAll(changed);
  });

  const put = Effect.fn("DeviceSync.put")(function* (
    record: string,
    field: string,
    v: unknown,
    how: "changed" | "seen",
  ) {
    const kept = state[record]?.[field];
    if (how === "seen" ? kept !== undefined : kept !== undefined && kept.at > 0 && same(kept.v, v))
      return;
    const at = how === "seen" ? 0 : yield* Clock.currentTimeMillis;
    state = { ...state, [record]: { ...state[record], [field]: { v, at, by: self } } };
    yield* persist;
    if (how === "changed") Queue.offerUnsafe(push, undefined);
  });

  /** Every record to every linked server, and theirs back. */
  const swap = Effect.gen(function* () {
    if (Option.isNone(links) || Option.isNone(peerMcp)) return;
    const answers = yield* fromPeers(DEVICE_SYNC_TOOL, { records: state }, "10 seconds").pipe(
      Effect.provideService(PeerLinks.PeerLinks, links.value),
      Effect.provideService(PeerMcpClient.PeerMcpClient, peerMcp.value),
    );
    for (const { value } of answers)
      if (typeof value === "object" && value !== null && "records" in value)
        yield* merge((value as { records: unknown }).records);
  }).pipe(Effect.withSpan("DeviceSync.swap"));

  // The key: what this server's hub admits the device by. A local change (a pairing, a rotation, a forget) is told from
  // what this server held last; a key the device is logged in with now is confirmed. A record on a broker of its own
  // is not on any hub: it neither sends nor stays in the way of a key that arrives.
  const lastLocal = new Map<string, string>();
  const keyTick = Effect.fn("DeviceSync.keyTick")(function* () {
    const devices = (yield* home.devices).filter((d) => d.deviceId !== null);
    const onHub = new Map(devices.filter((d) => d.mqttUrl === null).map((d) => [d.deviceId!, d]));
    const ids = new Set([...onHub.keys(), ...lastLocal.keys()]);
    for (const id of ids) {
      const d = onHub.get(id);
      if (d === undefined && devices.some((x) => x.deviceId === id)) continue;
      const v = d === undefined ? null : keyOf(d);
      const before = lastLocal.get(id);
      const now = JSON.stringify(v);
      lastLocal.set(id, now);
      if (before !== undefined && before !== now) yield* put(id, "key", v, "changed");
      else if (v !== null) yield* put(id, "key", v, hub.connected(id) ? "changed" : "seen");
    }
  });
  const applyKey: Applier = Effect.fn("DeviceSync.applyKey")(function* (id: string, v: unknown) {
    const all = yield* home.devices;
    const here = all.find((d) => d.deviceId === id);
    if (v === null) {
      if (here?.mqttUrl === null) yield* home.removeDevice(id);
      lastLocal.set(id, "null");
      return;
    }
    const key = decodeKey(v);
    if (Option.isNone(key)) return;
    // On every hub it is that server's own hub; a broker of its own on this record is left behind.
    const next: R1Device = {
      deviceId: id,
      mqttUrl: null,
      mqttUser: null,
      mqttPass: null,
      ...key.value,
    };
    const done = yield* home.putDevice(next).pipe(Effect.option);
    if (Option.isSome(done)) lastLocal.set(id, JSON.stringify(keyOf(next)));
  });
  appliers.set("key", [applyKey]);

  yield* Queue.take(push).pipe(
    Effect.andThen(swap),
    Effect.ignoreCause({ log: true }),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* keyTick().pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.forkScoped,
  );
  // A server that was away (a power cut) catches up within minutes of coming back, both ways.
  yield* swap.pipe(
    Effect.delay("15 seconds"),
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("2 minutes")),
    Effect.forkScoped,
  );

  return DeviceSync.of({
    self,
    put,
    get: Effect.fn("DeviceSync.get")(function* (record: string) {
      return state[record] ?? {};
    }),
    onMerged: Effect.fn("DeviceSync.onMerged")(function* (field: string, apply: Applier) {
      appliers.set(field, [...(appliers.get(field) ?? []), apply]);
    }),
    exchange: Effect.fn("DeviceSync.exchange")(function* (theirs: unknown) {
      yield* merge(theirs);
      return state;
    }),
  });
});

export const layer = Layer.effect(DeviceSync, make);
