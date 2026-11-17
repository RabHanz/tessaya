/**
 * Her health model on the wire (Director, 17 Nov: "she should be able to tell what is causing issues when asked"): the
 * snapshot every host, service and vessel reports, and her plain-words diagnosis of it. Logic: tessaya-shared/health.
 */
import * as Schema from "effect/Schema";

export const BATON_HEALTH_WS_METHODS = { get: "baton.health.get" } as const;

const Num = Schema.NullOr(Schema.Number);

export const HostHealth = Schema.Struct({
  host: Schema.String,
  /** When it was read, epoch ms. */
  at: Schema.Number,
  memTotalMb: Num,
  memAvailMb: Num,
  swapUsedMb: Num,
  /** Pressure stall percent (/proc/pressure); null where the kernel has none. */
  memPsiSome10: Num,
  memPsiFull10: Num,
  memPsiFull60: Num,
  cpuPsiSome10: Num,
  load1: Num,
  cores: Schema.Number,
});
export type HostHealth = typeof HostHealth.Type;

export const ServiceHealth = Schema.Struct({
  /** "room loop", "recogniser <host:port>", "pocket-tts", "t3". */
  name: Schema.String,
  host: Schema.String,
  up: Schema.Boolean,
  /** When this run started, epoch ms; a recent one is a restart. */
  startedAt: Num,
});
export type ServiceHealth = typeof ServiceHealth.Type;

export const StageStat = Schema.Struct({ p50: Num, p90: Num, n: Schema.Number });
export type StageStat = typeof StageStat.Type;

/** A room loop's report on its host and one Tessel it serves (`freya/r1/<id>/state/voicehost`, each minute). */
export const VoiceHostReport = Schema.Struct({
  host: HostHealth,
  services: Schema.Array(ServiceHealth),
  /** The Tessel's kws heard her name this often, and the loop confirmed a wake this often, since `since`. */
  wake: Schema.Struct({ attempts: Schema.Number, accepts: Schema.Number, since: Schema.Number }),
  replay: Schema.Struct({ line: Schema.String, degraded: Schema.Boolean }),
  /** Her server as the loop sees it: median health-check round trip, and when turns could not reach it. */
  brain: Schema.Struct({ rttMs: Num, failures: Schema.Array(Schema.Number) }),
  at: Schema.Number,
});
export type VoiceHostReport = typeof VoiceHostReport.Type;

export const HEALTH_STAGE_KEYS = [
  "endpointMs",
  "asrMs",
  "brainFirstMs",
  "ttsFirstMs",
  "firstSoundMs",
] as const;
export type HealthStage = (typeof HEALTH_STAGE_KEYS)[number];

/** One turn's Voice ID and recogniser figures from the loop's `event/voice/metrics` (never its words). */
export const VoiceIdTurn = Schema.Struct({
  /** When her server heard it, epoch ms. */
  at: Schema.Number,
  /** Who the turn was answered as. */
  speaker: Schema.String,
  speakerScore: Num,
  /** Voice ID's own verdict when it came too late to change the answer. */
  verdict: Schema.optionalKey(Schema.String),
  lifted: Schema.optionalKey(Schema.Boolean),
  /** Cosine to his own earlier pieces in his verified session. */
  same: Schema.optionalKey(Schema.Number),
  replay: Schema.optionalKey(
    Schema.Struct({ verdict: Schema.Literals(["pass", "heard", "unchecked"]), score: Num }),
  ),
  recogniser: Schema.optionalKey(
    Schema.Struct({
      host: Schema.NullOr(Schema.String),
      hedge: Schema.optionalKey(Schema.Literals(["personal", "general"])),
    }),
  ),
});
export type VoiceIdTurn = typeof VoiceIdTurn.Type;

export const VesselHealth = Schema.Struct({
  /** The device id, as in `freya/r1/<id>`. */
  id: Schema.String,
  name: Schema.String,
  online: Schema.NullOr(Schema.Boolean),
  rssi: Num,
  route: Schema.NullOr(Schema.Literals(["wifi", "hotspot"])),
  /** The hub it is connected to now. */
  hub: Schema.NullOr(Schema.String),
  stages: Schema.Struct({
    endpointMs: Schema.optionalKey(StageStat),
    asrMs: Schema.optionalKey(StageStat),
    brainFirstMs: Schema.optionalKey(StageStat),
    ttsFirstMs: Schema.optionalKey(StageStat),
    firstSoundMs: Schema.optionalKey(StageStat),
  }),
  /** Its audio stalls (stream gaps) in the last 15 minutes. */
  stalls: Schema.Number,
  voiceHost: Schema.NullOr(VoiceHostReport),
  /** Its last turns' Voice ID verdicts and recognisers, newest last. */
  turns: Schema.optionalKey(Schema.Array(VoiceIdTurn)),
  /** The turn asking came through it, so it and its voice loop are working whatever their reports say. */
  heard: Schema.optionalKey(Schema.Boolean),
});
export type VesselHealth = typeof VesselHealth.Type;

export const ProviderHealth = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
  note: Schema.String,
});

/** Something that happened lately and explains a change: a room moved off a degraded host, a host's level changed. */
export const HealthNote = Schema.Struct({ at: Schema.Number, says: Schema.String });

export const HealthSnapshot = Schema.Struct({
  at: Schema.Number,
  /** This server's own host first, then each voice host that reports here. */
  hosts: Schema.Array(HostHealth),
  services: Schema.Array(ServiceHealth),
  vessels: Schema.Array(VesselHealth),
  providers: Schema.Array(ProviderHealth),
  /** The room loop's standby state (A9), when this server has a Tessel on its hub. */
  roomLoop: Schema.NullOr(Schema.String),
  notes: Schema.Array(HealthNote),
});
export type HealthSnapshot = typeof HealthSnapshot.Type;

export const HEALTH_SEVERITIES = ["ok", "minor", "degraded", "down"] as const;
export type HealthSeverity = (typeof HEALTH_SEVERITIES)[number];
export const HEALTH_SYMPTOMS = ["slow", "choppy", "wake", "any"] as const;
export type HealthSymptom = (typeof HEALTH_SYMPTOMS)[number];

export const HealthFinding = Schema.Struct({
  /** Stable per cause and place ("memory:orion"), so a repeat is suppressed. */
  key: Schema.String,
  severity: Schema.Literals(HEALTH_SEVERITIES),
  /** The cause in plain words. */
  says: Schema.String,
  evidence: Schema.Array(Schema.String),
  /** What would fix it, in her words; null when nothing can be done from here. */
  fix: Schema.NullOr(Schema.String),
  symptoms: Schema.Array(Schema.Literals(["slow", "choppy", "wake"])),
});
export type HealthFinding = typeof HealthFinding.Type;

export const HealthDiagnosis = Schema.Struct({
  severity: Schema.Literals(HEALTH_SEVERITIES),
  /** The likeliest cause first, in words she can say. */
  summary: Schema.String,
  findings: Schema.Array(HealthFinding),
});
export type HealthDiagnosis = typeof HealthDiagnosis.Type;

export const TessayaHealthInput = Schema.Struct({
  /** What he noticed: slow, choppy, not waking; "any" for a general check. */
  symptom: Schema.optionalKey(Schema.Literals(HEALTH_SYMPTOMS)),
});
export const TessayaHealthResult = Schema.Struct({
  diagnosis: HealthDiagnosis,
  snapshot: HealthSnapshot,
});
export type TessayaHealthResult = typeof TessayaHealthResult.Type;
