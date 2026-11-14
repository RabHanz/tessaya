// @effect-diagnostics globalDate:off globalDateInEffect:off
/** The day's episode (D150): what he talked about and which jobs moved, as one short memory that decays like any episode. */
import * as Effect from "effect/Effect";

import { TessayaJobService } from "./TessayaJobService.ts";
import { TessayaMemoryService } from "./TessayaMemoryService.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

/** The day before `nowMs` (UTC), once: a restart or a second tick that day adds nothing. */
export const dailyEpisode = Effect.fn("BatonMemoryReactor.dailyEpisode")(function* (nowMs: number) {
  const memory = yield* TessayaMemoryService;
  const day = dayOf(nowMs - DAY_MS);
  const done = `episode:${day}`;
  if (yield* memory.flag(done)) return null;
  const start = `${day}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + DAY_MS).toISOString();
  const said = yield* memory.talks(day);
  const jobs = (yield* (yield* TessayaJobService).allTerms()).filter(
    (t) => t.updatedAt >= start && t.updatedAt < end,
  );
  // Each work session's own summary, so "what did my sessions do yesterday" has a line per session.
  const sessions = (yield* (yield* WorkSessionService)
    .list({ includeArchived: true })
    .pipe(Effect.orElseSucceed(() => []))).flatMap((s) =>
    s.synopsis?.currentAction != null && s.synopsis.updatedAt >= start
      ? [`${s.title.slice(0, 40)}: ${s.synopsis.currentAction.slice(0, 100)}`]
      : [],
  );
  if (said.length === 0 && jobs.length === 0 && sessions.length === 0) return null;
  const parts = [
    said.length === 0 ? null : `Talked about: ${said.slice(0, 6).join("; ")}.`,
    jobs.length === 0
      ? null
      : `Jobs: ${jobs
          .slice(0, 4)
          .map((j) => `${j.goal.slice(0, 50)} (${j.phase.replace("_", " ")})`)
          .join("; ")}.`,
    sessions.length === 0 ? null : `Sessions: ${sessions.slice(0, 6).join("; ")}.`,
  ].filter((x): x is string => x !== null);
  const episode = yield* memory
    .add({
      kind: "episode",
      text: `${day}. ${parts.join(" ")}`.slice(0, 500),
      source: "job",
      sourceRef: `day:${day}`,
    })
    .pipe(Effect.orElseSucceed(() => null));
  // Marked only once it is written, so a failed write is tried again on the next tick.
  if (episode !== null) yield* memory.setFlag(done, true);
  return episode;
});
