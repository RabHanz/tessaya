// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Her health model on this server (Director, 17 Nov): this host from /proc, every Tessel's room loop report and turn
 * times from the broker, the room loop's standby state and recent placement moves, folded into one snapshot, and the
 * diagnosis she gives from it. Read on demand (her tool, Settings → Health) and by the pulse's sense pass; no polling.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import type {
  HealthSnapshot,
  HealthSymptom,
  HostHealth,
  ServiceHealth,
  TessayaHealthResult,
} from "@t3tools/tessaya-contracts";
import {
  diagnose,
  HEALTH_STAGES,
  hostHealthOf,
  REPORT_STALE_MS,
  stageStatOf,
} from "@t3tools/tessaya-shared/health";
import type { ActorKind } from "@t3tools/tessaya-shared/provenance";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HomeDevices } from "../home/HomeDevices.ts";
import { R1Loop } from "../home/R1Loop.ts";
import { ActionLog, emitAction } from "../provenance/ActionLog.ts";

const STALL_WINDOW_MS = 15 * 60_000;
const NOTES_MS = 30 * 60_000;
const startedAt = Date.now() - process.uptime() * 1000;

const proc = (path: string) => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export const readSelf = (now: number): HostHealth =>
  hostHealthOf({
    host: NodeOS.hostname(),
    at: now,
    cores: NodeOS.availableParallelism(),
    meminfo: proc("/proc/meminfo"),
    loadavg: proc("/proc/loadavg"),
    psiMemory: proc("/proc/pressure/memory"),
    psiCpu: proc("/proc/pressure/cpu"),
  });

const field = (data: unknown, key: string) => {
  const v =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : null;
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
};

/** The failover lane's actions (room.placement.*, host.health.level), as lines she can say. */
const noteOf = (a: { readonly kind: string; readonly subject: string; readonly data: unknown }) =>
  a.kind === "host.health.level"
    ? `${a.subject}'s health went to ${field(a.data, "level") ?? "a new level"}`
    : `${a.subject} moved${field(a.data, "from") === null ? "" : ` from ${field(a.data, "from")}`}${field(a.data, "to") === null ? "" : ` to ${field(a.data, "to")}`}${field(a.data, "why") === null ? "" : ` because ${field(a.data, "why")}`}`;

/** One snapshot of everything: this host first, then each voice host that reported in the last few minutes. */
export const snapshot = Effect.fn("TessayaHealth.snapshot")(function* () {
  const now = yield* Clock.currentTimeMillis;
  const self = readSelf(now);
  const devices = yield* Effect.serviceOption(HomeDevices);
  const overview = Option.isSome(devices) ? yield* devices.value.overview : null;
  const heard = Option.isSome(devices) ? yield* devices.value.heardHealth : [];
  const vessels = (overview?.devices ?? [])
    .filter((d) => d.configured || d.online === true)
    .map((d) => {
      const h = heard.find((x) => x.id === d.id);
      const current = d.wifi?.find((w) => w.current);
      return {
        id: d.id,
        name: d.name,
        online: d.online,
        rssi: d.rssi,
        route:
          current === undefined ? null : current.hotspot ? ("hotspot" as const) : ("wifi" as const),
        hub: d.hubs?.find((x) => x.current)?.label ?? null,
        stages: Object.fromEntries(
          HEALTH_STAGES.flatMap(([k]) => {
            const samples = h?.samples[k] ?? [];
            return samples.length === 0 ? [] : [[k, stageStatOf(samples)]];
          }),
        ),
        stalls: (h?.stalls ?? []).filter((at) => now - at < STALL_WINDOW_MS).length,
        voiceHost: h?.voiceHost ?? null,
      };
    });
  const fresh = vessels
    .flatMap((v) => (v.voiceHost === null ? [] : [v.voiceHost]))
    .filter((r) => now - r.at <= REPORT_STALE_MS)
    .toSorted((a, b) => b.at - a.at);
  const hosts = new Map<string, HostHealth>([[self.host, self]]);
  const services = new Map<string, ServiceHealth>([
    [`${self.host}|t3`, { name: "t3", host: self.host, up: true, startedAt }],
  ]);
  for (const r of fresh) {
    if (!hosts.has(r.host.host)) hosts.set(r.host.host, r.host);
    for (const s of r.services)
      if (!services.has(`${s.host}|${s.name}`)) services.set(`${s.host}|${s.name}`, s);
  }
  const loop = yield* Effect.serviceOption(R1Loop);
  const roomLoop = Option.isSome(loop) ? ((yield* loop.value.status)?.line ?? null) : null;
  const log = yield* Effect.serviceOption(ActionLog);
  const actions = Option.isSome(log)
    ? [
        ...(yield* log.value.list({
          since: now - NOTES_MS,
          kindPrefix: "room.placement",
          limit: 5,
        })),
        ...(yield* log.value.list({ since: now - NOTES_MS, kindPrefix: "host.health", limit: 5 })),
      ]
    : [];
  return {
    at: now,
    hosts: [...hosts.values()],
    services: [...services.values()],
    vessels,
    // shortcut: brain providers and their fallbacks are not in the snapshot yet; add when the brain route records them.
    providers: [],
    roomLoop,
    notes: actions.toSorted((a, b) => b.at - a.at).map((a) => ({ at: a.at, says: noteOf(a) })),
  } satisfies HealthSnapshot;
});

/**
 * Why she is slow, choppy or not waking: the snapshot and its diagnosis, and one action recording what she concluded
 * and who asked, so a later "why did you say that?" can find it.
 */
export const explain = Effect.fn("TessayaHealth.explain")(function* (
  symptom: HealthSymptom,
  by: { readonly kind: ActorKind; readonly id: string },
) {
  const snap = yield* snapshot();
  const diagnosis = diagnose(snap, symptom);
  yield* emitAction({
    kind: "health.diagnosis",
    actor: { kind: by.kind, id: by.id, certainty: 1 },
    subject: symptom,
    outcome: diagnosis.severity,
    evidence: diagnosis.findings.slice(0, 4).map((f) => ({ kind: "health", ref: f.key })),
    data: { summary: diagnosis.summary },
  });
  return { diagnosis, snapshot: snap } satisfies TessayaHealthResult;
});
