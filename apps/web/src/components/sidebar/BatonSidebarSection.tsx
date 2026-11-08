/**
 * Baton's block in upstream's sidebar, mounted by one line in `Sidebar.tsx`
 * (`vendor-patches/t3code/0006-web-sidebar.patch`). Everything the block needs is resolved here
 * from upstream's own state, so the hook passes only what the sidebar alone knows: which thread
 * the route has open, and how to open one.
 */
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  batonDesktopBridge,
  type BatonFleetEntry,
  type BatonIntentResolution,
  type BatonJobBridgeRequest,
  type BatonCommitmentBridgeRequest,
  type BatonPhoneBridgeRequest,
  type BatonCloudBridgeRequest,
  type BatonWeaveBridgeRequest,
  type BatonMemoryBridgeRequest,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/baton-contracts";
import { homeOf, resolveRunOn } from "@t3tools/baton-shared/runOn";
import {
  AuthAccessTokenType,
  AuthBatonMemorySyncScope,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, type ReactNode } from "react";
import { batonUsageSummaries } from "../../batonUsage";

import { focusedWorkSessionFromThreads } from "../../batonContextView";
import { useBatonFleet } from "../../batonFleetResolvers";
import {
  deriveProviderEntriesByEnvironment,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { weaveAcross, weaveSessionsOf } from "./batonWeaveAcross";
import { environmentServerConfigsAtom } from "../../state/server";
import { useBatonFleets } from "../../state/batonWorkSessions";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { authEnvironment } from "../../state/auth";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";
import { syncFailureLine, syncPeerUrl } from "../../batonMemorySync";
import { batonProjectKey } from "@t3tools/baton-shared/jobPlacement";
import { BatonIntentBar } from "./BatonIntentBar";
import { BatonProjectsBlock } from "./BatonProjectsBlock";

export { batonProjectKey };

export function BatonSidebarSection(props: {
  /** The thread the route has open, as upstream's scoped thread key. */
  readonly activeThreadKey: string | null;
  readonly onOpenThread: (thread: ScopedThreadRef) => unknown;
}): ReactNode {
  const fleet = useBatonFleet();
  const fleets = useBatonFleets(fleet.environmentIds);
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primary = fleet.environmentIds[0];
  // His memory lives on this app's own server, not on whichever connection registered first.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const memoryHome =
    fleet.environmentIds.find((id) => id === primaryEnvironmentId) ?? fleet.environmentIds[0];
  // Where each job was started, so a later stop or agree asks the server that holds it.
  const jobHomes = useRef(new Map<string, string>());
  const usage = JSON.stringify(
    batonUsageSummaries(
      [...serverConfigs].map(([environmentId, config]) => ({
        box: fleet.resolveEnvironmentLabel(environmentId) ?? environmentId,
        providers: config.providers,
      })),
    ),
  );
  // Baton's own window draws these; the push is by change, not on a timer.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the desktop shell outside React
  useEffect(() => {
    batonDesktopBridge()?.setBatonUsage?.(JSON.parse(usage));
  }, [usage]);
  const quiet = { reportFailure: false } as const;
  const watchGet = useAtomCommand(batonWorkSessions.watchGet, quiet);
  const resolveIntent = useAtomCommand(batonWorkSessions.intentResolve, quiet);
  const runIntent = useAtomCommand(batonWorkSessions.intentRun, quiet);
  const weaveSend = useAtomCommand(batonWorkSessions.weaveSend, quiet);
  const weaveList = useAtomCommand(batonWorkSessions.weaveList, quiet);
  const weaveTick = useAtomCommand(batonWorkSessions.weaveTick, quiet);
  const phoneCall = useAtomCommand(batonWorkSessions.phoneCall, quiet);
  const cloudRead = useAtomCommand(batonWorkSessions.cloudRead, quiet);
  const cloudAct = useAtomCommand(batonWorkSessions.cloudAct, quiet);
  const cloudApprove = useAtomCommand(batonWorkSessions.cloudApprove, quiet);
  const commitmentsList = useAtomCommand(batonWorkSessions.commitmentsList, quiet);
  const commitmentsUpsert = useAtomCommand(batonWorkSessions.commitmentsUpsert, quiet);
  const memoryList = useAtomCommand(batonWorkSessions.memoryList, quiet);
  const memorySearch = useAtomCommand(batonWorkSessions.memorySearch, quiet);
  const memoryAdd = useAtomCommand(batonWorkSessions.memoryAdd, quiet);
  const memoryEdit = useAtomCommand(batonWorkSessions.memoryEdit, quiet);
  const memoryPin = useAtomCommand(batonWorkSessions.memoryPin, quiet);
  const memoryForget = useAtomCommand(batonWorkSessions.memoryForget, quiet);
  const memoryAccept = useAtomCommand(batonWorkSessions.memoryAccept, quiet);
  const memoryRecall = useAtomCommand(batonWorkSessions.memoryRecall, quiet);
  const memoryUsed = useAtomCommand(batonWorkSessions.memoryUsed, quiet);
  const memoryHistory = useAtomCommand(batonWorkSessions.memoryHistory, quiet);
  const memoryRestore = useAtomCommand(batonWorkSessions.memoryRestore, quiet);
  const memoryExport = useAtomCommand(batonWorkSessions.memoryExport, quiet);
  const memoryLearn = useAtomCommand(batonWorkSessions.memoryLearn, quiet);
  const memoryImport = useAtomCommand(batonWorkSessions.memoryImport, quiet);
  const memoryPull = useAtomCommand(batonWorkSessions.memoryPull, quiet);
  const memorySyncPush = useAtomCommand(batonWorkSessions.memorySyncPush, quiet);
  const createPairingCredential = useAtomCommand(authEnvironment.createPairingCredential, quiet);
  const jobList = useAtomCommand(batonWorkSessions.jobList, quiet);
  const jobTeam = useAtomCommand(batonWorkSessions.jobTeam, quiet);
  const jobPlace = useAtomCommand(batonWorkSessions.jobPlace, quiet);
  const jobHandoff = useAtomCommand(batonWorkSessions.jobHandoff, quiet);
  const jobAgree = useAtomCommand(batonWorkSessions.jobAgree, quiet);
  const jobRefine = useAtomCommand(batonWorkSessions.jobRefine, quiet);
  const jobSplit = useAtomCommand(batonWorkSessions.jobSplit, quiet);
  const jobStop = useAtomCommand(batonWorkSessions.jobStop, quiet);
  const jobSchedule = useAtomCommand(batonWorkSessions.jobSchedule, quiet);
  const jobGrant = useAtomCommand(batonWorkSessions.jobGrant, quiet);
  const jobRevoke = useAtomCommand(batonWorkSessions.jobRevoke, quiet);
  if (primary === undefined) return null;

  const projectByEnvironmentId = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const projectByKey = new Map(projects.map((project) => [batonProjectKey(project).key, project]));
  const providerEntries = deriveProviderEntriesByEnvironment(
    [...serverConfigs].map(([environmentId, config]) => [environmentId, config.providers]),
  );

  const resolveWorkProject = (environmentId: EnvironmentId, projectId: ProjectId) => {
    const project = projectByEnvironmentId.get(`${environmentId}:${projectId}`);
    return project === undefined ? null : batonProjectKey(project);
  };
  const resolveWorkAccount = (environmentId: EnvironmentId, entry: BatonFleetEntry) => {
    const instance = entry.threads.find(
      (thread) => thread.threadId === entry.activeThreadId,
    )?.providerInstanceId;
    return instance == null
      ? null
      : (fleet.resolveProviderAccount(environmentId, instance)?.label ?? null);
  };
  const listHandoffTargets = (environmentId: EnvironmentId) =>
    [...(providerEntries.get(environmentId)?.values() ?? [])].flatMap((entry) => {
      if (!isProviderInstancePickerReady(entry)) return [];
      const model = entry.models.find((candidate) => candidate.isDefault) ?? entry.models[0];
      return model === undefined
        ? []
        : [{ instanceId: entry.instanceId, label: entry.displayName, model: model.slug }];
    });
  // A work session opens the thread it runs through; with none live there is nothing to open.
  const openWorkSession = (environmentId: EnvironmentId, entry: BatonFleetEntry) => {
    const threadId = entry.activeThreadId ?? entry.threads[0]?.threadId ?? null;
    if (threadId !== null) void props.onOpenThread(scopeThreadRef(environmentId, threadId));
  };
  /** The desktop assistant's job tools: the project by the name he said, the first ready Claude as the worker. */
  const onJob = async (request: BatonJobBridgeRequest): Promise<unknown> => {
    const { op, args } = request;
    const text = (key: string) => (typeof args[key] === "string" ? args[key] : "");
    const targets = fleet.environmentIds.map((id) => ({
      id: id as string,
      label: fleet.resolveEnvironmentLabel(id) ?? (id as string),
    }));
    // "Run on": a job starts on the server he names; later calls about it go to the server that holds it.
    let target = primary;
    if (op === "start") {
      const choice = resolveRunOn(text("runOn"), targets, primary as string);
      if (!choice.ok) throw new Error(choice.why);
      target = choice.id as typeof primary;
    } else if (typeof args["id"] === "string") {
      target = homeOf(args["id"], jobHomes.current, primary as string) as typeof primary;
    }
    const env = { environmentId: target };
    const done = <V,>(result: { _tag: string; value?: V }): V => {
      if (result._tag !== "Success") throw new Error("That job request failed. Nothing changed.");
      return result.value as V;
    };
    switch (op) {
      case "list": {
        // Every connected server's jobs, each marked with where it runs.
        const all = await Promise.all(
          fleet.environmentIds.map(async (id) => {
            const result = await jobList({ environmentId: id, input: {} });
            if (result._tag !== "Success") return [];
            const label = fleet.resolveEnvironmentLabel(id) ?? (id as string);
            return (result.value as { jobs: ReadonlyArray<{ workSessionId: string }> }).jobs.map(
              (job) => {
                jobHomes.current.set(job.workSessionId, id as string);
                return { ...job, runOn: label };
              },
            );
          }),
        );
        return { jobs: all.flat() };
      }
      case "watch":
        return done(await watchGet({ ...env, input: {} }));
      // His own server's team; the persona asking is checked there, and walls apply to it.
      case "team":
        return done(
          await jobTeam({
            ...env,
            input: {
              ...(text("agent") === "" ? {} : { agent: text("agent") }),
              ...(args["admin"] === true ? { admin: true } : {}),
            },
          }),
        );
      case "start": {
        // The server that runs it places it: the project he named there, and its first ready Claude.
        const strings = (key: string) =>
          Array.isArray(args[key]) ? (args[key] as ReadonlyArray<string>) : [];
        const started = done(
          await jobPlace({
            ...env,
            input: {
              project: text("project"),
              title: text("title"),
              goal: text("goal"),
              folders: strings("folders"),
              tools: strings("tools") as never,
              ...(typeof args["reportEveryMinutes"] === "number"
                ? { reportEveryMinutes: args["reportEveryMinutes"] }
                : {}),
            },
          }),
        );
        jobHomes.current.set(
          (started as { terms: { workSessionId: string } }).terms.workSessionId,
          target as string,
        );
        return started;
      }
      case "rule_preview":
      case "rule_run": {
        // The sentence goes through the rule grammar, which checks what the assistant made of his words.
        const input = { text: text("sentence") };
        const { resolution } = done(await resolveIntent({ ...env, input })) as {
          resolution: BatonIntentResolution;
        };
        if (resolution.outcome === "refused")
          return { text: `Not set up: ${resolution.refusal.message}` };
        if (resolution.command.kind !== "create_rules")
          return { text: "That sentence is not a rule. Nothing was set up." };
        if (op === "rule_preview")
          return { text: `Read this back and ask him: ${resolution.description}` };
        const ran = done(await runIntent({ ...env, input })) as { reply: string };
        return { text: ran.reply === "" ? "Set up." : ran.reply };
      }
      case "split":
        return done(
          await jobSplit({
            ...env,
            input: {
              id: text("id") as never,
              parts: (Array.isArray(args["parts"]) ? args["parts"] : []) as never,
            },
          }),
        );
      case "handoff":
        return done(
          await jobHandoff({
            ...env,
            input: {
              id: text("id") as never,
              instance: text("instance"),
              ...(text("note") === "" ? {} : { note: text("note") }),
            },
          }),
        );
      case "stop":
        return done(await jobStop({ ...env, input: { id: text("id") as never } }));
      case "schedule":
        return done(
          await jobSchedule({
            ...env,
            input: {
              id: text("id") as never,
              everyMinutes: typeof args["everyMinutes"] === "number" ? args["everyMinutes"] : null,
            },
          }),
        );
      case "agree":
        return done(await jobAgree({ ...env, input: { id: text("id") as never } }));
      case "refine":
        return done(
          await jobRefine({
            ...env,
            input: {
              id: text("id") as never,
              text: text("text"),
              via: args["via"] === "text" ? "text" : "voice",
              widens: args["widens"] === true,
              ...(args["note"] === true ? { note: true } : {}),
            },
          }),
        );
      case "grant":
      case "revoke":
        return done(
          await (op === "grant" ? jobGrant : jobRevoke)({
            ...env,
            input: { id: text("id") as never, channel: text("channel") as never },
          }),
        );
    }
  };
  const onWeave = async (request: BatonWeaveBridgeRequest): Promise<unknown> => {
    const commands = { send: weaveSend, list: weaveList, tick: weaveTick };
    const environments = [memoryHome, ...fleet.environmentIds.filter((id) => id !== memoryHome)]
      .filter((id) => id !== undefined)
      .map((id) => ({
        id: id as string,
        label: fleet.resolveEnvironmentLabel(id) ?? id,
        sessions: weaveSessionsOf(fleets.find((f) => f.environmentId === id)?.fleet ?? null),
      }));
    return weaveAcross(request, environments, async (environmentId, op, args) => {
      const run = commands[op] as unknown as (call: {
        readonly environmentId: EnvironmentId;
        readonly input: never;
      }) => Promise<
        | { readonly _tag: "Success"; readonly value: unknown }
        | ({ readonly _tag: "Failure" } & Parameters<typeof squashAtomCommandFailure>[0])
      >;
      const result = await run({
        environmentId: environmentId as EnvironmentId,
        input: args as never,
      });
      if (result._tag === "Success") return { ok: true, value: result.value };
      const error = squashAtomCommandFailure(result) as {
        reason?: unknown;
        missing?: unknown;
        _tag?: unknown;
      } | null;
      return {
        ok: false,
        reason:
          typeof error?.reason === "string"
            ? error.reason
            : "Weaving did not answer. Nothing was sent.",
        kind:
          error?.missing === true
            ? "missing"
            : error?._tag === "EnvironmentAuthorizationError"
              ? "unreachable"
              : "other",
      };
    });
  };
  const onCloud = async (request: BatonCloudBridgeRequest): Promise<unknown> => {
    if (request.op === "environments") {
      return fleet.environmentIds.map((id) => {
        // Its supervisor's phase: connected, connecting, backoff, offline, blocked or available.
        const state = AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(id)));
        return {
          id,
          label: fleet.resolveEnvironmentLabel(id) ?? id,
          state: Option.isSome(state) ? state.value.phase : "unknown",
        };
      });
    }
    // Only an environment this window is actually connected to can be asked.
    const target = fleet.environmentIds.find((id) => id === request.environmentId) ?? primary;
    const result = await (
      request.op === "read" ? cloudRead : request.op === "approve" ? cloudApprove : cloudAct
    )({ environmentId: target, input: request.args as never });
    if (result._tag === "Success") return result.value;
    const refused = JSON.stringify(result).includes("baton:cloud-approve");
    return {
      ok: false,
      error: refused
        ? "This connection is not allowed to approve cloud tasks. Pair this computer with the approval permission on the computer that runs them."
        : "The computer that runs cloud tasks did not answer.",
    };
  };
  const onPhone = async (request: BatonPhoneBridgeRequest): Promise<unknown> => {
    const result = await phoneCall({
      environmentId: primary,
      input: { op: request.op, args: request.args } as never,
    });
    if (result._tag === "Success") return (result.value as { value: unknown }).value;
    const reason = (squashAtomCommandFailure(result) as { reason?: unknown } | null)?.reason;
    throw new Error(typeof reason === "string" ? reason : "The phone relay did not answer.");
  };
  const onCommitments = async (request: BatonCommitmentBridgeRequest): Promise<unknown> => {
    const run = (request.op === "list" ? commitmentsList : commitmentsUpsert) as unknown as (call: {
      readonly environmentId: typeof primary;
      readonly input: never;
    }) => Promise<
      | { readonly _tag: "Success"; readonly value: unknown }
      | ({ readonly _tag: "Failure" } & Parameters<typeof squashAtomCommandFailure>[0])
    >;
    const result = await run({ environmentId: primary, input: request.args as never });
    if (result._tag === "Success") return result.value;
    const reason = (squashAtomCommandFailure(result) as { reason?: unknown } | null)?.reason;
    throw new Error(
      typeof reason === "string" ? reason : "The commitments did not answer. Nothing changed.",
    );
  };
  /** The desktop assistant's memory calls: the memory RPCs, with a refusal's reason kept in plain words. */
  const onMemory = async (request: BatonMemoryBridgeRequest): Promise<unknown> => {
    if (request.op === "syncPeers")
      return fleet.environmentIds.map((environmentId) => {
        const baseUrl = readPreparedConnection(environmentId)?.httpBaseUrl;
        return {
          environmentId,
          label: fleet.resolveEnvironmentLabel(environmentId) ?? environmentId,
          local: environmentId === primaryEnvironmentId,
          // Where its credential goes, with any relay path; the server syncs to it there.
          ...(baseUrl === undefined ? {} : { baseUrl }),
        };
      });
    if (request.op === "syncPair") {
      if (memoryHome === undefined) throw new Error("This app's own server is not connected.");
      // A one-time code that another machine trades for a credential which can only sync this server's memory.
      const made = await createPairingCredential({
        environmentId: memoryHome,
        input: { label: "Tessaya memory sync", scopes: [AuthBatonMemorySyncScope] },
      });
      if (made._tag !== "Success") throw new Error("Could not make a pairing code here.");
      return { code: made.value.credential };
    }
    if (request.op === "syncLink") {
      const environmentId = String(request.args["environmentId"]) as EnvironmentId;
      const base = readPreparedConnection(environmentId)?.httpBaseUrl;
      if (base === undefined) throw new Error("That server is not connected.");
      const url = syncPeerUrl(base, "oauth/token");
      if (url === null)
        throw new Error(
          "That server is reached over plain http off this machine and the tailnet, so no credential is sent to it.",
        );
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: String(request.args["code"]).trim(),
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: AuthBatonMemorySyncScope,
          client_label: "Tessaya memory sync",
        }),
      }).catch(() => null);
      if (response === null)
        throw new Error("That server did not answer. Try again when it is online.");
      const json = (await response.json().catch(() => null)) as {
        access_token?: string;
        expires_in?: number;
      } | null;
      if (!response.ok || typeof json?.access_token !== "string")
        throw new Error(syncFailureLine(response.status));
      return {
        origin: url.origin,
        baseUrl: base,
        token: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 0) * 1000,
      };
    }
    const commands = {
      list: memoryList,
      search: memorySearch,
      add: memoryAdd,
      edit: memoryEdit,
      pin: memoryPin,
      forget: memoryForget,
      accept: memoryAccept,
      recall: memoryRecall,
      used: memoryUsed,
      history: memoryHistory,
      restore: memoryRestore,
      export: memoryExport,
      learn: memoryLearn,
      import: memoryImport,
      pull: memoryPull,
      syncPush: memorySyncPush,
    };
    type Settled =
      | { readonly _tag: "Success"; readonly value: unknown }
      | ({ readonly _tag: "Failure" } & Parameters<typeof squashAtomCommandFailure>[0]);
    const run = commands[request.op] as unknown as (call: {
      readonly environmentId: typeof primary;
      readonly input: never;
    }) => Promise<Settled>;
    const result = await run({ environmentId: memoryHome, input: request.args as never });
    if (result._tag === "Success") return result.value;
    const reason = (squashAtomCommandFailure(result) as { reason?: unknown } | null)?.reason;
    throw new Error(
      typeof reason === "string" ? reason : "Memory did not answer. Nothing changed.",
    );
  };
  const primaryEntries = fleets.find((entry) => entry.environmentId === primary)?.fleet?.entries;

  return (
    <div className="flex flex-col gap-1 pt-1">
      <BatonIntentBar
        environmentId={primary}
        // §14 rung 3: the work the open thread belongs to.
        focusedWorkSessionId={focusedWorkSessionFromThreads(
          primaryEntries ?? [],
          primary,
          props.activeThreadKey,
        )}
        onRan={() => undefined}
        onJob={onJob}
        onMemory={onMemory}
        onCommitments={onCommitments}
        onWeave={onWeave}
        onPhone={onPhone}
        onCloud={onCloud}
      />
      <BatonProjectsBlock
        environmentIds={fleet.environmentIds}
        resolveEnvironmentLabel={fleet.resolveEnvironmentLabel}
        resolveWorkProject={resolveWorkProject}
        resolveWorkAccount={resolveWorkAccount}
        resolveProjectForKey={(key) => projectByKey.get(key) ?? null}
        onOpenWorkSession={openWorkSession}
        onOpenThreadById={(environmentId, threadId) =>
          void props.onOpenThread(scopeThreadRef(environmentId, threadId as ThreadId))
        }
        listHandoffTargets={listHandoffTargets}
      />
    </div>
  );
}
