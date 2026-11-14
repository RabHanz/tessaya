/**
 * Jobs and their domain playbook (research/LEARNING-LOOP-DESIGN.md §3). A job learns under its template when it has one
 * (the same kind of job anywhere), else its project. It reads that playbook when it starts, and each report is graded
 * by the checked outcomes of §3.2: his verdict, the template's `check:` command, a retry, or the same job asked again.
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
} from "@t3tools/tessaya-shared/playbook";
import type { ThreadId, WorkSessionId } from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { BatonJobService } from "./BatonJobService.ts";
import { BatonMemoryService, MemoryViewer } from "./BatonMemoryService.ts";
import { BatonOneShot } from "./BatonOneShot.ts";
import { readTemplates } from "./OperatingSystemPack.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

export interface PlaybookDomain {
  readonly domain: string;
  /** A template's playbook serves every project; a project's stays behind its walls. */
  readonly scope: "global" | "project";
  readonly template: string | null;
}

/** Where a job learns: its template, else its project; null when it has neither. */
export const playbookDomain = (input: {
  readonly template?: string | null | undefined;
  readonly project?: string | null | undefined;
}): PlaybookDomain | null =>
  input.template != null && input.template !== ""
    ? { domain: `template:${input.template}`, scope: "global", template: input.template }
    : input.project != null && input.project !== ""
      ? { domain: input.project, scope: "project", template: null }
      : null;

const DOMAIN_KEY = "playbook-domain:";
const DomainJson = Schema.fromJsonString(
  Schema.Struct({
    domain: Schema.String,
    scope: Schema.Literals(["global", "project"]),
    template: Schema.NullOr(Schema.String),
  }),
);
const encodeDomain = Schema.encodeEffect(DomainJson);
const decodeDomain = Schema.decodeEffect(DomainJson);

/** Kept when the job starts, since the template is not on the job's terms. */
export const rememberJobDomain = Effect.fn("BatonPlaybook.rememberDomain")(function* (
  job: string,
  domain: PlaybookDomain,
) {
  const text = yield* encodeDomain(domain).pipe(Effect.orDie);
  yield* (yield* BatonMemoryService).setMeta(`${DOMAIN_KEY}${job}`, text);
});

/** The domain kept at its start; a job from before this learns under its project. */
const jobDomain = Effect.fn("BatonPlaybook.jobDomain")(function* (job: WorkSessionId) {
  const kept = yield* (yield* BatonMemoryService).meta(`${DOMAIN_KEY}${job}`);
  if (kept !== null) {
    const decoded = yield* decodeDomain(kept).pipe(Effect.option);
    if (decoded._tag === "Some") return decoded.value;
  }
  const session = yield* (yield* WorkSessionService)
    .get(job)
    .pipe(Effect.orElseSucceed(() => null));
  if (session === null) return null;
  const project = (yield* (yield* BatonEngine).projects).find((p) => p.id === session.projectId);
  return playbookDomain({ project: project?.title });
});

/** The domain is the job's own template or project, so reading it as the server crosses no wall another job could. */
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

/** One report's checked outcome applied to its domain's playbook and kept through the memory door. */
export const learnFromOutcome = Effect.fn("BatonPlaybook.learn")(function* (input: {
  readonly domain: PlaybookDomain;
  readonly job: string;
  readonly goal: string;
  readonly report: string;
  readonly passed: boolean;
  /** Why it failed: his words, or what a check printed. */
  readonly why: string;
  /** `why` is his own correction, so a lesson it carries is his ("he said"); a check's output is not. */
  readonly his: boolean;
  /** The job came from outside or read outside text: its report is treated as planted text. */
  readonly tainted: boolean;
}) {
  const memory = yield* BatonMemoryService;
  const { domain } = input.domain;
  const item = yield* playbookItem(domain);
  const playbook = parsePlaybook(item?.text ?? null, domain);
  const cited = citedIn(input.report).filter((id) => playbook.lessons.some((l) => l.id === id));
  // Optional, so the job flows that grade a report (retry, a repeat ask) take on no new service.
  const oneShot = yield* Effect.serviceOption(BatonOneShot);
  if (Option.isNone(oneShot)) return null;
  const answer = yield* oneShot.value
    .run({
      prompt: `${WRITER_SYSTEM}\n\n${writerInput({
        goal: input.goal,
        passed: input.passed,
        feedback: input.passed ? "" : input.why,
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
      passed: input.passed,
      cited,
      his: `${input.goal}\n${input.his ? input.why : ""}`,
      ...(input.his && !input.passed ? { correction: input.why } : {}),
      planted: input.tainted ? [input.report] : [input.report].filter(instructionLike),
    },
    { add: answer.add ?? [], edit: answer.edit ?? [], harmful: answer.harmful ?? [] },
  );
  const ref = `${PLAYBOOK_REF}${domain}`;
  const text = playbookText(learned.playbook);
  if (item === null)
    yield* memory
      .add({
        kind: "skill",
        text,
        source: "job",
        sourceRef: ref,
        scope: input.domain.scope,
        ...(input.domain.scope === "project" ? { scopeRef: domain } : {}),
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

/** A job's latest report and what it learns under, or null when it has not reported since the go-ahead. */
const lastReport = Effect.fn("BatonPlaybook.lastReport")(function* (job: WorkSessionId) {
  const terms = yield* (yield* BatonJobService).terms(job);
  if (terms === null || terms.phase !== "approved") return null;
  const threadId = (yield* (yield* WorkSessionService)
    .get(job)
    .pipe(Effect.orElseSucceed(() => null)))?.activeThreadId;
  if (threadId == null) return null;
  const messages = yield* (yield* BatonEngine).recentMessages(threadId, 6);
  const at = messages.findLastIndex((m) => m.role === "assistant");
  // The plan is answered by the go-ahead; a report comes after it.
  if (at < 0 || messages.slice(0, at).filter((m) => m.role === "user").length < 2) return null;
  const domain = yield* jobDomain(job);
  return domain === null ? null : { terms, report: messages[at]!.text, domain, threadId, at };
});

/**
 * A job's thread answered: when the turn before it was a report and he replied with a verdict, that report teaches.
 * It runs on every change to the thread; the first one that sees the reply learns.
 */
export const learnFromJobReply = Effect.fn("BatonPlaybook.fromJobReply")(function* (
  threadId: ThreadId,
) {
  const id = yield* (yield* WorkSessionService).findForThread(threadId);
  if (id === null) return null;
  const terms = yield* (yield* BatonJobService).terms(id);
  if (terms === null || terms.phase !== "approved") return null;
  const messages = yield* (yield* BatonEngine).recentMessages(threadId, 6);
  const at = messages.findLastIndex((m) => m.role === "user");
  const reply = messages[at];
  const report = messages[at - 1];
  // The go-ahead after the plan reads as no verdict, so a plan never teaches.
  const passed = reply === undefined ? null : verdictOf(reply.text);
  if (reply === undefined || report?.role !== "assistant" || passed === null) return null;
  const domain = yield* jobDomain(id);
  if (domain === null) return null;
  if (
    !(yield* (yield* BatonMemoryService).noteOnce(
      `playbook:${threadId}`,
      `${at}:${reply.text.slice(0, 200)}`,
    ))
  )
    return null;
  return yield* learnFromOutcome({
    domain,
    job: id,
    goal: terms.goal,
    report: report.text,
    passed,
    why: reply.text,
    his: true,
    tainted: false,
  });
});

const CHECK_TIMEOUT = "2 minutes";

/** Runs a template's check in the job's folder: exit 0 passes; otherwise the end of what it printed. */
export const runCheck = Effect.fn("BatonPlaybook.runCheck")(function* (
  command: string,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", command], { cwd, forceKillAfter: "1 second" }),
      );
      const [out, err, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { passed: code === 0, output: `${out}\n${err}`.trim().slice(-600) };
    }),
  ).pipe(
    Effect.timeout(CHECK_TIMEOUT),
    Effect.orElseSucceed(() => ({ passed: false, output: "the check did not finish" })),
  );
});

/**
 * A templated job reported: when its template names a `check:`, run it in the job's folder and let the result grade
 * the report. A check is the strongest signal there is (§3.2), so a report is checked once, as soon as it is written.
 */
export const checkJobReport = Effect.fn("BatonPlaybook.checkJobReport")(function* (
  threadId: ThreadId,
) {
  const id = yield* (yield* WorkSessionService).findForThread(threadId);
  if (id === null) return null;
  if ((yield* (yield* BatonEngine).threadShell(threadId))?.status !== "completed") return null;
  const last = yield* lastReport(id);
  if (last === null || last.domain.template === null || last.threadId !== threadId) return null;
  const path = yield* Path.Path;
  const userdata = path.dirname((yield* ServerConfig.ServerConfig).dbPath);
  const check = readTemplates(userdata).find((t) => t.id === last.domain.template)?.check ?? null;
  const cwd = (yield* (yield* WorkSessionService).get(id).pipe(Effect.orElseSucceed(() => null)))
    ?.primaryWorktreePath;
  if (check === null || cwd == null) return null;
  if (!(yield* (yield* BatonMemoryService).noteOnce(`check:${threadId}`, String(last.at))))
    return null;
  const result = yield* runCheck(check, cwd);
  return yield* learnFromOutcome({
    domain: last.domain,
    job: id,
    goal: last.terms.goal,
    report: last.report,
    passed: result.passed,
    why: result.passed ? "" : `The check \`${check}\` failed:\n${result.output}`,
    his: false,
    tainted: false,
  });
});

/** He asked for the job again (a retry, or the same goal placed anew): its last report failed, whatever it claimed. */
export const failLastReport = Effect.fn("BatonPlaybook.failLastReport")(function* (
  job: WorkSessionId,
  why: string,
) {
  const last = yield* lastReport(job);
  if (last === null) return null;
  if (!(yield* (yield* BatonMemoryService).noteOnce(`again:${job}`, String(last.at)))) return null;
  return yield* learnFromOutcome({
    domain: last.domain,
    job,
    goal: last.terms.goal,
    report: last.report,
    passed: false,
    why,
    his: false,
    tainted: false,
  });
});
