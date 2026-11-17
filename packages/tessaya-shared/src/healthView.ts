/**
 * Settings → Health as lines, for web and mobile alike: her diagnosis first, then each machine, service and Tessel.
 * Ages before the check only ("3 min ago"), never a clock time, so no screen shows a zone that is not his.
 */
import type { TessayaHealthResult } from "@t3tools/tessaya-contracts";

const STAGE_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["endpointMs", "end of speech"],
  ["asrMs", "speech to text"],
  ["brainFirstMs", "brain, first words"],
  ["ttsFirstMs", "voice, first sound"],
  ["firstSoundMs", "heard to first sound"],
];

const age = (now: number, at: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const pct = (v: number | null) => (v === null ? null : `${v.toFixed(v < 10 ? 1 : 0)}%`);
const join = (parts: ReadonlyArray<string | null>) => parts.filter((p) => p !== null).join(" · ");

export interface HealthLine {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

export const healthLines = (r: TessayaHealthResult) => {
  const { diagnosis: d, snapshot: s } = r;
  const now = s.at;
  return {
    summary: d.summary,
    checked: s.roomLoop ?? "",
    findings: d.findings.map((f) => ({
      key: f.key,
      title: f.says[0]!.toUpperCase() + f.says.slice(1),
      detail: join([f.evidence.join("; "), f.fix === null ? null : `Fix: ${f.fix}`]),
      severity: f.severity,
    })),
    groups: [
      {
        title: "Machines",
        rows: s.hosts.map((h): HealthLine => ({
          key: h.host,
          title: h.host,
          detail: join([
            h.memAvailMb === null ? null : `${h.memAvailMb} MB free of ${h.memTotalMb ?? "?"} MB`,
            h.swapUsedMb === null || h.swapUsedMb === 0 ? null : `${h.swapUsedMb} MB swap`,
            h.memPsiFull10 === null ? null : `memory stalls ${pct(h.memPsiFull10)}`,
            h.cpuPsiSome10 === null ? null : `CPU waits ${pct(h.cpuPsiSome10)}`,
            h.load1 === null ? null : `load ${h.load1.toFixed(1)} on ${h.cores} cores`,
            `read ${age(now, h.at)}`,
          ]),
        })),
      },
      {
        title: "Services",
        rows: s.services.map((v): HealthLine => ({
          key: `${v.host}|${v.name}`,
          title: `${v.name} on ${v.host}`,
          detail: join([
            v.up ? "up" : "down",
            v.startedAt === null ? null : `started ${age(now, v.startedAt)}`,
          ]),
        })),
      },
      {
        title: "Tessels",
        rows: s.vessels.map((v): HealthLine => ({
          key: v.id,
          title: v.name,
          detail: join([
            v.online === false ? "offline" : v.online === true ? "online" : null,
            v.rssi === null
              ? null
              : `Wi-Fi ${v.rssi} dBm${v.route === "hotspot" ? " on the hotspot" : ""}`,
            v.hub === null ? null : `hub ${v.hub}`,
            ...STAGE_WORDS.map(([k, words]) => {
              const st = v.stages[k as keyof typeof v.stages];
              return st === undefined || st.p50 === null
                ? null
                : `${words} ${st.p50} ms (p90 ${st.p90 ?? "?"})`;
            }),
            v.stalls === 0 ? null : `${v.stalls} audio stalls in 15 min`,
            v.voiceHost === null
              ? "no voice loop report"
              : join([
                  `wakes ${v.voiceHost.wake.accepts} of ${v.voiceHost.wake.attempts}`,
                  v.voiceHost.brain.rttMs === null
                    ? null
                    : `server round trip ${v.voiceHost.brain.rttMs} ms`,
                  v.voiceHost.replay.line,
                  `voice loop on ${v.voiceHost.host.host}, reported ${age(now, v.voiceHost.at)}`,
                ]),
          ]),
        })),
      },
      ...(s.notes.length === 0
        ? []
        : [
            {
              title: "Lately",
              rows: s.notes.map((n, i): HealthLine => ({
                key: `${n.at}:${i}`,
                title: n.says,
                detail: age(now, n.at),
              })),
            },
          ]),
    ].filter((g) => g.rows.length > 0),
  };
};
