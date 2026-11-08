// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * P1's measure (INTEGRATION.md risk R1): first-token times from his turn log, split by whether the persona changed
 * from the turn before, with the warm and cold starts the log records from P1 on. Read-only.
 *   node --experimental-strip-types first-token.ts <voice-turns.ndjson> [--since 2026-11-08T00:00]
 */
import * as NodeFS from "node:fs";

interface Turn {
  readonly at: string;
  readonly persona?: string;
  readonly firstTokenMs?: number | null;
  readonly session?: "warm" | "cold" | null;
}

/** Median and 90th percentile of the first-token times, and how many started cold. */
export const summarise = (turns: ReadonlyArray<Turn>) => {
  const split = { switched: [] as Turn[], same: [] as Turn[] };
  turns.forEach((t, i) =>
    (i > 0 && turns[i - 1]!.persona !== t.persona ? split.switched : split.same).push(t),
  );
  const stats = (group: ReadonlyArray<Turn>) => {
    const ms = group.flatMap((t) => (typeof t.firstTokenMs === "number" ? [t.firstTokenMs] : []));
    ms.sort((a, b) => a - b);
    const at = (q: number) =>
      ms.length === 0 ? null : ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]!;
    return {
      turns: group.length,
      medianMs: at(0.5),
      p90Ms: at(0.9),
      cold: group.filter((t) => t.session === "cold").length,
    };
  };
  return { switched: stats(split.switched), same: stats(split.same) };
};

const main = () => {
  const file = process.argv[2];
  if (file === undefined) throw new Error("Give the turn log.");
  const at = process.argv.indexOf("--since");
  const since = at < 0 ? "" : (process.argv[at + 1] ?? "");
  const turns = NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as Turn & { readonly kind?: string };
        return row.kind === "agent_turn" && row.at >= since ? [row] : [];
      } catch {
        return [];
      }
    });
  console.log(JSON.stringify(summarise(turns), null, 1));
};

if (process.argv[1]?.endsWith("first-token.ts")) main();
