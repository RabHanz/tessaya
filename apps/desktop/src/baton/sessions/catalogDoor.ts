/**
 * The session catalog with T3's window closed (GEN-6): this machine's server answers through its door, with the same
 * translation the sidebar uses. Acting on another machine stays on T3's own session to it, so that is refused in a
 * sentence rather than opening the window.
 */
import type { BatonSessionRequest } from "@t3tools/tessaya-contracts";
import {
  answerCatalogRequest,
  type CatalogCommands,
} from "@t3tools/tessaya-shared/catalogRequests";

const METHODS: Readonly<Record<keyof CatalogCommands, string>> = {
  list: "baton.sessions.list",
  resume: "baton.sessions.resume",
  reattach: "baton.sessions.reattach",
  create: "baton.sessions.create",
  autoResume: "baton.sessions.autoresume",
  cleanup: "baton.sessions.cleanup",
  folders: "baton.sessions.folders",
  waiting: "baton.sessions.waiting",
};

const ACTS: Partial<Record<BatonSessionRequest["kind"], string>> = {
  catalogStop: "stop that session",
  catalogReattach: "reattach that session",
  catalogResume: "resume that session",
  catalogCreate: "start a session",
  catalogFolders: "list its folders",
  catalogWaiting: "read that session's kept messages",
};

const UNANSWERED: ReadonlySet<BatonSessionRequest["kind"]> = new Set([
  "catalogList",
  "catalogFolders",
  "catalogAutoResume",
]);

export const answerOnDoor = (
  request: BatonSessionRequest,
  input: {
    readonly here: { readonly environmentId: string; readonly label: string };
    readonly labelOf: (environmentId: string) => string;
    readonly direct: (method: string, input: unknown) => Promise<unknown>;
  },
): Promise<{ readonly ok: boolean; readonly detail: string } | null> => {
  const act = ACTS[request.kind];
  if (
    act !== undefined &&
    "environmentId" in request &&
    request.environmentId !== input.here.environmentId
  )
    return Promise.resolve({
      ok: false,
      detail: `Open T3 to ${act} on ${input.labelOf(request.environmentId)}.`,
    });
  let failed = false;
  const commands = Object.fromEntries(
    Object.entries(METHODS).map(([name, method]) => [
      name,
      (call: { readonly input: unknown }) =>
        input.direct(method, call.input).then(
          (value) => ({ _tag: "Success", value }),
          (cause: unknown) => {
            failed = true;
            return { _tag: "Failure", cause };
          },
        ),
    ]),
  ) as unknown as CatalogCommands;
  return answerCatalogRequest(request, {
    commands,
    environmentIds: [input.here.environmentId],
    label: () => input.here.label,
    localEnvironmentId: input.here.environmentId,
  }).then((reply) =>
    // The sidebar reads a failed list as empty across many servers; with one server, a failure is not "nothing there".
    failed && UNANSWERED.has(request.kind)
      ? { ok: false, detail: "This computer's server did not answer. Nothing changed." }
      : reply,
  );
};
