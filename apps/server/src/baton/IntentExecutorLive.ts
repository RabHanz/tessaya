/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
/**
 * Everything a sentence is allowed to cause.
 *
 * Seven commands, and nothing else can be added by phrasing — a new capability
 * needs a new member of the union in `baton/intent.ts`, a grammar rule that
 * produces it, and a case here. That is three files somebody reviews, which is
 * the point: the surface where a half-heard sentence turns into action is
 * exactly where a short, named list of effects earns its keep (§22's argument,
 * applied to §13's model).
 *
 * Nothing here re-reads the user's words. It is handed ids, and it acts on
 * them, so what runs is what the user was shown.
 *
 * Threads are created and messaged through `OrchestrationEffectsService` — the
 * same narrow surface a rule uses — rather than through a second path into the
 * engine. One place creates threads, whatever asked for them.
 */
import {
  accountRefusal,
  instanceAccount,
  type BatonFleetEntry,
  type BatonIntentCommand,
  type OrchestrationRuleId,
  type WorkSessionId,
} from "@t3tools/tessaya-contracts";
import {
  speakFleetCompletions,
  speakFleetNeedsUser,
  speakFleetRunning,
  speakWorkSessionStatus,
  type SpokenWorkSession,
} from "@t3tools/tessaya-shared/spokenStatus";
import { Hostname as HostProcessHostname } from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { getFleet } from "./FleetQuery.ts";
import { AdoptedSessionService } from "./AdoptedSessionService.ts";
import { BatonIntentExecutor, type IntentExecution } from "./IntentService.ts";
import { BatonOrchestrationReactor, OrchestrationEffectsService } from "./OrchestrationReactor.ts";
import { OrchestrationRuleService } from "./OrchestrationRuleService.ts";
import type { ServerProvider } from "@t3tools/contracts";
import { AskSource } from "./BatonPhoneInbox.ts";
import { ThreadAccountMoves } from "./ThreadAccountMoves.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

const done = (reply: string, workSessionId: WorkSessionId | null = null): IntentExecution => ({
  reply,
  workSessionId,
  failed: false,
});

const failed = (reply: string, workSessionId: WorkSessionId | null = null): IntentExecution => ({
  reply,
  workSessionId,
  failed: true,
});

/** What a person may call a Claude instance: its name, its id's suffix, or its address's local part. */
const accountNames = (provider: ServerProvider): ReadonlyArray<string> =>
  [
    provider.displayName,
    provider.instanceId.replace(/^claudeAgent_?/, ""),
    provider.auth.email?.split("@")[0],
  ].flatMap((name) => (name === undefined || name === "" ? [] : [name.toLowerCase()]));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const workSessions = yield* WorkSessionService;
  const rules = yield* OrchestrationRuleService;
  const reactor = yield* BatonOrchestrationReactor;
  const effects = yield* OrchestrationEffectsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const hostname = yield* HostProcessHostname;
  const engine = yield* BatonEngine;
  const moves = yield* ThreadAccountMoves;
  // Named rather than inferred: `Effect.Effect.Context<...>` resolves to `any`
  // here and takes the requirement channel of every caller with it.
  const fleetContext = yield* Effect.context<
    WorkSessionService | AdoptedSessionService | BatonEngine | ProviderRegistry.ProviderRegistry
  >();

  const hostLabel = hostname.split(".")[0]?.trim() ?? hostname;

  const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  let sequence = 0;
  const nextSuffix = () => {
    sequence += 1;
    return `${startedAt}-${sequence}`;
  };

  const readFleet = getFleet({}).pipe(
    Effect.provideContext(fleetContext),
    Effect.catchCause(() => Effect.succeed(null)),
  );

  const providerLabels = Effect.map(
    providerRegistry.getProviders.pipe(Effect.catchCause(() => Effect.succeed([]))),
    (providers) =>
      new Map(
        providers.map((provider) => [
          provider.instanceId as string,
          provider.displayName ?? provider.driver,
        ]),
      ),
  );

  const projectLabels = Effect.map(
    engine.projects,
    (projects) => new Map(projects.map((project) => [project.id as string, project.title])),
  );

  /** A fleet entry as §20 needs to hear it: who, where, and what it found. */
  const spoken = (
    entry: BatonFleetEntry,
    providers: ReadonlyMap<string, string>,
    projects: ReadonlyMap<string, string>,
  ): SpokenWorkSession => {
    const active =
      entry.threads.find((thread) => thread.threadId === entry.activeThreadId) ??
      entry.threads[0] ??
      null;
    return {
      title: entry.title,
      projectLabel: projects.get(entry.projectId) ?? null,
      state: entry.state,
      providerLabel:
        active?.providerInstanceId === undefined || active.providerInstanceId === null
          ? null
          : (providers.get(active.providerInstanceId) ?? null),
      hostLabel,
      synopsis: entry.synopsis,
    };
  };

  const execute = (command: BatonIntentCommand): Effect.Effect<IntentExecution> =>
    Effect.gen(function* () {
      switch (command.kind) {
        case "status_fleet": {
          const fleet = yield* readFleet;
          if (fleet === null) return failed("I could not read the fleet.");
          const providers = yield* providerLabels;
          const projects = yield* projectLabels;
          const now = Date.parse(fleet.observedAt);
          const sessions = fleet.entries.map((entry) => spoken(entry, providers, projects));
          switch (command.question) {
            case "needs_me":
              return done(speakFleetNeedsUser(sessions));
            case "running":
              return done(speakFleetRunning(sessions));
            case "finished":
              return done(speakFleetCompletions(sessions, now));
            case "everything":
              // Two sentences, in the order a person can act on: what is
              // blocked first, what is moving second.
              return done(`${speakFleetNeedsUser(sessions)} ${speakFleetRunning(sessions)}`.trim());
          }
          return done("");
        }

        case "status_work_session": {
          const fleet = yield* readFleet;
          const entry = fleet?.entries.find(
            (candidate) => candidate.workSessionId === command.workSessionId,
          );
          if (fleet === null || entry === undefined) {
            return failed("That work is no longer in the fleet.", command.workSessionId);
          }
          const providers = yield* providerLabels;
          const projects = yield* projectLabels;
          return done(
            speakWorkSessionStatus(
              spoken(entry, providers, projects),
              Date.parse(fleet.observedAt),
            ),
            command.workSessionId,
          );
        }

        case "message_work_session": {
          const workSession = yield* workSessions
            .get(command.workSessionId)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (workSession === null) {
            return failed("That work is gone.", command.workSessionId);
          }
          const threadId = workSession.activeThreadId;
          if (threadId === null) {
            // Refusing to guess a thread is the same rule as refusing to guess
            // a target: the message would otherwise land somewhere unasked.
            return failed(
              `${workSession.title} has no session running. Start one first.`,
              command.workSessionId,
            );
          }
          const sent = yield* effects.messageThread({ threadId, text: command.text });
          return sent
            ? done(`Passed that to ${workSession.title}.`, command.workSessionId)
            : failed(`I could not reach ${workSession.title}.`, command.workSessionId);
        }

        case "start_work_session": {
          const workSessionId = `work-${nextSuffix()}` as WorkSessionId;
          const created = yield* workSessions
            .create({
              id: workSessionId,
              projectId: command.projectId,
              title: command.title,
            })
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (created === null) return failed("I could not create the work session.");
          const threadId = yield* effects.startProviderSession({
            workSessionId,
            action: {
              kind: "start_provider_session",
              providerInstanceId: command.providerInstanceId,
              model: command.model,
              role: "implementation",
              // Never full access from a sentence. §24.2: high-risk work needs
              // its own confirmation, and the thread's own policy is where
              // that is enforced.
              runtimeMode: "approval-required",
              // Created idle: the user is about to talk to it, and an opening
              // prompt nobody asked for is a turn nobody asked for.
              prompt: "",
              title: command.title,
            },
          });
          if (threadId === null) {
            return failed(
              "That account is not available on this environment, so the work is there with nothing running.",
              workSessionId,
            );
          }
          return done(`Started ${command.title}.`, workSessionId);
        }

        case "resume_work_session": {
          const workSession = yield* workSessions
            .get(command.workSessionId)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (workSession === null) {
            return failed("That work is gone.", command.workSessionId);
          }
          // §6.1 through upstream: the active thread switches provider and keeps its history
          // (D80). With no thread running, the work gets a fresh one on that account.
          if (workSession.activeThreadId !== null) {
            const switched = yield* engine
              .switchProvider({
                tag: "intent",
                threadId: workSession.activeThreadId,
                modelSelection: {
                  instanceId: command.providerInstanceId as never,
                  model: command.model,
                },
              })
              .pipe(
                Effect.as(true),
                Effect.catchCause(() => Effect.succeed(false)),
              );
            return switched
              ? done(
                  `Moved ${workSession.title} to ${command.providerInstanceId}.`,
                  command.workSessionId,
                )
              : failed("That account could not take the work.", command.workSessionId);
          }
          const threadId = yield* effects.startProviderSession({
            workSessionId: command.workSessionId,
            action: {
              kind: "start_provider_session",
              providerInstanceId: command.providerInstanceId,
              model: command.model,
              role: "implementation",
              runtimeMode: "approval-required",
              prompt: "",
              title: workSession.title,
            },
          });
          return threadId === null
            ? failed("That account is not available on this environment.", command.workSessionId)
            : done(`Opened another session on ${workSession.title}.`, command.workSessionId);
        }

        case "create_rules": {
          // `after_rule` placeholders are resolved to the previous rule's real
          // id here, which is why the grammar stays pure and id minting stays
          // where the clock is.
          const created: OrchestrationRuleId[] = [];
          for (const [index, draft] of command.rules.entries()) {
            const previous = created[index - 1];
            const trigger =
              draft.afterPrevious && previous !== undefined
                ? ({ kind: "after_rule", ruleId: previous } as const)
                : draft.trigger;
            const rule = yield* rules
              .create({
                id: `rule-${nextSuffix()}` as OrchestrationRuleId,
                workSessionId: command.workSessionId,
                source: command.source,
                trigger,
                action: draft.action,
                maxFirings: draft.maxFirings,
              })
              .pipe(Effect.catchCause(() => Effect.succeed(null)));
            if (rule === null) {
              return failed(
                created.length === 0
                  ? "I could not create the rule."
                  : "I created part of that and then could not finish. Check the rules on this work.",
                command.workSessionId,
              );
            }
            created.push(rule.id);
          }
          const count = created.length;
          return done(
            `Created ${count === 1 ? "one rule" : `${count} rules`}. ${
              count === 1 ? "It" : "Each"
            } will fire at most three times.`,
            command.workSessionId,
          );
        }

        case "switch_account": {
          const workSessionId = command.workSessionId ?? null;
          if (workSessionId === null)
            return failed("Open the work to move first, then say it again.");
          // Which account bills his work is his call: a token's device (maybe an agent) asks him instead.
          if ((yield* AskSource) !== "phone") {
            return failed(
              "Moving this work to another account needs him. Ask him to say it, or to pick the account in the model picker.",
              workSessionId,
            );
          }
          const workSession = yield* workSessions
            .get(workSessionId)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (workSession === null) return failed("That work is no longer here.");
          const providers = yield* providerRegistry.getProviders.pipe(
            Effect.catchCause(() => Effect.succeed([])),
          );
          const claude = providers.filter((provider) => provider.driver === "claudeAgent");
          const target = claude.find((provider) =>
            accountNames(provider).includes(command.accountLabel.toLowerCase()),
          );
          if (target === undefined) {
            const known = claude.map((provider) => provider.displayName ?? provider.instanceId);
            return failed(
              `There is no account called ${command.accountLabel}. Here: ${known.join(", ")}.`,
              workSessionId,
            );
          }
          const account = instanceAccount(target, false);
          const refusal = target.enabled
            ? accountRefusal(account)
            : `${account.label} is turned off`;
          if (refusal !== null) return failed(`${refusal}.`, workSessionId);
          const threadIds = [
            ...new Set(
              workSession.providerSessions
                .filter((session) => session.detachedAt === null)
                .map((session) => session.threadId),
            ),
          ];
          const group = target.continuation?.groupKey;
          let moved = 0;
          let later = 0;
          for (const threadId of threadIds) {
            const shell = yield* engine.threadShell(threadId);
            const from = providers.find(
              (provider) => provider.instanceId === shell?.providerInstanceId,
            );
            // Another home has other transcripts: the move would start the conversation over.
            if (group === undefined || from?.continuation?.groupKey !== group) continue;
            const result = yield* moves
              .request({ threadId, instanceId: target.instanceId })
              .pipe(Effect.catchCause(() => Effect.succeed(null)));
            if (result?.timing === "now") moved += 1;
            if (result?.timing === "next-turn") later += 1;
          }
          if (moved + later === 0) {
            return failed(
              `None of this work's threads can move to ${account.label}.`,
              workSessionId,
            );
          }
          return done(
            later === 0
              ? `This work now runs as ${account.label}.`
              : `This work moves to ${account.label}; a running turn finishes first.`,
            workSessionId,
          );
        }

        case "answer_gate": {
          const firing = yield* rules
            .getFiring(command.firingId)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (firing === null) return failed("That question is no longer waiting.");
          yield* rules
            .completeFiring({
              firingId: command.firingId,
              // A refusal is a completed decision, not a failure — and only a
              // `completed` outcome releases what was sequenced behind it.
              outcome: command.confirmed ? "completed" : "skipped",
              producedThreadId: null,
              detail: command.confirmed ? "Confirmed." : "Declined.",
            })
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (command.confirmed) {
            // Everything queued behind the question runs now — except the rule
            // that asked it, which would otherwise ask again immediately.
            yield* reactor
              .evaluate({
                workSessionId: firing.workSessionId,
                changedThreadId: null,
                skipRuleId: firing.ruleId,
              })
              .pipe(Effect.ignoreCause({ log: true }));
          }
          return done(command.confirmed ? "Confirmed." : "Left it alone.", firing.workSessionId);
        }
      }
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(failed("Something failed while doing that. It was not done.")),
      ),
    );

  return { execute } satisfies BatonIntentExecutor["Service"];
});

export const layer = Layer.effect(BatonIntentExecutor, make);
