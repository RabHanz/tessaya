/**
 * A token account's Claude process reads its login from a config dir of its own, so the account can change while it
 * runs (hot account swap, docs/baton/HOT_ACCOUNT_SWAP.md). Claude Code fixes CLAUDE_CODE_OAUTH_TOKEN at spawn but
 * re-reads $CLAUDE_CONFIG_DIR/.credentials.json when its mtime changes, on the next request of the main agent or any
 * sub-agent. The dir links every entry of the instance's home except that file, which holds the token.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - links and an atomic rename, as ClaudeAccountHome.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - paths for the calls above.
import * as NodePath from "node:path";

import type { ProviderAdapterV2AccountLogin } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class ClaudeSessionLoginError extends Schema.TaggedError<ClaudeSessionLoginError>()(
  "ClaudeSessionLoginError",
  { dir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Claude's session login dir ${this.dir} could not be prepared.`;
  }
}

const CREDENTIALS = ".credentials.json";
// Read by T3 from the instance's home, so they must be links to it, never the CLI's own copies here.
const READ_BY_T3 = ["projects", "tasks"];

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;

const readJsonObject = async (file: string): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** Links every entry of `home` into `dir` that `dir` lacks. Idempotent; runs before each spawn. */
const seed = async (home: string, dir: string): Promise<void> => {
  await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of READ_BY_T3)
    await NodeFSP.mkdir(NodePath.join(home, name), { recursive: true });
  for (const name of await NodeFSP.readdir(home)) {
    if (name === CREDENTIALS) continue;
    try {
      await NodeFSP.symlink(NodePath.join(home, name), NodePath.join(dir, name));
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
    }
  }
};

/** The home's other entries (MCP OAuth) stay; only the Claude login is this account's. */
const writeLogin = async (
  home: string,
  dir: string,
  token: string,
  tmpName: string,
): Promise<void> => {
  const target = NodePath.join(dir, CREDENTIALS);
  const current = await readJsonObject(target);
  const base =
    Object.keys(current).length > 0
      ? current
      : await readJsonObject(NodePath.join(home, CREDENTIALS));
  const next = {
    ...base,
    // The shape Claude Code gives CLAUDE_CODE_OAUTH_TOKEN: inference only, never refreshed.
    claudeAiOauth: {
      accessToken: token,
      refreshToken: null,
      expiresAt: null,
      scopes: ["user:inference"],
      subscriptionType: null,
    },
  };
  const tmp = NodePath.join(dir, tmpName);
  await NodeFSP.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
  await NodeFSP.rename(tmp, target);
};

export interface ClaudeSessionLogin {
  readonly dir: string;
  /** The spawn env: this dir as the config dir and no token variable, with the current login written. */
  readonly prepare: (
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<NodeJS.ProcessEnv, ClaudeSessionLoginError>;
  /** Puts another account's login under the running process; its next request uses it. */
  readonly switchTo: (login: ProviderAdapterV2AccountLogin) => Effect.Effect<boolean>;
  /** Where its rate-limit reports go: the account it runs as now. */
  readonly onUsageLimits: () => ProviderAdapterV2AccountLogin["onUsageLimits"] | undefined;
}

/** Null when the instance has no token to move (a file login refreshes in place and cannot be copied) or no root. */
export const makeClaudeSessionLogin = (input: {
  readonly root: string | undefined;
  readonly providerSessionId: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly onUsageLimits: ProviderAdapterV2AccountLogin["onUsageLimits"] | undefined;
}): ClaudeSessionLogin | null => {
  const token = input.environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (input.root === undefined || token === undefined || token.length === 0) return null;
  const home = NodePath.resolve(
    input.environment.CLAUDE_CONFIG_DIR ?? NodePath.join(input.homeDirectory, ".claude"),
  );
  const dir = NodePath.join(input.root, input.providerSessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
  let current = token;
  let writes = 0;
  const write = (secret: string) =>
    writeLogin(home, dir, secret, `.credentials.${process.pid}.${(writes += 1)}.tmp`);
  let currentUsageLimits = input.onUsageLimits;
  let seeded = false;
  return {
    dir,
    prepare: (environment) =>
      Effect.tryPromise({
        try: async () => {
          await seed(home, dir);
          await write(current);
          seeded = true;
          const next: NodeJS.ProcessEnv = { ...environment, CLAUDE_CONFIG_DIR: dir };
          delete next.CLAUDE_CODE_OAUTH_TOKEN;
          return next;
        },
        catch: (cause) => new ClaudeSessionLoginError({ dir, cause }),
      }),
    switchTo: (login) =>
      Effect.tryPromise({
        try: async () => {
          const secret = Redacted.value(login.secret);
          if (seeded) await write(secret);
          current = secret;
          currentUsageLimits = login.onUsageLimits;
          return true;
        },
        catch: (cause) => new ClaudeSessionLoginError({ dir, cause }),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Claude's session login could not be switched", { dir, cause }).pipe(
            Effect.as(false),
          ),
        ),
      ),
    onUsageLimits: () => currentUsageLimits,
  };
};

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Removes session dirs unused for a week. Never at session close: a dying process still writes, and with its links
 * gone it would write transcripts into a dir nobody reads. Only links and the login go; anything else keeps the dir.
 */
export const pruneClaudeSessionLogins = (root: string) =>
  Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
    Effect.flatMap((now) =>
      Effect.tryPromise({
        try: async () => {
          for (const name of await NodeFSP.readdir(root).catch(() => [])) {
            const dir = NodePath.join(root, name);
            const login = await NodeFSP.stat(NodePath.join(dir, CREDENTIALS)).catch(
              () => undefined,
            );
            if (login === undefined || now - login.mtimeMs < STALE_MS) continue;
            for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
              if (entry.isSymbolicLink() || entry.name.startsWith(".credentials."))
                await NodeFSP.unlink(NodePath.join(dir, entry.name));
            }
            await NodeFSP.rmdir(dir).catch(() => undefined);
          }
        },
        catch: (cause) => new ClaudeSessionLoginError({ dir: root, cause }),
      }),
    ),
    Effect.ignore({ log: true }),
  );
