// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/** His own standing jobs (KIRO-1), in user-jobs.json beside the built-ins' state; on this computer, as theirs are. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  MAX_PROPOSALS,
  MAX_USER_JOBS,
  isUserJob,
  type UserJob,
  type UserJobRun,
} from "@t3tools/tessaya-shared/userJobs";

import { writeJsonFile } from "../writing/jsonStore.ts";

interface Saved {
  readonly next: number;
  readonly jobs: ReadonlyArray<UserJob>;
  /** The latest runs, every job's together. */
  readonly runs?: ReadonlyArray<UserJobRun>;
}
type Patch = Partial<Pick<UserJob, "on" | "instruction" | "title" | "missed">>;
const KEEP_RUNS = 200;

export const createUserJobStore = (
  dir: string,
  onSkipped: (why: string) => void = () => undefined,
) => {
  const file = NodePath.join(dir, "user-jobs.json");
  /** A damaged file is kept aside and a bad entry skipped: the Trust page and the other jobs never break on one. */
  const read = (): Saved => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { next: 1, jobs: [] };
      parsed = undefined;
    }
    const saved = parsed as Partial<Saved> | undefined;
    if (typeof saved?.next !== "number" || !Array.isArray(saved.jobs)) {
      NodeFS.renameSync(file, `${file}.bad`);
      onSkipped("user-jobs.json was not readable; it is kept as user-jobs.json.bad");
      return { next: 1, jobs: [] };
    }
    const jobs = saved.jobs.filter(isUserJob);
    if (jobs.length < saved.jobs.length)
      onSkipped(
        `${saved.jobs.length - jobs.length} entries in user-jobs.json were not jobs and are skipped`,
      );
    return { next: saved.next, jobs, runs: Array.isArray(saved.runs) ? saved.runs : [] };
  };
  const write = (saved: Saved) => writeJsonFile(file, saved);
  return {
    list: (): ReadonlyArray<UserJob> => read().jobs,
    get: (id: string): UserJob | undefined => read().jobs.find((j) => j.id === id),
    /** The id the next job gets. */
    nextId: (): string => `user:${read().next}`,
    add: (job: UserJob): { readonly ok: true } | { readonly ok: false; readonly why: string } => {
      const saved = read();
      if (saved.jobs.length >= MAX_USER_JOBS)
        return {
          ok: false,
          why: `There are already ${MAX_USER_JOBS} of your own jobs; remove one first.`,
        };
      if (job.proposed && saved.jobs.filter((j) => j.proposed).length >= MAX_PROPOSALS)
        return {
          ok: false,
          why: `${MAX_PROPOSALS} proposals already wait for his yes on the Trust page.`,
        };
      write({ ...saved, next: saved.next + 1, jobs: [...saved.jobs, job] });
      return { ok: true };
    },
    /**
     * A proposal is switched on only from the Trust page (`approve`), where he sees it; a tool cannot. Words he rewrites
     * are his from then on.
     */
    update: (
      id: string,
      patch: Patch,
      options: { readonly approve?: boolean } = {},
    ): UserJob | { readonly refused: string } | null => {
      const saved = read();
      const found = saved.jobs.find((j) => j.id === id);
      if (found === undefined) return null;
      if (found.proposed && patch.on === true && options.approve !== true)
        return { refused: "A proposal is approved by him on the Trust page, not here." };
      const next: UserJob = {
        ...found,
        ...patch,
        ...(patch.on === true ? { proposed: false } : {}),
        // Switched on now: a timed job whose time already passed today waits for tomorrow.
        ...(patch.on === true && !found.on ? { enabledAt: Date.now() } : {}),
        ...(patch.instruction !== undefined ? { from: "him" as const } : {}),
      };
      write({ ...saved, jobs: saved.jobs.map((j) => (j.id === id ? next : j)) });
      return next;
    },
    runs: (): ReadonlyArray<UserJobRun> => read().runs ?? [],
    saveRun: (run: UserJobRun): void => {
      const saved = read();
      write({ ...saved, runs: [...(saved.runs ?? []), run].slice(-KEEP_RUNS) });
    },
    remove: (id: string): boolean => {
      const saved = read();
      if (!saved.jobs.some((j) => j.id === id)) return false;
      write({ ...saved, jobs: saved.jobs.filter((j) => j.id !== id) });
      return true;
    },
  };
};
export type UserJobStore = ReturnType<typeof createUserJobStore>;
