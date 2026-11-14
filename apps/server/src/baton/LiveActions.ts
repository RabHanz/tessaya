/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off
/**
 * Two actions on live sessions that need no account (D73, D74).
 *
 * attach: a file sent from any device lands in the session's own directory under
 * `.baton/inbox/`, excluded from git, and the caller sends its path. Claude Code
 * reads a path mentioned as `@path`; a shell can use it as is.
 *
 * adopt: a Claude session running in a plain terminal or VS Code is moved into
 * Herdr with the same conversation: it is asked to exit with SIGTERM (only when
 * Claude Code itself reports it idle), and `baton --resume <id>` reopens it in a
 * Herdr pane. The private peer socket Claude Code writes is never used.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BATON_ATTACH_MAX_BYTES,
  type BatonLiveAdoptInput,
  type BatonLiveAdoptResult,
  type BatonLiveAttachInput,
  type BatonLiveAttachResult,
  type BatonLiveSetAccountInput,
  type BatonLiveSetAccountResult,
  type BatonLiveSetModelInput,
  type BatonLiveSetModelResult,
} from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import { claudeProjectSlug } from "@t3tools/baton-shared/liveTranscript";
import { sessionEffort, setLiveModel, transcriptModel } from "@t3tools/baton-shared/liveModel";
import { herdrSend } from "./HerdrSend.ts";
import { TESSAYA_CLI } from "./SessionCatalogLive.ts";

import {
  ProviderDriverKind,
  type BatonLiveQueued,
  type ServerProvider,
} from "@t3tools/baton-contracts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AccountPoolService } from "./AccountPoolService.ts";
import { AdoptedSessionService } from "./AdoptedSessionService.ts";
import { isThreadConfigDir, readAllProfileLiveSessions } from "./ClaudeLiveSessions.ts";
import { respawnClaudeInPane, TESSAYA_CLAUDE } from "./HerdrRespawn.ts";

/** A file name that cannot leave the inbox or hide. */
export const safeInboxName = (fileName: string, stamp: string): string => {
  const base = NodePath.basename(fileName)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  return `${stamp}-${base.length === 0 ? "file" : base.slice(0, 120)}`;
};

/** Keeps `.baton/` out of git (and the diff panel) without touching the project's own ignore files. */
const ignoreBatonDir = (cwd: string): void => {
  const ignore = NodePath.join(cwd, ".baton", ".gitignore");
  if (!NodeFS.existsSync(ignore)) NodeFS.writeFileSync(ignore, "*\n");
};

export const liveAttach = (
  adopted: AdoptedSessionService["Service"],
  input: BatonLiveAttachInput,
): Effect.Effect<BatonLiveAttachResult> =>
  Effect.gen(function* () {
    let cwd: string | null = null;
    if (input.target.pane !== undefined) {
      const found = yield* adopted.discover;
      cwd = found.candidates.find((c) => c.location.pane === input.target.pane)?.cwd ?? null;
    } else if (input.target.sessionId !== undefined) {
      const live = yield* readAllProfileLiveSessions();
      cwd = live.find((s) => s.sessionId === input.target.sessionId)?.cwd ?? null;
    }
    if (cwd === null)
      return { saved: false, path: null, detail: "That session is not running here now." };
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.byteLength > BATON_ATTACH_MAX_BYTES) {
      return { saved: false, path: null, detail: "Files up to 8 MB." };
    }
    const dir = cwd;
    return yield* Effect.sync(() => {
      const inbox = NodePath.join(dir, ".baton", "inbox");
      NodeFS.mkdirSync(inbox, { recursive: true });
      ignoreBatonDir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = NodePath.join(inbox, safeInboxName(input.fileName, stamp));
      NodeFS.writeFileSync(path, bytes, { mode: 0o600 });
      return { saved: true, path, detail: `Saved ${bytes.byteLength} bytes.` };
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        saved: false,
        path: null,
        detail: `Not saved: ${String(cause)}`.slice(0, 300),
      }),
    ),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const liveAdopt = (input: BatonLiveAdoptInput): Effect.Effect<BatonLiveAdoptResult> =>
  Effect.gen(function* () {
    const live = yield* readAllProfileLiveSessions();
    const session = live.find((s) => s.sessionId === input.sessionId);
    if (session === undefined)
      return { adopted: false, pane: null, detail: "That session is not running here now." };
    if (session.herdrPane !== null)
      return { adopted: true, pane: session.herdrPane, detail: "Already in Herdr." };
    if (session.status === "busy") {
      return {
        adopted: false,
        pane: null,
        detail: "It is working right now. Adopt it when it is idle.",
      };
    }
    return yield* Effect.promise(async () => {
      process.kill(session.pid, "SIGTERM");
      for (let i = 0; i < 40 && alive(session.pid); i += 1) await sleep(250);
      if (alive(session.pid))
        return { adopted: false, pane: null, detail: "It did not exit; left as it was." };
      const out = await new Promise<string>((resolve) =>
        NodeChildProcess.execFile(
          TESSAYA_CLI,
          ["--resume", session.sessionId, session.cwd],
          {
            timeout: 30_000,
            env: {
              ...process.env,
              PATH: `${NodePath.dirname(TESSAYA_CLI)}:${process.env.PATH ?? ""}`,
            },
          },
          (_error, stdout, stderr) => resolve(`${stdout}${stderr}`),
        ),
      );
      const pane = /running in (\S+) pane (\S+)/.exec(out);
      return pane === null
        ? {
            adopted: false,
            pane: null,
            detail: `tessaya --resume said: ${out.trim().slice(0, 200)}`,
          }
        : { adopted: true, pane: `${pane[1]}~${pane[2]}`, detail: `Now in Herdr ${pane[1]}.` };
    });
  });

const transcriptPath = (session: {
  readonly configDir?: string | undefined;
  readonly cwd: string;
  readonly sessionId: string;
}) =>
  NodePath.join(
    session.configDir ?? NodePath.join(NodeOS.homedir(), ".claude"),
    "projects",
    claudeProjectSlug(session.cwd),
    `${session.sessionId}.jsonl`,
  );

const TAIL_BYTES = 512 * 1024;

const readText = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The last TAIL_BYTES of a transcript, read without loading the whole file (they run to hundreds of MB). */
const readTail = (path: string): string => {
  let fd: number | null = null;
  try {
    fd = NodeFS.openSync(path, "r");
    const size = NodeFS.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    NodeFS.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) NodeFS.closeSync(fd);
  }
};

/** A Claude model's default effort, from T3's own model capabilities. */
export const defaultEffortOf = (
  providers: ReadonlyArray<ServerProvider>,
  model: string | null,
): string | null =>
  providers
    .filter((provider) => provider.driver === "claudeAgent")
    .flatMap((provider) => provider.models)
    .find((candidate) => candidate.slug === model)
    ?.capabilities?.optionDescriptors?.flatMap((descriptor) =>
      descriptor.id === "effort" && descriptor.type === "select" ? descriptor.options : [],
    )
    .find((option) => option.isDefault === true)?.id ?? null;

/** The effort a live session really runs at (never the composer's "as it is"), for the picker (ACCOUNTS-2). */
export const liveEffort = (
  sessionId: string,
  defaultEffortOf: (model: string | null) => string | null,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const found = (yield* readAllProfileLiveSessions()).find((s) => s.sessionId === sessionId);
    if (found === undefined) return null;
    const tail = readTail(transcriptPath(found));
    const settingsJson = readText(
      NodePath.join(found.configDir ?? NodePath.join(NodeOS.homedir(), ".claude"), "settings.json"),
    );
    return sessionEffort({
      transcriptTail: tail,
      settingsJson,
      modelDefault: defaultEffortOf(transcriptModel(tail)),
    });
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));

/** Tell a live Claude session its model and effort, and report only what it confirmed (D-live-model). */
export const liveSetModel = (
  adopted: AdoptedSessionService["Service"],
  input: BatonLiveSetModelInput,
  claudeModels: ReadonlyArray<string>,
): Effect.Effect<BatonLiveSetModelResult> =>
  Effect.gen(function* () {
    const live = yield* readAllProfileLiveSessions();
    const found = live.find((s) => s.sessionId === input.sessionId) ?? null;
    const path = found === null ? null : transcriptPath(found);
    const services = yield* Effect.context<never>();
    return yield* Effect.promise(() =>
      setLiveModel(
        {
          session: found,
          send: async (pane, text) =>
            (
              await Effect.runPromiseWith(services)(
                herdrSend(adopted, { pane, text, submit: true }),
              )
            ).delivered,
          mark: () => {
            try {
              return path === null ? null : NodeFS.statSync(path).size;
            } catch {
              // A fresh session has no transcript until its first line, which may be this command's.
              return path === null ? null : 0;
            }
          },
          since: (mark) => {
            try {
              return path === null ? "" : NodeFS.readFileSync(path).subarray(mark).toString("utf8");
            } catch {
              return "";
            }
          },
          wait: async (ms) => void (await sleep(ms)),
          claudeModels,
        },
        {
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        },
      ),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        state: "not_confirmed" as const,
        detail: `Not changed: ${String(cause)}`.slice(0, 300),
        confirmed: [],
      }),
    ),
  );

/** Whether the machine's own login (~/.claude) refreshes in place; its token never leaves this process. */
const machineLoginRefreshes = (): boolean => {
  try {
    return NodeFS.readFileSync(
      NodePath.join(NodeOS.homedir(), ".claude", ".credentials.json"),
      "utf8",
    ).includes('"refreshToken"');
  } catch {
    return false;
  }
};

/** tessaya-claude --switch: the slot's credential renamed into the thread's own dir (cswap's store, never echoed). */
const switchThreadDir = (dir: string, slot: string): Promise<{ ok: boolean; detail: string }> =>
  new Promise((resolve) =>
    NodeChildProcess.execFile(
      TESSAYA_CLAUDE,
      ["--switch", dir, slot],
      { timeout: 30_000 },
      (error, _stdout, stderr) =>
        resolve({
          ok: error === null,
          detail: String(stderr ?? "")
            .trim()
            .slice(0, 200),
        }),
    ),
  );

/**
 * Move one live Claude session to another account while it runs (LIVE-ACCOUNT). In its own config dir the running
 * claude re-reads the credential on its next request, sub-agents included, so nothing restarts. A session on the
 * machine's shared login first gets its own dir: one restart in its pane, same conversation, between turns.
 */
export const liveSetAccount = (
  input: BatonLiveSetAccountInput,
  accounts: ReadonlyArray<{ readonly key: string; readonly email: string | null }>,
): Effect.Effect<BatonLiveSetAccountResult> =>
  Effect.gen(function* () {
    const slot = input.accountKey;
    const target = accounts.find((account) => account.key === slot);
    if (!/^\d{1,4}$/.test(slot) || target === undefined)
      return { state: "refused" as const, detail: "That account is not in cswap's list here." };
    const targetName = target.email?.split("@")[0] ?? `slot ${slot}`;
    const services = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(services);
    const find = () =>
      run(readAllProfileLiveSessions()).then(
        (live) => live.find((s) => s.sessionId === input.sessionId) ?? null,
      );
    return yield* Effect.promise(async (): Promise<BatonLiveSetAccountResult> => {
      let session = await find();
      if (session === null)
        return { state: "not_running", detail: "That session is not running here now." };
      if (session.account !== null && session.account === targetName)
        return { state: "unchanged", detail: `It already runs as ${targetName}.` };
      if (!isThreadConfigDir(session.configDir)) {
        if (!NodeFS.existsSync(TESSAYA_CLAUDE))
          return { state: "refused", detail: "tessaya-claude is not installed on this machine." };
        if (machineLoginRefreshes())
          return {
            state: "refused",
            detail:
              "The machine's login signs in with a refresh token, which cannot be copied into one thread. Switch it machine-wide, or re-add it as a setup token.",
          };
        if (session.herdrPane === null)
          return {
            state: "not_in_herdr",
            detail: "Bring it into Herdr first; then it can restart in its pane.",
          };
        if (session.status === "busy" || session.status === "waiting")
          return { state: "busy", detail: "It restarts once and switches when this turn ends." };
        const respawned = await run(
          respawnClaudeInPane({ paneRef: session.herdrPane, sessionId: session.sessionId }),
        );
        if (!respawned.respawned)
          return { state: "refused", detail: `Not restarted: ${respawned.detail}` };
        for (let i = 0; i < 40 && !isThreadConfigDir(session?.configDir); i += 1) {
          await sleep(500);
          session = await find();
        }
        if (session === null || !isThreadConfigDir(session.configDir))
          return {
            state: "refused",
            detail: "It restarted but not in its own dir. Its thread still works as before.",
          };
      }
      const dir = session.configDir;
      if (!isThreadConfigDir(dir)) return { state: "refused", detail: "It has no dir of its own." };
      const switched = await switchThreadDir(dir, slot);
      return switched.ok
        ? { state: "switched", detail: `Now on ${targetName}; its next request runs there.` }
        : {
            state: "refused",
            detail: `Not switched: ${switched.detail || "tessaya-claude refused."}`,
          };
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        state: "refused" as const,
        detail: `Not switched: ${String(cause)}`.slice(0, 300),
      }),
    ),
  );

/**
 * Machine-wide: every session in its own config dir moves to `slot` while it runs. Sessions on the machine's shared
 * login follow the machine login (cswap's switch) by themselves, so they are not touched.
 */
export const switchOwnDirSessions = Effect.fn("LiveActions.switchOwnDirSessions")(function* (
  slot: string,
) {
  const dirs = (yield* readAllProfileLiveSessions()).flatMap((session) =>
    isThreadConfigDir(session.configDir) ? [session.configDir] : [],
  );
  let switched = 0;
  for (const dir of new Set(dirs)) {
    if ((yield* Effect.promise(() => switchThreadDir(dir, slot))).ok) switched += 1;
  }
  return { switched, failed: new Set(dirs).size - switched };
});

/** Applies a queued change once its session is idle; "busy" leaves it queued (ThreadAccountMoves). */
export const makeApplyLive = Effect.gen(function* () {
  const adopted = yield* AdoptedSessionService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const pool = yield* AccountPoolService;
  return (sessionId: string, change: BatonLiveQueued) =>
    Effect.gen(function* () {
      if (change.model !== undefined || change.effort !== undefined) {
        const claudeModels = (yield* registry.getProviders)
          .filter((provider) => provider.driver === "claudeAgent")
          .flatMap((provider) => provider.models.map((model) => model.slug));
        const result = yield* liveSetModel(
          adopted,
          {
            sessionId,
            ...(change.model === undefined ? {} : { model: change.model }),
            ...(change.effort === undefined ? {} : { effort: change.effort }),
          },
          claudeModels,
        );
        if (result.state === "busy") return { state: "busy" as const };
        if (result.state !== "applied") return { state: "failed" as const, detail: result.detail };
      }
      if (change.accountKey !== undefined) {
        const accounts = yield* pool.read(ProviderDriverKind.make("claudeAgent")).pipe(
          Effect.map((read) => read.accounts),
          Effect.orElseSucceed(() => []),
        );
        const result = yield* liveSetAccount(
          { sessionId, accountKey: change.accountKey },
          accounts,
        );
        if (result.state === "busy") return { state: "busy" as const };
        if (result.state !== "switched" && result.state !== "unchanged")
          return { state: "failed" as const, detail: result.detail };
      }
      return { state: "done" as const };
    });
});
