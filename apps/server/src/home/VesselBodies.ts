// @effect-diagnostics globalJsonInEffect:off preferSchemaOverJson:off globalDate:off nodeBuiltinImport:off -- a small synchronous HMAC per tag check
/**
 * Vessel bodies (VESSEL-BODIES.md): a vessel in a Dock, a plush or a stand knows it from the NFC tag the body
 * carries, and takes that body's values; out of it, it gets its own back. A tag only names a body with a link signed
 * against its own UID; every value lives here, his to change. The R1 reports the tags in its field as `body.tags`.
 */
import type {
  DeviceItem,
  RegisteredDevice,
  VesselBody,
  VesselBodyMint,
  VesselBodyType,
  VesselBodiesView,
} from "@t3tools/baton-contracts";
import { accessOf } from "@t3tools/baton-shared/deviceItems";
import {
  BODY_ITEMS,
  BODY_TYPE_DEFAULTS,
  bodyLink,
  isLinksHost,
  normalUid,
  parseBodyLink,
  postureOf,
  signedText,
} from "@t3tools/baton-shared/vesselBodies";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { BatonRecordService } from "../baton/BatonRecordService.ts";
import { DeviceRefusedError, DeviceRegistry } from "./DeviceRegistry.ts";
import { BARE_BOARD, MAIN_BODY } from "@t3tools/baton-shared/productNames";

interface DeviceBody {
  outer: string | null;
  shell: "pebble" | "bare";
  /** What the body's values replaced, put back when it leaves. */
  before: Record<string, unknown>;
  history: Array<{ at: string; body: string; event: "in" | "out" }>;
}

interface Store {
  linksHost: string | null;
  bodies: Record<string, VesselBody>;
  devices: Record<string, DeviceBody>;
}

export interface MintInput {
  readonly uid: string;
  readonly type: VesselBodyType;
  readonly name: string;
  readonly room?: string | null;
  /** Re-tag: sign an existing body onto this tag. */
  readonly bodyId?: string;
  readonly madeFor?: string | null;
}

export interface EditInput {
  readonly bodyId: string;
  readonly name?: string;
  readonly room?: string | null;
  readonly retired?: boolean;
  /** Forget what it learned. */
  readonly resetValues?: boolean;
}

export class VesselBodies extends Context.Service<
  VesselBodies,
  {
    readonly view: Effect.Effect<VesselBodiesView>;
    readonly mint: (input: MintInput) => Effect.Effect<VesselBodyMint, DeviceRefusedError>;
    readonly edit: (input: EditInput) => Effect.Effect<VesselBody, DeviceRefusedError>;
    readonly setLinksHost: (host: string | null) => Effect.Effect<string, DeviceRefusedError>;
    /** His own change on a vessel in a body is kept for that body; the line says so, or is null. */
    readonly remember: (
      deviceId: string,
      itemId: string,
      value: unknown,
      previous: unknown,
    ) => Effect.Effect<string | null>;
    /** Re-reads one vessel's body; the change stream calls it, and tests. */
    readonly settle: (deviceId: string) => Effect.Effect<void>;
  }
>()("t3/home/VesselBodies") {}

const STORE_KEY = "vessel-bodies";
const HISTORY = 10;
const SECRET = "vessel-body-key";
/** Re-read on these; `body.*` other than the tags are this service's own reports. */
const WATCHED = new Set(["body.tags", "imu.activity", "imu.posture"]);
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const json = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isoOf = (ms: number) => new Date(ms).toISOString();
const freshDevice = (): DeviceBody => ({ outer: null, shell: "pebble", before: {}, history: [] });

/** A body may set what a vessel lets anyone change; never a private item, and never one his yes guards. */
const settable = (item: DeviceItem) =>
  accessOf(item).write &&
  item.privacy !== true &&
  (item.safety === "free" || item.safety === "confirm") &&
  !item.id.startsWith("body.");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* DeviceRegistry;
  const secrets = yield* ServerSecretStore;
  const record = yield* Effect.serviceOption(BatonRecordService);
  const key = Buffer.from(yield* secrets.getOrCreateRandom(SECRET, 32).pipe(Effect.orDie));
  const lock = yield* Semaphore.make(1);

  const rows = yield* sql<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${STORE_KEY}`.pipe(Effect.orDie);
  const saved = json(rows[0]?.value ?? "") ?? {};
  const store: Store = {
    linksHost: typeof saved["linksHost"] === "string" ? saved["linksHost"] : null,
    bodies: (saved["bodies"] ?? {}) as Store["bodies"],
    devices: (saved["devices"] ?? {}) as Store["devices"],
  };
  const persist = Effect.suspend(() =>
    sql`INSERT INTO fabric_settings (key, value) VALUES (${STORE_KEY}, ${JSON.stringify(store)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
      Effect.asVoid,
      Effect.orDie,
    ),
  );

  const mac = (text: string) => NodeCrypto.createHmac("sha256", key).update(text).digest();
  const sigOf = (uid: string, type: VesselBodyType, bodyId: string) =>
    mac(signedText(uid, type, bodyId))
      .subarray(0, 12)
      .toString("base64url");
  const audit = (ref: string, subject: string, outcome: string) =>
    record._tag === "Some"
      ? record.value
          .append({ kind: "device", actor: "body tag", ref, subject, outcome, detail: "nfc" })
          .pipe(Effect.ignore)
      : Effect.void;
  /** A forged or foreign tag is written to the Record once, not on every check while it sits there. */
  const reported = new Set<string>();

  /** The body named by a signed tag in the field, or null; a bad signature never counts. */
  const resolve = Effect.fn("VesselBodies.resolve")(function* (deviceId: string, tags: unknown) {
    if (!Array.isArray(tags)) return null;
    for (const t of tags.slice(0, 8)) {
      const uid = typeof t?.uid === "string" ? normalUid(t.uid) : "";
      const link = parseBodyLink(t?.url);
      if (uid === "" || link === null) continue;
      const good = NodeCrypto.timingSafeEqual(
        Buffer.from(sigOf(uid, link.type, link.bodyId)),
        Buffer.from(link.sig.padEnd(16).slice(0, 16)),
      );
      const body = store.bodies[link.bodyId];
      if (!good || body === undefined || !body.uids.includes(uid)) {
        if (!reported.has(uid)) {
          reported.add(uid);
          yield* audit(
            deviceId,
            "a body tag that isn't ours",
            good ? "unknown body" : "bad signature",
          );
        }
        continue;
      }
      if (!body.retired) return body;
    }
    return null;
  });

  /** Puts back what the old body replaced and sets what the new one asks, skipping what the vessel lacks. */
  const apply = Effect.fn("VesselBodies.apply")(function* (
    d: RegisteredDevice,
    st: DeviceBody,
    body: VesselBody | null,
  ) {
    const target: Record<string, unknown> =
      body === null ? {} : { ...BODY_TYPE_DEFAULTS[body.type], ...body.values };
    const items = new Map(d.items.filter(settable).map((i) => [i.id, i]));
    const current = new Map(d.values.map((v) => [v.itemId, v.value]));
    const writes: Array<[string, unknown]> = [];
    for (const [itemId, value] of Object.entries(st.before))
      if (!(itemId in target)) {
        if (value !== null) writes.push([itemId, value]);
        delete st.before[itemId];
      }
    for (const [itemId, value] of Object.entries(target)) {
      if (!items.has(itemId)) continue;
      if (!(itemId in st.before)) st.before[itemId] = current.get(itemId) ?? null;
      if (!same(current.get(itemId), value)) writes.push([itemId, value]);
    }
    for (const [itemId, value] of writes)
      yield* registry.write(d.deviceId, itemId, value).pipe(Effect.ignore);
  });

  const reportFor = (d: RegisteredDevice, st: DeviceBody, body: VesselBody | null) => {
    const activity = d.values.find((v) => v.itemId === "imu.activity")?.value;
    const r1 = d.kind === "r1";
    const base = r1
      ? st.shell === "bare"
        ? `${BARE_BOARD} (bare board, dev)`
        : MAIN_BODY
      : "no body";
    return [
      { itemId: "body.current", value: body?.name ?? base },
      {
        itemId: "body.type",
        value: body?.type ?? (r1 ? (st.shell === "bare" ? "bare" : "pebble") : "none"),
      },
      { itemId: "body.name", value: body?.name ?? null },
      { itemId: "body.room", value: body?.room ?? null },
      { itemId: "body.posture", value: postureOf(body !== null, activity) },
      ...(r1 ? [{ itemId: "body.shell", value: st.shell }] : []),
      { itemId: "body.history", value: st.history },
    ];
  };

  const settleLocked = Effect.fn("VesselBodies.settle")(function* (deviceId: string) {
    const d = yield* registry.get(deviceId);
    if (d === null) return;
    const st = (store.devices[deviceId] ??= freshDevice());
    const tags = d.values.find((v) => v.itemId === "body.tags")?.value;
    const body = yield* resolve(deviceId, tags);
    const now = isoOf(yield* Clock.currentTimeMillis);
    if ((body?.bodyId ?? null) !== st.outer) {
      const left = st.outer === null ? undefined : store.bodies[st.outer];
      if (left !== undefined) st.history.unshift({ at: now, body: left.name, event: "out" });
      if (body !== null) st.history.unshift({ at: now, body: body.name, event: "in" });
      st.history.length = Math.min(st.history.length, HISTORY);
      st.outer = body?.bodyId ?? null;
      yield* apply(d, st, body);
      yield* persist;
    }
    yield* registry.report(d.via, deviceId, reportFor(d, st, body));
  });
  const settle = (deviceId: string) => lock.withPermits(1)(settleLocked(deviceId));

  /** Every vessel now in this body, re-read after it changed. */
  const resettle = (bodyId: string) =>
    Effect.forEach(
      Object.entries(store.devices).filter(([, st]) => st.outer === bodyId),
      ([id]) => settleLocked(id),
      { discard: true },
    );

  const currentBody = (deviceId: string) => {
    const outer = store.devices[deviceId]?.outer;
    return outer === undefined || outer === null ? null : (store.bodies[outer] ?? null);
  };

  yield* registry.own(BODY_ITEMS, (deviceId, itemId, value) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (itemId === "body.shell") {
          const st = (store.devices[deviceId] ??= freshDevice());
          st.shell = value === "bare" ? "bare" : "pebble";
          yield* persist;
          yield* settleLocked(deviceId);
          return st.shell === "bare"
            ? "Marked as a bare board: dev mode."
            : `Marked as in her ${MAIN_BODY}.`;
        }
        const body = currentBody(deviceId);
        if (body === null)
          return yield* new DeviceRefusedError({
            why: "She isn't in a body right now, so there is nothing to name.",
          });
        const text = typeof value === "string" ? value.trim().slice(0, 60) : "";
        if (itemId === "body.name") {
          if (text === "") return yield* new DeviceRefusedError({ why: "A body needs a name." });
          const was = body.name;
          store.bodies[body.bodyId] = { ...body, name: text };
          yield* persist;
          yield* resettle(body.bodyId);
          return `The ${was} is now called the ${text}.`;
        }
        if (itemId === "body.room") {
          store.bodies[body.bodyId] = { ...body, room: text === "" ? null : text };
          yield* persist;
          yield* resettle(body.bodyId);
          return text === ""
            ? `The ${body.name} has no room now.`
            : `The ${body.name} is in the ${text}.`;
        }
        return yield* new DeviceRefusedError({ why: "That body item can only be read." });
      }),
    ),
  );

  const bodyIdNew = () => {
    const bytes = NodeCrypto.randomBytes(8);
    return [...bytes].map((b) => BASE32[b % 32]).join("");
  };

  const service = VesselBodies.of({
    view: Effect.sync(() => ({
      bodies: Object.values(store.bodies),
      linksHost: store.linksHost,
    })),
    mint: Effect.fn("VesselBodies.mint")(function* (input: MintInput) {
      const uid = normalUid(input.uid);
      if (uid.length < 8 || uid.length > 20)
        return yield* new DeviceRefusedError({ why: "That tag's ID doesn't look right." });
      if (store.linksHost === null)
        return yield* new DeviceRefusedError({
          why: "Set the tag link host first, in Settings → Hardware → Bodies.",
        });
      const existing = input.bodyId === undefined ? undefined : store.bodies[input.bodyId];
      if (input.bodyId !== undefined && existing === undefined)
        return yield* new DeviceRefusedError({ why: "That body isn't known here." });
      // A tag names one body: re-signing it for another takes it off the first.
      for (const b of Object.values(store.bodies))
        if (b.uids.includes(uid) && b.bodyId !== existing?.bodyId)
          store.bodies[b.bodyId] = { ...b, uids: b.uids.filter((u) => u !== uid) };
      const body: VesselBody =
        existing === undefined
          ? {
              bodyId: bodyIdNew(),
              name: input.name.trim().slice(0, 60) || input.type,
              type: input.type,
              room: input.room?.trim().slice(0, 60) || null,
              uids: [uid],
              values: {},
              retired: false,
              madeFor: input.madeFor ?? null,
            }
          : { ...existing, uids: [...new Set([...existing.uids, uid])], retired: false };
      store.bodies[body.bodyId] = body;
      yield* persist;
      yield* audit(body.bodyId, `body tag for the ${body.name}`, "signed");
      const pw = mac(`pwd|${uid}`);
      return {
        bodyId: body.bodyId,
        url: bodyLink(store.linksHost, body.type, body.bodyId, sigOf(uid, body.type, body.bodyId)),
        password: pw.subarray(0, 4).toString("hex"),
        pack: pw.subarray(4, 6).toString("hex"),
      };
    }, lock.withPermits(1)),
    edit: Effect.fn("VesselBodies.edit")(function* (input: EditInput) {
      const body = store.bodies[input.bodyId];
      if (body === undefined)
        return yield* new DeviceRefusedError({ why: "That body isn't known here." });
      const next: VesselBody = {
        ...body,
        ...(input.name === undefined ? {} : { name: input.name.trim().slice(0, 60) || body.name }),
        ...(input.room === undefined ? {} : { room: input.room?.trim().slice(0, 60) || null }),
        ...(input.retired === undefined ? {} : { retired: input.retired }),
        ...(input.resetValues === true ? { values: {} } : {}),
      };
      store.bodies[body.bodyId] = next;
      yield* persist;
      // A retired body lets go of the vessel in it; a renamed one shows its new name.
      yield* resettle(body.bodyId);
      if (input.retired === false)
        yield* Effect.forEach(Object.keys(store.devices), settleLocked, { discard: true });
      return next;
    }, lock.withPermits(1)),
    setLinksHost: Effect.fn("VesselBodies.setLinksHost")(function* (host: string | null) {
      const h = host?.trim().toLowerCase() ?? "";
      if (h !== "" && !isLinksHost(h))
        return yield* new DeviceRefusedError({
          why: "Give a bare host name, like tags.example.com, with no https:// or path.",
        });
      store.linksHost = h === "" ? null : h;
      yield* persist;
      return store.linksHost === null
        ? "New body tags can't be written until a host is set."
        : `New body tags link to ${store.linksHost}. Tags written before keep working.`;
    }, lock.withPermits(1)),
    remember: Effect.fn("VesselBodies.remember")(function* (
      deviceId: string,
      itemId: string,
      value: unknown,
      previous: unknown,
    ) {
      const body = currentBody(deviceId);
      if (body === null || itemId.startsWith("body.")) return null;
      if (same(body.values[itemId], value)) return null;
      const st = store.devices[deviceId]!;
      if (!(itemId in st.before)) st.before[itemId] = previous ?? null;
      store.bodies[body.bodyId] = { ...body, values: { ...body.values, [itemId]: value } };
      yield* persist;
      return `Kept for the ${body.name}.`;
    }, lock.withPermits(1)),
    settle,
  });

  yield* Stream.fromSubscription(yield* registry.changes).pipe(
    Stream.filter((c) => WATCHED.has(c.itemId)),
    Stream.runForEach((c) => settle(c.deviceId)),
    Effect.forkScoped,
  );

  return service;
});

export const layer = Layer.effect(VesselBodies, make);
