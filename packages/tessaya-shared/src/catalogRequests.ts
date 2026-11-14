/**
 * Baton's window asks for the session catalog, one environment at a time: the T3 sidebar answers with the commands a
 * click would use, and the desktop, with T3's window closed, with this machine's server through its door. Pure over
 * its commands, so it is tested without a connection.
 */
import type {
  BatonCatalogCreateInput,
  BatonCatalogCreateResult,
  BatonCatalogAutoResumeInput,
  BatonCatalogAutoResumeResult,
  BatonCatalogCleanupInput,
  BatonCatalogCleanupResult,
  BatonCatalogFoldersInput,
  BatonCatalogFoldersResult,
  BatonCatalogListInput,
  BatonCatalogListResult,
  BatonCatalogResumeInput,
  BatonCatalogResumeResult,
  BatonCatalogWaitingInput,
  BatonCatalogWaitingResult,
  BatonReattachInput,
  BatonReattachResult,
  BatonSessionRequest,
} from "@t3tools/tessaya-contracts";

type Answer<T> = { readonly _tag: string; readonly value?: T };
type Command<I, O> = (args: { environmentId: never; input: I }) => Promise<Answer<O>>;

export interface CatalogCommands {
  readonly list: Command<typeof BatonCatalogListInput.Type, typeof BatonCatalogListResult.Type>;
  readonly resume: Command<
    typeof BatonCatalogResumeInput.Type,
    typeof BatonCatalogResumeResult.Type
  >;
  readonly reattach: Command<typeof BatonReattachInput.Type, typeof BatonReattachResult.Type>;
  readonly create: Command<
    typeof BatonCatalogCreateInput.Type,
    typeof BatonCatalogCreateResult.Type
  >;
  readonly autoResume: Command<
    typeof BatonCatalogAutoResumeInput.Type,
    typeof BatonCatalogAutoResumeResult.Type
  >;
  readonly cleanup: Command<
    typeof BatonCatalogCleanupInput.Type,
    typeof BatonCatalogCleanupResult.Type
  >;
  readonly folders: Command<
    typeof BatonCatalogFoldersInput.Type,
    typeof BatonCatalogFoldersResult.Type
  >;
  readonly waiting: Command<
    typeof BatonCatalogWaitingInput.Type,
    typeof BatonCatalogWaitingResult.Type
  >;
}

type Reply = { readonly ok: boolean; readonly detail: string };
/** What the command said, in a few plain words, so a failed call is not a bare "could not". */
const describeFailure = (answer: object): string => {
  const cause = (answer as { cause?: unknown; _tag?: string }).cause;
  const text =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : String((answer as { _tag?: string })._tag ?? "no answer");
  return text.replace(/\s+/g, " ").slice(0, 160);
};
const NO = (detail: string): Reply => ({ ok: false, detail });
const env = (id: string) => id as never;

/** The catalog requests of Baton's window; null when the request is not one of them. */
export const answerCatalogRequest = async (
  request: BatonSessionRequest,
  deps: {
    readonly commands: CatalogCommands;
    readonly environmentIds: ReadonlyArray<string>;
    readonly label: (environmentId: string) => string;
    /** The environment this app itself runs on, so New session can default to this computer. */
    readonly localEnvironmentId?: string | null;
  },
): Promise<Reply | null> => {
  const { commands } = deps;
  if (request.kind === "catalogList") {
    const rows = await Promise.all(
      deps.environmentIds.map(async (environmentId) => {
        const answer = await commands
          .list({
            environmentId: env(environmentId),
            input: {
              query: request.query,
              limit: 200,
              ...(request.background === true ? { background: true } : {}),
            },
          })
          .catch(() => null);
        if (answer === null || answer._tag !== "Success" || answer.value === undefined) return [];
        return answer.value.sessions.map((row) => ({
          ...row,
          environmentId,
          machine: deps.label(environmentId),
          local: environmentId === deps.localEnvironmentId,
        }));
      }),
    );
    return { ok: true, detail: JSON.stringify(rows.flat()) };
  }
  if (request.kind === "catalogStop") {
    const answer = await commands.autoResume({
      environmentId: env(request.environmentId),
      input: { action: "stop", sessionId: request.sessionId },
    });
    return answer._tag === "Success"
      ? { ok: true, detail: "Stopped." }
      : NO("That session could not be stopped.");
  }
  if (request.kind === "catalogAutoResume") {
    // The switch applies to every connected environment; it reads as on when any one is on.
    const answers = await Promise.all(
      deps.environmentIds.map((environmentId) =>
        commands
          .autoResume({ environmentId: env(environmentId), input: { action: request.action } })
          .catch(() => null),
      ),
    );
    const enabled = answers.some((a) => a?._tag === "Success" && a.value?.enabled === true);
    return { ok: true, detail: JSON.stringify({ enabled }) };
  }
  if (request.kind === "catalogCleanup") {
    // One batch per environment; the window shows each machine's counts and keeps the archived ids so it can be undone.
    const results = await Promise.all(
      deps.environmentIds.map(async (environmentId) => {
        const answer = await commands
          .cleanup({ environmentId: env(environmentId), input: { apply: request.apply } })
          .catch(() => null);
        return answer === null || answer._tag !== "Success" || answer.value === undefined
          ? { environmentId, machine: deps.label(environmentId), failed: true as const }
          : {
              environmentId,
              machine: deps.label(environmentId),
              failed: false as const,
              ...answer.value,
            };
      }),
    );
    return { ok: true, detail: JSON.stringify(results) };
  }
  if (request.kind === "catalogResume") {
    const answer = await commands.resume({
      environmentId: env(request.environmentId),
      input: {
        sessionId: request.sessionId,
        ...(request.cwd === null ? {} : { cwd: request.cwd }),
      },
    });
    if (answer._tag !== "Success" || answer.value === undefined)
      return NO(`That session could not be resumed: ${describeFailure(answer)}`);
    return { ok: answer.value.state !== "failed", detail: JSON.stringify(answer.value) };
  }
  if (request.kind === "catalogReattach") {
    const answer = await commands.reattach({
      environmentId: env(request.environmentId),
      input: {
        sessionId: request.sessionId,
        ...(request.cwd === null ? {} : { cwd: request.cwd }),
        ...(request.confirmPane === undefined ? {} : { confirmPane: request.confirmPane }),
      },
    });
    if (answer._tag !== "Success" || answer.value === undefined)
      return NO(`That session could not be reattached: ${describeFailure(answer)}`);
    return { ok: true, detail: JSON.stringify(answer.value) };
  }
  if (request.kind === "catalogCreate") {
    const answer = await commands.create({
      environmentId: env(request.environmentId),
      input: {
        cwd: request.cwd,
        agent: "claude",
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        ...(request.message === undefined ? {} : { message: request.message }),
      },
    });
    if (answer._tag !== "Success" || answer.value === undefined)
      return NO("That session could not be started.");
    return { ok: answer.value.state !== "failed", detail: JSON.stringify(answer.value) };
  }
  if (request.kind === "catalogFolders") {
    const answer = await commands
      .folders({ environmentId: env(request.environmentId), input: {} })
      .catch(() => null);
    const folders = answer?._tag === "Success" ? (answer.value?.folders ?? []) : [];
    return { ok: true, detail: JSON.stringify(folders.map((f) => f.cwd)) };
  }
  if (request.kind === "catalogWaiting") {
    const answer = await commands.waiting({
      environmentId: env(request.environmentId),
      input: {
        sessionId: request.sessionId,
        ...(request.discard === undefined ? {} : { discard: request.discard }),
      },
    });
    if (answer._tag !== "Success" || answer.value === undefined)
      return NO(`Its kept messages could not be read: ${describeFailure(answer)}`);
    return { ok: true, detail: JSON.stringify(answer.value) };
  }
  return null;
};
