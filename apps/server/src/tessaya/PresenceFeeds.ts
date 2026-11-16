/**
 * The presence feeders that watch rather than get told (B-043): members' own devices in this machine's neighbour table,
 * and Home Assistant's people, routers' device trackers, occupancy sensors and calendars, once a minute into
 * TessayaPresence. Each is a row of `PRESENCE_SOURCES`; the mapping is pure in `@t3tools/tessaya-shared/presence`.
 */
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import {
  arpMacs,
  devicesOf,
  homeAssistantSignals,
  lanSignals,
  type PresenceMember,
} from "@t3tools/tessaya-shared/presence";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { TessayaPresence } from "./TessayaPresence.ts";

/** Every member with their name and own devices (the `devices` preference), for the feeders to tie a device to them. */
export const presenceMembers = Effect.fn("PresenceFeeds.members")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string; name: string; devices: string | null }>`
    SELECT m.id, m.name, p.value AS devices FROM tessaya_household_members m
    LEFT JOIN tessaya_member_preferences p ON p.member_id = m.id AND p.key = 'devices'
    WHERE m.removed_at IS NULL`.pipe(Effect.orElseSucceed(() => []));
  return rows.map((r): PresenceMember => ({
    id: r.id,
    name: r.name,
    devices: devicesOf(r.devices ?? undefined),
  }));
});

export const make = Effect.gen(function* () {
  const presence = yield* TessayaPresence;
  const sql = yield* SqlClient.SqlClient;
  const home = yield* Effect.serviceOption(HomeAssistantService);
  const registry = yield* Effect.serviceOption(DeviceRegistry);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  // Home Assistant's "away" is noted when it changes, so a minute's sweep never cancels a newer sign they are back.
  const lastHa = new Map<string, string>();
  const sweep = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    const members = yield* presenceMembers().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    if (members.length === 0) return;
    const table = Option.isNone(fs)
      ? ""
      : yield* fs.value.readFileString("/proc/net/arp").pipe(Effect.orElseSucceed(() => ""));
    const signals = [...lanSignals(arpMacs(table), members, at)];
    if (Option.isSome(home)) {
      const vessels = Option.isNone(registry) ? [] : yield* registry.value.list;
      for (const s of homeAssistantSignals({
        entities: yield* home.value.presenceEntities,
        members,
        vessels: vessels.map((v) => ({ id: v.deviceId, name: v.name })),
        owner: OWNER_MEMBER_ID,
        at,
      })) {
        if (s.member !== null && (s.source === "haHome" || s.source === "haAway")) {
          const was = lastHa.get(s.member);
          lastHa.set(s.member, s.source);
          if (s.source === "haAway" && was === "haAway") continue;
        }
        signals.push(s);
      }
    }
    for (const s of signals) yield* presence.note(s);
  });
  yield* sweep.pipe(
    Effect.ignoreCause,
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
