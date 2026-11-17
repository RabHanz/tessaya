/**
 * Her health model (Director, 17 Nov: "she should be able to tell what is causing issues when asked"). One compact
 * snapshot of every host, service and vessel, and `diagnose`, which names the likeliest cause in plain words with its
 * evidence. Pure: the server and the room loop read /proc and pass the text in; web and mobile render the result.
 */

import {
  VoiceHostReport,
  type HealthDiagnosis,
  type HealthFinding,
  type HealthSeverity,
  type HealthSnapshot,
  type HealthStage,
  type HealthSymptom,
  type HostHealth,
  type ServiceHealth,
  type StageStat,
  type VesselHealth,
} from "@t3tools/tessaya-contracts";

import { hostHealthOf } from "./hostHealth.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export { hostHealthOf };
export type {
  HealthDiagnosis,
  HealthFinding,
  HealthSnapshot,
  HealthSymptom,
  HostHealth,
  ServiceHealth,
  VesselHealth,
  VoiceHostReport,
};

/** The room loop's per-turn metric keys in pipeline order (roomVoice.ts TurnMetrics), as she says them. */
export const HEALTH_STAGES: ReadonlyArray<readonly [HealthStage, string]> = [
  ["endpointMs", "turn detection"],
  ["asrMs", "speech"],
  ["brainFirstMs", "the brain"],
  ["ttsFirstMs", "her voice"],
  ["firstSoundMs", "the whole reply"],
];

/** Above these a stage's median is slow (ms). firstSoundMs is the sum the others explain, so it is not a cause. */
const STAGE_BUDGET_MS: Readonly<Record<HealthStage, number>> = {
  endpointMs: 1_200,
  asrMs: 800,
  brainFirstMs: 3_000,
  ttsFirstMs: 900,
  firstSoundMs: 5_000,
};

const RANK: Readonly<Record<HealthSeverity, number>> = { ok: 0, minor: 1, degraded: 2, down: 3 };

const decodeReport = Schema.decodeUnknownOption(VoiceHostReport);
/** A room loop's `state/voicehost` as it came off the broker; null when it is not one. */
export const voiceHostReportOf = (body: unknown): VoiceHostReport | null =>
  Option.getOrNull(decodeReport(body));

/** Median and 90th percentile of the last `last` samples. */
export const stageStatOf = (samples: ReadonlyArray<number>, last = 10): StageStat => {
  const s = samples.slice(-last).toSorted((a, b) => a - b);
  const at = (q: number) =>
    s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p50: at(0.5), p90: at(0.9), n: s.length };
};

/** A voice host that has not reported for this long has stopped: its room loop is down. */
export const REPORT_STALE_MS = 3 * 60_000;
const RECENT_START_MS = 10 * 60_000;
const NOTE_RECENT_MS = 30 * 60_000;
const BRAIN_FAIL_WINDOW_MS = 15 * 60_000;

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const ago = (now: number, at: number) => {
  const min = Math.max(1, Math.round((now - at) / 60_000));
  return min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

const hostFindings = (h: HostHealth, now: number): Array<HealthFinding> => {
  if (now - h.at > REPORT_STALE_MS) return [];
  const out: Array<HealthFinding> = [];
  const full = Math.max(h.memPsiFull10 ?? 0, h.memPsiFull60 ?? 0);
  const some = h.memPsiSome10 ?? 0;
  const availPct =
    h.memAvailMb === null || h.memTotalMb === null || h.memTotalMb === 0
      ? null
      : (h.memAvailMb / h.memTotalMb) * 100;
  const lowMem = availPct !== null && availPct < 5;
  if (full >= 5 || some >= 20 || (lowMem && (h.swapUsedMb ?? 0) > 0)) {
    const evidence = [
      `memory pressure: everything stalled ${Math.round(full)}% of the time${some > full ? ` (some tasks ${Math.round(some)}%)` : ""}`,
      ...(h.memAvailMb === null ? [] : [`${h.memAvailMb} MB free of ${h.memTotalMb} MB`]),
      ...((h.swapUsedMb ?? 0) > 0 ? [`${h.swapUsedMb} MB in swap`] : []),
    ];
    out.push({
      key: `memory:${h.host}`,
      severity: full >= 20 ? "down" : "degraded",
      says: `${h.host} is short of memory and swapping`,
      evidence,
      fix: `free memory on ${h.host}: stop a heavy job there, or move the voice to another machine`,
      symptoms: ["slow", "choppy", "wake"],
    });
  }
  const cpu = h.cpuPsiSome10 ?? 0;
  const perCore = h.load1 === null ? 0 : h.load1 / Math.max(1, h.cores);
  if (cpu >= 50 || perCore >= 2) {
    out.push({
      key: `cpu:${h.host}`,
      severity: cpu >= 80 || perCore >= 4 ? "degraded" : "minor",
      says: `${h.host}'s processor is overloaded`,
      evidence: [
        ...(h.cpuPsiSome10 === null
          ? []
          : [`tasks waited for the processor ${Math.round(cpu)}% of the time`]),
        ...(h.load1 === null ? [] : [`load ${h.load1.toFixed(1)} on ${h.cores} cores`]),
      ],
      fix: `let the heavy work on ${h.host} finish, or stop it`,
      symptoms: ["slow", "choppy"],
    });
  }
  return out;
};

const serviceFindings = (services: ReadonlyArray<ServiceHealth>, now: number) =>
  services.flatMap((s): Array<HealthFinding> => {
    if (!s.up)
      return [
        {
          key: `down:${s.host}:${s.name}`,
          severity: "down",
          says: `the ${s.name} on ${s.host} is down`,
          evidence: [`${s.name} did not answer its health check`],
          fix: `restart the ${s.name} on ${s.host}`,
          symptoms: ["slow", "wake"],
        },
      ];
    if (s.startedAt !== null && now - s.startedAt < RECENT_START_MS)
      return [
        {
          key: `restart:${s.host}:${s.name}`,
          severity: "minor",
          says: `the ${s.name} on ${s.host} restarted ${ago(now, s.startedAt)}`,
          evidence: [`it has been up since ${ago(now, s.startedAt)}`],
          fix: null,
          symptoms: ["slow", "wake"],
        },
      ];
    return [];
  });

const vesselFindings = (v: VesselHealth, now: number): Array<HealthFinding> => {
  const out: Array<HealthFinding> = [];
  const r = v.voiceHost;
  if (v.online === false)
    out.push({
      key: `offline:${v.id}`,
      severity: "down",
      says: `${v.name} is offline`,
      evidence: [`${v.name} is not connected to the hub`],
      fix: `check ${v.name} is powered and on Wi-Fi`,
      symptoms: ["wake"],
    });
  if (v.online !== false && (r === null || now - r.at > REPORT_STALE_MS))
    out.push({
      key: `loop:${v.id}`,
      severity: "down",
      says: `the voice loop that listens for ${v.name} has stopped reporting, so nothing hears her name`,
      evidence: [
        r === null ? "no report from a voice loop" : `its last report was ${ago(now, r.at)}`,
      ],
      fix: "restart the voice loop (tessel-voice) on its machine",
      symptoms: ["wake"],
    });
  if (r !== null && now - r.at <= REPORT_STALE_MS) {
    const fails = r.brain.failures.filter((at) => now - at < BRAIN_FAIL_WINDOW_MS);
    if (fails.length > 0)
      out.push({
        key: `brain:${v.id}`,
        severity: "degraded",
        says: `my server did not answer ${fails.length} time${fails.length === 1 ? "" : "s"} lately, last ${ago(now, Math.max(...fails))}; those turns could not be answered`,
        evidence: [`${fails.length} turns from ${v.name} failed to reach her server in 15 min`],
        fix: "if the server was being restarted or updated, it is back; otherwise check it is up",
        symptoms: ["wake", "slow"],
      });
    const { attempts, accepts } = r.wake;
    if (attempts >= 3 && accepts / attempts < 0.5)
      out.push({
        key: `wake:${v.id}`,
        severity: "degraded",
        says: `${v.name} heard her name ${attempts} times but the check confirmed only ${accepts}`,
        evidence: [`${accepts} of ${attempts} wakes accepted since ${ago(now, r.wake.since)}`],
        fix: "say the name a little clearer, or retrain the wake word if it keeps happening",
        symptoms: ["wake"],
      });
    if (r.replay.degraded)
      out.push({
        key: `replay:${v.id}`,
        severity: "minor",
        says: `the replay check on ${r.host.host} is not running`,
        evidence: [r.replay.line],
        fix: "reinstall the voice models on that machine",
        symptoms: ["wake"],
      });
    if (r.brain.rttMs !== null && r.brain.rttMs >= 400)
      out.push({
        key: `rtt:${v.id}`,
        severity: r.brain.rttMs >= 1_000 ? "degraded" : "minor",
        says: `the link from ${r.host.host} to her server is slow`,
        evidence: [`round trip ${Math.round(r.brain.rttMs)} ms`],
        fix: "check the internet or tailnet link on that machine",
        symptoms: ["slow"],
      });
  }
  if (v.rssi !== null && v.rssi <= -75)
    out.push({
      key: `wifi:${v.id}`,
      severity: v.rssi <= -82 ? "degraded" : "minor",
      says: `${v.name}'s Wi-Fi signal is weak${v.route === "hotspot" ? " and it is on the phone's hotspot" : ""}`,
      evidence: [`signal ${v.rssi} dBm`, ...(v.route === "hotspot" ? ["on the hotspot"] : [])],
      fix: `move ${v.name} closer to the router${v.route === "hotspot" ? ", or back onto the home Wi-Fi" : ""}`,
      symptoms: ["choppy", "slow"],
    });
  else if (v.route === "hotspot")
    out.push({
      key: `hotspot:${v.id}`,
      severity: "minor",
      says: `${v.name} is on the phone's hotspot, not the home Wi-Fi`,
      evidence: ["connected through the hotspot"],
      fix: `put ${v.name} back on the home Wi-Fi`,
      symptoms: ["choppy", "slow"],
    });
  if (v.stalls >= 2)
    out.push({
      key: `stalls:${v.id}`,
      severity: v.stalls >= 5 ? "degraded" : "minor",
      says: `${v.name}'s audio stalled ${v.stalls} times in the last 15 minutes`,
      evidence: [`${v.stalls} stream gaps`],
      fix: null,
      symptoms: ["choppy"],
    });
  // The slowest stage against its budget: the place a slow turn spent its time.
  const slow = HEALTH_STAGES.filter(([k]) => k !== "firstSoundMs")
    .map(([k, words]) => ({ k, words, p50: v.stages[k]?.p50 ?? null }))
    .filter((s) => s.p50 !== null && s.p50 > STAGE_BUDGET_MS[s.k])
    .toSorted((a, b) => b.p50! / STAGE_BUDGET_MS[b.k] - a.p50! / STAGE_BUDGET_MS[a.k]);
  if (slow.length > 0) {
    const top = slow[0]!;
    out.push({
      key: `stage:${v.id}:${top.k}`,
      severity: top.p50! > STAGE_BUDGET_MS[top.k] * 2 ? "degraded" : "minor",
      says: `on ${v.name}, ${top.words} waited ${sec(top.p50!)} a turn lately`,
      evidence: slow.map(
        (s) => `${s.words} waited ${sec(s.p50!)} (usually under ${sec(STAGE_BUDGET_MS[s.k])})`,
      ),
      fix: null,
      symptoms: ["slow"],
    });
  }
  return out;
};

/** A cause beats a symptom: a stage that is slow because its host is starving says so in one line. */
const explainsStage = (cause: HealthFinding, stage: HealthFinding) =>
  stage.key.startsWith("stage:") &&
  (cause.key.startsWith("memory:") || cause.key.startsWith("cpu:") || cause.key.startsWith("rtt:"));

/**
 * The likeliest causes of `symptom`, worst first. A slow stage is folded into the host trouble that explains it, so
 * the first sentence names the cause and the evidence carries the wait ("the speech engine waited 1.8 s").
 */
export const diagnose = (s: HealthSnapshot, symptom: HealthSymptom = "any"): HealthDiagnosis => {
  const all = [
    ...s.hosts.flatMap((h) => hostFindings(h, s.at)),
    ...serviceFindings(s.services, s.at),
    ...s.vessels.flatMap((v) => vesselFindings(v, s.at)),
    ...s.notes
      .filter((n) => s.at - n.at < NOTE_RECENT_MS)
      .map((n): HealthFinding => ({
        key: `note:${n.at}`,
        severity: "minor",
        says: n.says,
        evidence: [`${ago(s.at, n.at)}`],
        fix: null,
        symptoms: ["slow", "wake"],
      })),
    ...s.providers
      .filter((p) => !p.ok)
      .map((p): HealthFinding => ({
        key: `provider:${p.name}`,
        severity: "degraded",
        says: `the ${p.name} brain is unavailable`,
        evidence: [p.note],
        fix: null,
        symptoms: ["slow"],
      })),
  ];
  const relevant = all
    .filter((f) => symptom === "any" || f.symptoms.includes(symptom))
    .toSorted((a, b) => RANK[b.severity] - RANK[a.severity]);
  const stageOf = relevant.find((f) => f.key.startsWith("stage:"));
  const cause = relevant.find((f) => stageOf !== undefined && explainsStage(f, stageOf));
  const findings =
    cause === undefined || stageOf === undefined
      ? relevant
      : relevant
          .filter((f) => f !== stageOf)
          .map((f) => (f === cause ? { ...f, evidence: [...stageOf.evidence, ...f.evidence] } : f));
  const top = findings[0];
  if (top === undefined)
    return {
      severity: "ok",
      summary:
        symptom === "any"
          ? "Everything looks healthy: memory, the services, the network and recent turns are all normal."
          : "Nothing in my health readings explains that: memory, the services, the network and recent turns all look normal.",
      findings: [],
    };
  const because = top.evidence[0];
  const cap = (t: string) => `${t[0]!.toUpperCase()}${t.slice(1)}`;
  const summary = `${cap(top.says)}.${because === undefined ? "" : ` ${cap(because)}.`}`;
  return { severity: top.severity, summary, findings };
};

/** A cause has to hold this many pulse senses (one a minute) before she raises it: a blip is never news. */
export const HEALTH_PERSIST_SENSES = 3;

export interface HealthEpisode {
  readonly key: string;
  readonly since: number;
  readonly count: number;
}

/**
 * The pulse's view of her health: the worst degraded cause, how long it has held, and once it has held long enough,
 * the one notice for it. Its id names the episode, so the pulse raises it once until the cause clears and returns.
 */
export const healthNotice = (
  prev: HealthEpisode | null,
  d: HealthDiagnosis,
  now: number,
): {
  readonly episode: HealthEpisode | null;
  readonly notice: { readonly id: string; readonly text: string; readonly weight: number } | null;
} => {
  const top = d.findings.find((f) => RANK[f.severity] >= RANK.degraded);
  if (top === undefined) return { episode: null, notice: null };
  const episode =
    prev?.key === top.key
      ? { ...prev, count: prev.count + 1 }
      : { key: top.key, since: now, count: 1 };
  return {
    episode,
    notice:
      episode.count < HEALTH_PERSIST_SENSES
        ? null
        : {
            id: `health:${top.key}:${episode.since}`,
            text: `Her own health: ${d.summary}${top.fix === null ? "" : ` What would fix it: ${top.fix}.`}`,
            weight: top.severity === "down" ? 75 : 55,
          },
  };
};
