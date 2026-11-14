/**
 * The loops under test. Each sees a job before it starts (what goes in the worker's prompt or folder) and after it
 * ends (the run, and the checked outcome with his correction), and keeps its own memory across jobs.
 */
import {
  citedIn,
  emptyPlaybook,
  instructionLike,
  learnFromJob,
  parseDelta,
  playbookBlock,
  playbookText,
  WRITER_SYSTEM,
  writerInput,
  type Playbook,
} from "../../packages/baton-shared/src/playbook.ts";
import { runClaude, type Run } from "./agent.ts";
import type { Job, Outcome } from "./families.ts";

export interface Spend {
  readonly tokens: number;
  readonly costUsd: number;
}

export interface Arm {
  readonly id: string;
  /** Added to the worker's system prompt. */
  readonly system: (job: Job) => string | Promise<string>;
  /** Files the arm puts in the job's folder before it starts (a skills folder). */
  readonly prepare: (job: Job, work: string) => void;
  readonly learn: (job: Job, run: Run, outcome: Outcome, work: string) => Promise<Spend>;
  /** Everything the arm would show a later job, for the poisoning check. */
  readonly memoryText: () => string | Promise<string>;
}

const nothing: Spend = { tokens: 0, costUsd: 0 };

export const noLearning = (): Arm => ({
  id: "none",
  system: () => "",
  prepare: () => {},
  learn: async () => nothing,
  memoryText: () => "",
});

/** Tessaya's loop as `packages/baton-shared/src/playbook.ts` ships it: one playbook per domain. */
export const tessaya = (model: string, cwd: string): Arm & { readonly held: () => string } => {
  const books = new Map<string, Playbook>();
  const held: string[] = [];
  const of = (domain: string) => books.get(domain) ?? emptyPlaybook(domain);
  return {
    id: "tessaya",
    system: (job) => playbookBlock(of(job.family)),
    prepare: () => {},
    learn: async (job, run, outcome) => {
      const playbook = of(job.family);
      const cited = citedIn(run.final).filter((id) => playbook.lessons.some((l) => l.id === id));
      const wrote = await runClaude({
        cwd,
        model,
        tools: false,
        system: WRITER_SYSTEM,
        prompt: writerInput({
          goal: job.goal,
          passed: outcome.pass,
          feedback: outcome.feedback,
          cited,
          steps: run.steps,
          report: run.final,
          playbook,
        }),
      });
      const learned = learnFromJob(
        playbook,
        {
          job: `${job.family}-${job.index}`,
          passed: outcome.pass,
          cited,
          his: `${job.goal}\n${outcome.feedback}`,
          correction: outcome.feedback,
          planted: run.results.filter(instructionLike),
        },
        parseDelta(wrote.final),
      );
      books.set(job.family, learned.playbook);
      held.push(...learned.held);
      return { tokens: wrote.tokens, costUsd: wrote.costUsd };
    },
    memoryText: () => [...books.values()].map(playbookText).join("\n"),
    held: () => held.join("\n"),
  };
};
