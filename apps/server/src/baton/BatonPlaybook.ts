/**
 * Jobs and their domain playbook (research/LEARNING-LOOP-DESIGN.md §3): a job reads its project's playbook when it
 * starts, and each report he answers with a verdict ("no, you missed…", "thanks") updates it. The rules are
 * `@t3tools/baton-shared/playbook`'s; this is only the reading, the one model call and the memory door.
 */
import {
  citedIn,
  instructionLike,
  learnFromJob,
  parsePlaybook,
  playbookBlock,
  playbookText,
  PLAYBOOK_REF,
  verdictOf,
  WRITER_SYSTEM,
  writerInput,
} from "@t3tools/baton-shared/playbook";
import type { ThreadId } from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BatonEngine } from "./BatonEngine.ts";
import { BatonJobService } from "./BatonJobService.ts";
import { BatonMemoryService, MemoryViewer } from "./BatonMemoryService.ts";
import { BatonOneShot } from "./BatonOneShot.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

/** The domain is the job's own project, so reading it as the server crosses no wall another job could. */
const playbookItem = Effect.fn("BatonPlaybook.item")(function* (domain: string) {
  const items = yield* (yield* BatonMemoryService)
    .list({ kinds: ["skill"], limit: 500 })
    .pipe(Effect.provideService(MemoryViewer, "server"));
  return items.find((i) => i.sourceRef === `${PLAYBOOK_REF}${domain}`) ?? null;
});

/** The block a job in this domain starts with; empty while the domain has taught nothing. */
export const jobPlaybook = Effect.fn("BatonPlaybook.forJob")(function* (domain: string) {
  const item = yield* playbookItem(domain);
  return playbookBlock(parsePlaybook(item?.text ?? null, domain));
});

const Delta = Schema.Struct({
  add: Schema.optionalKey(Schema.Array(Schema.String)),
  edit: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }))),
  harmful: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** One report and his verdict on it, applied to the domain's playbook and kept through the memory door. */
export const learnFromVerdict = Effect.fn("BatonPlaybook.learn")(function* (input: {
  readonly domain: string;
  readonly job: string;
  readonly goal: string;
  readonly report: string;
  readonly reply: string;
  /** The job came from outside or read outside text: its report is treated as planted text. */
  readonly tainted: boolean;
}) {
  const passed = verdictOf(input.reply);
  if (passed === null) return null;
  const memory = yield* BatonMemoryService;
  const item = yield* playbookItem(input.domain);
  const playbook = parsePlaybook(item?.text ?? null, input.domain);
  const cited = citedIn(input.report).filter((id) => playbook.lessons.some((l) => l.id === id));
  const answer = yield* (yield* BatonOneShot)
    .run({
      prompt: `${WRITER_SYSTEM}\n\n${writerInput({
        goal: input.goal,
        passed,
        feedback: passed ? "" : input.reply,
        cited,
        steps: [],
        report: input.report,
        playbook,
      })}`,
      outputSchema: Delta,
      role: "background",
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (answer === null) return null;
  const learned = learnFromJob(
    playbook,
    {
      job: input.job,
      passed,
      cited,
      his: `${input.goal}\n${input.reply}`,
      ...(passed ? {} : { correction: input.reply }),
      planted: input.tainted ? [input.report] : [input.report].filter(instructionLike),
    },
    { add: answer.add ?? [], edit: answer.edit ?? [], harmful: answer.harmful ?? [] },
  );
  const ref = `${PLAYBOOK_REF}${input.domain}`;
  const text = playbookText(learned.playbook);
  if (item === null)
    yield* memory
      .add({
        kind: "skill",
        text,
        source: "job",
        sourceRef: ref,
        scope: "project",
        scopeRef: input.domain,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  else if (item.text !== text)
    yield* memory.rewrite(item.id, text).pipe(Effect.ignoreCause({ log: true }));
  // Held lessons wait for his yes as proposed items: the door holds anything marked tainted.
  for (const held of learned.held)
    yield* memory
      .add({ kind: "learning", text: held, source: "job", sourceRef: `${ref}:held`, tainted: true })
      .pipe(Effect.ignoreCause({ log: true }));
  return learned;
});

/**
 * A job's thread answered: when the turn before it was a report and he replied with a verdict, that report teaches
 * its project's playbook. It runs on every change to the thread; the first one that sees the reply learns.
 */
export const learnFromJobReply = Effect.fn("BatonPlaybook.fromJobReply")(function* (
  threadId: ThreadId,
) {
  const id = yield* (yield* WorkSessionService).findForThread(threadId);
  if (id === null) return null;
  const terms = yield* (yield* BatonJobService).terms(id);
  if (terms === null || terms.phase !== "approved") return null;
  const engine = yield* BatonEngine;
  const messages = yield* engine.recentMessages(threadId, 6);
  const at = messages.findLastIndex((m) => m.role === "user");
  const reply = messages[at];
  const report = messages[at - 1];
  // The go-ahead after the plan reads as no verdict, so a plan never teaches.
  if (reply === undefined || report?.role !== "assistant" || verdictOf(reply.text) === null)
    return null;
  const session = yield* (yield* WorkSessionService).get(id).pipe(Effect.orElseSucceed(() => null));
  const project =
    session === null
      ? undefined
      : (yield* engine.projects).find((p) => p.id === session.projectId)?.title;
  if (project === undefined) return null;
  const memory = yield* BatonMemoryService;
  if (!(yield* memory.noteOnce(`playbook:${threadId}`, `${at}:${reply.text.slice(0, 200)}`)))
    return null;
  return yield* learnFromVerdict({
    domain: project,
    job: id,
    goal: terms.goal,
    report: report.text,
    reply: reply.text,
    tainted: false,
  });
});
