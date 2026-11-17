/**
 * One host's memory, pressure and load from its /proc text, for her health model (health.ts). Type imports only: the
 * room loop loads it on a host that may already be short of memory.
 */
import type { HostHealth } from "@t3tools/tessaya-contracts";

const kb = (meminfo: string, key: string): number | null => {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(meminfo);
  return m === null ? null : Number(m[1]);
};
const psi = (text: string | null, line: "some" | "full", field: "avg10" | "avg60") => {
  if (text === null) return null;
  const m = new RegExp(`^${line} .*?${field}=([\\d.]+)`, "m").exec(text);
  return m === null ? null : Number(m[1]);
};

/** A host's figures from its /proc files' text (null for any it could not read). */
export const hostHealthOf = (input: {
  readonly host: string;
  readonly at: number;
  readonly cores: number;
  readonly meminfo: string | null;
  readonly loadavg: string | null;
  readonly psiMemory: string | null;
  readonly psiCpu: string | null;
}): HostHealth => {
  const mi = input.meminfo ?? "";
  const mb = (k: number | null) => (k === null ? null : Math.round(k / 1024));
  const swapTotal = kb(mi, "SwapTotal");
  const swapFree = kb(mi, "SwapFree");
  const load = input.loadavg === null ? NaN : Number(input.loadavg.split(" ")[0]);
  return {
    host: input.host,
    at: input.at,
    memTotalMb: mb(kb(mi, "MemTotal")),
    memAvailMb: mb(kb(mi, "MemAvailable")),
    swapUsedMb: swapTotal === null || swapFree === null ? null : mb(swapTotal - swapFree),
    memPsiSome10: psi(input.psiMemory, "some", "avg10"),
    memPsiFull10: psi(input.psiMemory, "full", "avg10"),
    memPsiFull60: psi(input.psiMemory, "full", "avg60"),
    cpuPsiSome10: psi(input.psiCpu, "some", "avg10"),
    load1: Number.isFinite(load) ? load : null,
    cores: input.cores,
  };
};
