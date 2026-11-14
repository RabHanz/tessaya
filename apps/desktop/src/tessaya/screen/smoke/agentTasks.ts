/**
 * The before-and-after task set for the assistant's hands (D144, issue #52): six Windows tasks, three
 * runs each, scored by whether it finished, the steps taken, the wall time and the misclicks the
 * checks counted. Pure, so the scoring is tested without a desktop. The real run is `agentLab.ts`,
 * and it only runs when he is away and has been told.
 */
export interface AgentTask {
  readonly id: string;
  readonly goal: string;
}

export const TASKS: ReadonlyArray<AgentTask> = [
  {
    id: "notepad",
    goal: "Open Notepad, type the line 'Tessaya task one', and save it in Documents as tessaya-task-one.txt.",
  },
  {
    id: "explorer",
    goal: "Open the Downloads folder in File Explorer and sort it by date modified.",
  },
  {
    id: "settings",
    goal: "Open Windows Settings, change the display brightness one step, then change it back.",
  },
  {
    id: "browser",
    goal: "In the browser, find the page for the Anthropic company and copy its main heading into Notepad.",
  },
  {
    id: "spreadsheet",
    goal: "In a spreadsheet, enter the numbers 4, 5 and 6 in a column and put their sum under them.",
  },
  {
    id: "dialog",
    goal: "If a dialog appears that you did not ask for, close it, then carry on with task one.",
  },
];

export interface RunResult {
  readonly task: string;
  readonly run: number;
  readonly finished: boolean;
  readonly steps: number;
  readonly wallMs: number;
  readonly misclicks: number;
}

export interface TaskScore {
  readonly task: string;
  readonly runs: number;
  readonly finished: number;
  readonly meanSteps: number;
  readonly meanWallS: number;
  readonly misclicks: number;
}

export const score = (results: ReadonlyArray<RunResult>): ReadonlyArray<TaskScore> =>
  TASKS.map((t) => {
    const runs = results.filter((r) => r.task === t.id);
    const mean = (f: (r: RunResult) => number) =>
      runs.length === 0 ? 0 : runs.reduce((n, r) => n + f(r), 0) / runs.length;
    return {
      task: t.id,
      runs: runs.length,
      finished: runs.filter((r) => r.finished).length,
      meanSteps: Math.round(mean((r) => r.steps) * 10) / 10,
      meanWallS: Math.round(mean((r) => r.wallMs) / 100) / 10,
      misclicks: runs.reduce((n, r) => n + r.misclicks, 0),
    };
  });

export const report = (label: string, scores: ReadonlyArray<TaskScore>): string =>
  [
    `${label}`,
    "task         finished  steps  wall s  misclicks",
    ...scores.map(
      (s) =>
        `${s.task.padEnd(12)} ${`${s.finished}/${s.runs}`.padEnd(9)} ${String(s.meanSteps).padEnd(6)} ${String(s.meanWallS).padEnd(7)} ${s.misclicks}`,
    ),
  ].join("\n");
