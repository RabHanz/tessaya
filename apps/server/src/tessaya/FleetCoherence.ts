// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Every machine on the same page (M-146): this server's fingerprint (build, brain, login, store digests), sent to the
 * brain each minute by a worker, and the fingerprints the brain has been sent, which `TessayaHealth.snapshot` compares
 * with its own (`@t3tools/tessaya-shared/coherence`).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FleetFingerprint, type RegisteredDevice } from "@t3tools/tessaya-contracts";
import { secretDigest, storeOf } from "@t3tools/tessaya-shared/coherence";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { brainOn, makeBrainLink } from "./BrainHost.ts";
import { accountOfConfigDir } from "./ClaudeLiveSessions.ts";
import { CONSENT_KEY } from "./consent.ts";

const startedAt = Date.now() - process.uptime() * 1000;
/** The commit this build was cut from, stamped by the release build; null for a dev run. */
const buildCommit = process.env["TESSAYA_BUILD_COMMIT"] || null;

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** This host's IPs and names, so a loop's brain URL naming any of them reads as this server. */
const addresses = () => [
  NodeOS.hostname(),
  ...Object.values(NodeOS.networkInterfaces()).flatMap((list) =>
    (list ?? []).filter((a) => !a.internal).map((a) => a.address),
  ),
];

/** The Claude login this machine's sessions spend: its label and a digest of its token. */
const claudeAccount = () => {
  const dir = NodePath.join(NodeOS.homedir(), ".claude");
  const creds = readJson(NodePath.join(dir, ".credentials.json")) as {
    claudeAiOauth?: { accessToken?: unknown };
  } | null;
  const token = creds?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token === "") return null;
  return { label: accountOfConfigDir(dir) ?? "unnamed", digest: secretDigest(token) };
};

const rowsOf = <A, E>(effect: Effect.Effect<ReadonlyArray<A>, E>) =>
  effect.pipe(Effect.orElseSucceed((): ReadonlyArray<A> => []));

/** The shared stores this server keeps a copy of, as digests (coherence.ts SHARED_STORES). */
const storesHere = Effect.fn("FleetCoherence.stores")(function* (stateDir: string | null) {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const dictionary =
    stateDir === null ? null : readJson(NodePath.join(stateDir, "voice", "dictionary.json"));
  const stores: Record<string, ReturnType<typeof storeOf>> = {};
  if (Array.isArray(dictionary))
    stores["dictionary"] = storeOf(dictionary.map((e) => JSON.stringify(e)));
  if (Option.isNone(sql)) return stores;
  const db = sql.value;
  const voices = yield* rowsOf(
    db<{ member_id: string; samples: number; centroid: string }>`
      SELECT member_id, samples, centroid FROM tessaya_voice_profiles`,
  );
  stores["voiceProfiles"] = storeOf(
    voices.map((v) => `${v.member_id}|${v.samples}|${v.centroid}`),
    voices.length === 0
      ? "none"
      : voices.map((v) => `${v.member_id}: ${v.samples} samples`).join(", "),
  );
  const consent = yield* rowsOf(
    db<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${CONSENT_KEY}`,
  );
  const grants = consent[0] === undefined ? null : readGrants(consent[0].value);
  stores["consent"] = storeOf(grants ?? []);
  const prefs = yield* rowsOf(
    db<Record<string, unknown>>`SELECT * FROM tessaya_member_preferences`,
  );
  stores["memberPreferences"] = storeOf(prefs.map((p) => JSON.stringify(p)));
  return stores;
});

const readGrants = (value: string): Array<string> | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((g) => JSON.stringify(g)) : [value];
  } catch {
    return [value];
  }
};

/** This server's fingerprint now. */
export const selfFingerprint = Effect.fn("FleetCoherence.self")(function* () {
  const config = yield* Effect.serviceOption(ServerConfig);
  const env = yield* Effect.serviceOption(ServerEnvironment);
  const id = Option.isNone(env) ? NodeOS.hostname() : String(yield* env.value.getEnvironmentId);
  const label = Option.isNone(env) ? NodeOS.hostname() : (yield* env.value.getDescriptor).label;
  const home = yield* brainOn;
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const link =
    home === null || Option.isNone(links)
      ? undefined
      : (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).find(
          (l) => l.label === home,
        );
  return {
    id,
    name: label,
    kind: "server",
    host: NodeOS.hostname(),
    addresses: addresses(),
    version: packageJson.version,
    commit: buildCommit,
    startedAt,
    // a home the links don't know is still named, so "talks to an unknown brain" is said rather than hidden
    brain: home === null ? null : `env:${link?.environmentId ?? home}`,
    account: claudeAccount(),
    stores: yield* storesHere(Option.isNone(config) ? null : config.value.stateDir),
    sentAt: yield* Clock.currentTimeMillis,
  } satisfies FleetFingerprint;
});

export class FleetCoherence extends Context.Service<
  FleetCoherence,
  {
    /** On the brain: a worker's fingerprint, stamped with when it arrived. */
    readonly record: (fp: FleetFingerprint) => Effect.Effect<void>;
    /** Every fingerprint the brain has been sent, one per machine, newest kept. */
    readonly received: Effect.Effect<ReadonlyArray<FleetFingerprint>>;
  }
>()("t3/tessaya/FleetCoherence") {}

export const layer = Layer.effect(
  FleetCoherence,
  Effect.gen(function* () {
    const kept = yield* Ref.make(new Map<string, FleetFingerprint>());
    return FleetCoherence.of({
      record: Effect.fn("FleetCoherence.record")(function* (fp: FleetFingerprint) {
        const receivedAt = yield* Clock.currentTimeMillis;
        yield* Ref.update(kept, (m) => new Map(m).set(fp.id, { ...fp, receivedAt }));
      }),
      received: Effect.map(Ref.get(kept), (m) => [...m.values()]),
    });
  }),
);

/**
 * A device in the registry as a fingerprint: any hardware that publishes a manifest is in the fleet check with no code
 * of its own. It reached this server's registry, so its brain is this server; it was last heard at its newest value.
 */
export const deviceFingerprint = (d: RegisteredDevice, home: string): FleetFingerprint => {
  const heard = Math.max(
    d.lastSeenAt === null ? 0 : Date.parse(d.lastSeenAt),
    ...d.values.map((v) => Date.parse(v.at) || 0),
  );
  return {
    id: d.deviceId,
    name: d.name,
    kind: d.kind,
    host: d.deviceId,
    version: d.firmware ?? d.version ?? "unknown",
    commit: d.version,
    startedAt: 0,
    brain: `env:${home}`,
    account: null,
    stores: {},
    sentAt: heard,
    receivedAt: heard,
  };
};

export const decodeFingerprint = Schema.decodeUnknownOption(FleetFingerprint);

/** A worker tells its brain what it believes each minute; on the brain this does nothing. */
export const reportLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const brain = yield* makeBrainLink;
    const send = Effect.gen(function* () {
      if (yield* brain.isBrain) return;
      yield* brain.send("fingerprint", yield* selfFingerprint());
    }).pipe(Effect.ignoreCause({ log: true }));
    yield* send.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  }),
);
