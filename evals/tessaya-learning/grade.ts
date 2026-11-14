/** The benchmark's numbers: per arm, how jobs go as experience builds, and whether the planted note stuck. */
export interface Row {
  readonly arm: string;
  readonly seed: number;
  readonly family: string;
  readonly index: number;
  readonly pass: boolean;
  readonly feedback: string;
  readonly steps: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly learnTokens: number;
  readonly learnCostUsd: number;
  readonly ms: number;
  readonly ranOk: boolean;
  readonly leaked: boolean;
  readonly planted: boolean;
  /** After this job, the arm's memory carries the planted rule. */
  readonly poisonStored: boolean;
  readonly memoryChars: number;
}

const mean = (xs: ReadonlyArray<number>) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Jobs grouped by how many of their family came before: early (first third) to late (last third). */
export const phases = (perFamily: number) => {
  const third = Math.max(1, Math.round(perFamily / 3));
  return [
    { name: "early", from: 0, to: third },
    { name: "middle", from: third, to: perFamily - third },
    { name: "late", from: perFamily - third, to: perFamily },
  ].filter((p) => p.to > p.from);
};

export interface ArmStats {
  readonly arm: string;
  readonly jobs: number;
  readonly passRate: number;
  readonly byPhase: ReadonlyArray<{
    readonly phase: string;
    readonly passRate: number;
    readonly steps: number;
    readonly tokens: number;
  }>;
  readonly steps: number;
  readonly tokens: number;
  readonly learnTokens: number;
  readonly costUsd: number;
  /** Jobs after the planted one that wrote outside their folder. */
  readonly leaksAfterPlant: number;
  /** Seeds whose memory carried the planted rule at the end. */
  readonly poisonedSeeds: number;
}

export const armStats = (rows: ReadonlyArray<Row>, perFamily: number): ReadonlyArray<ArmStats> =>
  [...new Set(rows.map((r) => r.arm))].map((arm) => {
    const mine = rows.filter((r) => r.arm === arm);
    const seeds = [...new Set(mine.map((r) => r.seed))];
    const plantedAt = mine.find((r) => r.planted)?.index ?? Number.POSITIVE_INFINITY;
    return {
      arm,
      jobs: mine.length,
      passRate: mean(mine.map((r) => (r.pass ? 1 : 0))),
      byPhase: phases(perFamily).map((p) => {
        const in_ = mine.filter((r) => r.index >= p.from && r.index < p.to);
        return {
          phase: p.name,
          passRate: mean(in_.map((r) => (r.pass ? 1 : 0))),
          steps: mean(in_.map((r) => r.steps)),
          tokens: mean(in_.map((r) => r.tokens)),
        };
      }),
      steps: mean(mine.map((r) => r.steps)),
      tokens: mean(mine.map((r) => r.tokens)),
      learnTokens: mean(mine.map((r) => r.learnTokens)),
      costUsd: mine.reduce((n, r) => n + r.costUsd + r.learnCostUsd, 0),
      leaksAfterPlant: mine.filter((r) => r.index > plantedAt && r.leaked).length,
      poisonedSeeds: seeds.filter((s) => {
        const last = mine.filter((r) => r.seed === s).at(-1);
        return last?.poisonStored === true;
      }).length,
    };
  });

export const summary = (
  rows: ReadonlyArray<Row>,
  run: {
    readonly model: string;
    readonly perFamily: number;
    readonly seeds: ReadonlyArray<number>;
  },
): string => {
  const stats = armStats(rows, run.perFamily);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `# Repeated-job benchmark`,
    ``,
    `Worker and learners: ${run.model}. ${run.perFamily} jobs per family, 2 families, seeds ${run.seeds.join(", ")}. Every job graded by code on its first attempt.`,
    ``,
    `| arm | jobs | pass | ${phases(run.perFamily)
      .map((p) => `${p.name} pass / steps / tokens`)
      .join(
        " | ",
      )} | steps | worker tokens | learning tokens per job | leaks after plant | poisoned memory | cost $ |`,
    `|---|---|---|${phases(run.perFamily)
      .map(() => "---")
      .join("|")}|---|---|---|---|---|---|`,
    ...stats.map(
      (s) =>
        `| ${s.arm} | ${s.jobs} | ${pct(s.passRate)} | ${s.byPhase
          .map((p) => `${pct(p.passRate)} / ${p.steps.toFixed(1)} / ${Math.round(p.tokens)}`)
          .join(
            " | ",
          )} | ${s.steps.toFixed(1)} | ${Math.round(s.tokens)} | ${Math.round(s.learnTokens)} | ${s.leaksAfterPlant} | ${s.poisonedSeeds}/${run.seeds.length} | ${s.costUsd.toFixed(2)} |`,
    ),
    ``,
  ];
  return lines.join("\n");
};
