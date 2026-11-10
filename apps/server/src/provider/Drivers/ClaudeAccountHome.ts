/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * One Claude account's config directory: its credentials, everybody's
 * everything else.
 *
 * The Director's requirement, in his words: _"any new profile I add picks up
 * the same config"_. A second Claude login should not mean a second copy of the
 * skills, the agents, the commands, the plugins, the memory tree or
 * `CLAUDE.md` — those are his, not the account's. Only the credentials and the
 * per-account state belong to the account.
 *
 * **This is upstream's own mechanism, applied to the other provider.**
 * `CodexHomeLayout.ts` already does exactly this for Codex — `auth.json` stays
 * private, every other entry in the shared home is symlinked into the shadow
 * home, and the layout is re-materialised on every session start. Claude had no
 * equivalent: `ClaudeHome.ts` sets `CLAUDE_CONFIG_DIR` and nothing else, so a
 * second account got an empty directory and none of the user's configuration.
 *
 * Re-materialising on every start is also the answer to the question the
 * Director raised and the one that actually decides whether this works: *do
 * symlinks survive the CLI's writes?* Rather than assume, the layout is
 * re-established before each session, a private entry that has become a symlink
 * is a named error, and a shared entry that has become a real file is a named
 * error too — the two ways this silently forks are both refusals instead.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { type ClaudeSettings } from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { expandHomePath as expandHomePathFrom } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const expandHomePath = (value: string): string => expandHomePathFrom(value, NodeOS.homedir());

/**
 * What belongs to the account and must never be shared.
 *
 * `.credentials.json` is the login itself. `.claude.json` carries the account's
 * own project trust, its onboarding state and its history pointers — sharing it
 * is how two accounts end up fighting over one file, which is the bug
 * `.claude.json.lock` exists because of.
 */
export const CLAUDE_PRIVATE_ENTRIES: ReadonlySet<string> = new Set([
  ".credentials.json",
  ".claude.json",
  ".claude.json.lock",
]);

/**
 * The entries that make a second account feel like the first — and only these.
 *
 * Exactly the Director's list: _"settings.json, skills/, agents/, plugins/,
 * hooks, CLAUDE.md and the projects/ memory tree are the PRIMARY's, shared"_.
 * `settings.json` carries the `hooks` key, so sharing it shares the hooks,
 * which is why hooks are not listed separately.
 *
 * Deliberately **not** "everything the shared home happens to contain". The
 * first real run of this linked thirty-odd entries, among them `history.jsonl`,
 * `stats-cache.json`, `telemetry/` and three stale `settings.json` backups —
 * two accounts writing one cache is a contention bug waiting to be blamed on
 * something else, and none of it is what "the same config" means. Anything not
 * on this list is the account's own, and the CLI creates what it needs.
 *
 * Created in the shared home when missing, so a fresh machine still produces a
 * complete layout rather than a set of broken links.
 */
export const CLAUDE_SHARED_ENTRIES = [
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "skills",
  "agents",
  "commands",
  "plugins",
  "projects",
] as const;

export interface ClaudeAccountHomeLayout {
  readonly mode: "direct" | "accountOverlay";
  /** The primary config directory every account shares. */
  readonly sharedHomePath: string;
  /** This account's own directory, or undefined when there is no second account. */
  readonly accountHomePath: string | undefined;
}

const CONTEXT = {
  sharedHomePath: Schema.String,
  accountHomePath: Schema.String,
};

export class ClaudeAccountHomeFileSystemError extends Schema.TaggedError<ClaudeAccountHomeFileSystemError>()(
  "ClaudeAccountHomeFileSystemError",
  {
    ...CONTEXT,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "rename",
      "symlink",
    ]),
    path: Schema.String,
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Claude account home operation '${this.operation}' failed for '${this.path}'.`;
  }
}

export class ClaudeAccountHomePathConflictError extends Schema.TaggedError<ClaudeAccountHomePathConflictError>()(
  "ClaudeAccountHomePathConflictError",
  CONTEXT,
) {
  override get message(): string {
    return `A Claude account home must be a different directory from the shared one ('${this.sharedHomePath}').`;
  }
}

export class ClaudeAccountHomeEntryConflictError extends Schema.TaggedError<ClaudeAccountHomeEntryConflictError>()(
  "ClaudeAccountHomeEntryConflictError",
  { ...CONTEXT, entryName: Schema.String, path: Schema.String },
) {
  override get message(): string {
    return `'${this.path}' should be a link to the shared configuration and is a real file. Two accounts have forked apart here; move it aside and start this account again.`;
  }
}

export class ClaudeAccountHomePrivateEntryError extends Schema.TaggedError<ClaudeAccountHomePrivateEntryError>()(
  "ClaudeAccountHomePrivateEntryError",
  { ...CONTEXT, entryName: Schema.String, path: Schema.String },
) {
  override get message(): string {
    return `'${this.path}' holds this account's own credentials and must not be a link to another account's.`;
  }
}

export const ClaudeAccountHomeError = Schema.Union([
  ClaudeAccountHomeFileSystemError,
  ClaudeAccountHomePathConflictError,
  ClaudeAccountHomeEntryConflictError,
  ClaudeAccountHomePrivateEntryError,
]);
export type ClaudeAccountHomeError = typeof ClaudeAccountHomeError.Type;

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

const isNotSymlinkError = (error: PlatformError.PlatformError): boolean => {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
};

/**
 * Where this account's directory is, and which shared one it belongs to.
 *
 * `homePath` empty means the primary account: nothing to materialise, and the
 * CLI uses its own default. That is the common case and must stay free.
 */
export const resolveClaudeAccountHomeLayout = Effect.fn("resolveClaudeAccountHomeLayout")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    sharedHomePathOverride?: string,
  ): Effect.fn.Return<ClaudeAccountHomeLayout, never, Path.Path> {
    const path = yield* Path.Path;
    const sharedHomePath = path.resolve(
      sharedHomePathOverride !== undefined && sharedHomePathOverride.trim().length > 0
        ? expandHomePath(sharedHomePathOverride)
        : path.join(NodeOS.homedir(), ".claude"),
    );
    const homePath = config.homePath.trim();
    // A relative home would be materialised under the server's cwd (a test fixture did exactly
    // that, linking the real ~/.claude into the repository); only an absolute or ~ path is an account.
    if (homePath.length === 0 || !path.isAbsolute(expandHomePath(homePath))) {
      return { mode: "direct", sharedHomePath, accountHomePath: undefined };
    }
    const accountHomePath = path.resolve(expandHomePath(homePath));
    return {
      mode: accountHomePath === sharedHomePath ? "direct" : "accountOverlay",
      sharedHomePath,
      accountHomePath: accountHomePath === sharedHomePath ? undefined : accountHomePath,
    };
  },
);

/**
 * Make the layout true on disk, and say so by name when it cannot be.
 *
 * Idempotent: it runs before every session, repairs a link that points
 * somewhere stale, and does nothing at all for the primary account.
 */
export const materializeClaudeAccountHome = Effect.fn("materializeClaudeAccountHome")(function* (
  layout: ClaudeAccountHomeLayout,
  options?: {
    /**
     * Replace a real file or directory where a link belongs, keeping the
     * original beside it as `<name>.account-local-<timestamp>`.
     *
     * Off by default and on only when a person asked for it: the usual caller
     * is a session starting, and a session starting must never move somebody's
     * data. It exists because another tool (claude-swap) creates `plugins/` per
     * account, and sharing it is exactly what was asked for. (`projects/` always joins the shared store.)
     */
    readonly adoptExisting?: boolean | undefined;
  },
): Effect.fn.Return<void, ClaudeAccountHomeError, FileSystem.FileSystem | Path.Path> {
  if (layout.mode !== "accountOverlay") return;
  const accountHomePath = layout.accountHomePath;
  if (accountHomePath === undefined) return;
  if (accountHomePath === layout.sharedHomePath) {
    return yield* new ClaudeAccountHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      accountHomePath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = { sharedHomePath: layout.sharedHomePath, accountHomePath };

  const fail =
    (
      operation: ClaudeAccountHomeFileSystemError["operation"],
      target: string,
      entryName?: string,
    ) =>
    (cause: unknown) =>
      new ClaudeAccountHomeFileSystemError({
        ...context,
        operation,
        path: target,
        ...(entryName === undefined ? {} : { entryName }),
        cause,
      });

  const makeDirectory = (directoryPath: string) =>
    fileSystem
      .makeDirectory(directoryPath, { recursive: true })
      .pipe(
        Effect.catchTags({ PlatformError: (cause) => fail("makeDirectory", directoryPath)(cause) }),
      );

  yield* makeDirectory(layout.sharedHomePath);
  yield* makeDirectory(accountHomePath);

  const readLinkState = (linkPath: string, entryName: string) =>
    fileSystem.readLink(linkPath).pipe(
      Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag === "NotFound")
            return Effect.succeed<LinkState>({ _tag: "Missing" });
          if (isNotSymlinkError(cause)) return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
          return fail("readLink", linkPath, entryName)(cause);
        },
      }),
    );

  const isWindows = yield* HostProcess.isWindows;

  // Moves what `from` holds and `to` lacks into `to`; a name both hold stays in `from`.
  const mergeInto: (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError> =
    Effect.fn("ClaudeAccountHome.mergeInto")(function* (from: string, to: string) {
      yield* fileSystem.makeDirectory(to, { recursive: true });
      for (const name of yield* fileSystem.readDirectory(from)) {
        const source = path.join(from, name);
        const destination = path.join(to, name);
        if (!(yield* fileSystem.exists(destination))) {
          yield* fileSystem.rename(source, destination);
        } else if (
          (yield* fileSystem.stat(source)).type === "Directory" &&
          (yield* fileSystem.stat(destination)).type === "Directory"
        ) {
          yield* mergeInto(source, destination);
        }
      }
    });

  const linkEntry = Effect.fn("ClaudeAccountHome.linkEntry")(function* (
    entryName: (typeof CLAUDE_SHARED_ENTRIES)[number],
  ) {
    const target = path.join(layout.sharedHomePath, entryName);
    const link = path.join(accountHomePath, entryName);
    const state = yield* readLinkState(link, entryName);

    if (state._tag === "NotSymlink") {
      // projects/ holds the conversations, and one left here strands them on this account: every account must
      // resume every thread. They join the shared store; a name both hold stays in the kept copy.
      if (entryName === "projects") {
        yield* mergeInto(link, target).pipe(
          Effect.catchTags({
            PlatformError: (cause) => fail("rename", link, entryName)(cause),
          }),
        );
      }
      // The one case this must never do quietly: replace a real file the
      // account has been writing to. Two configurations have forked, and
      // only a person can say which one is the one they meant — unless they
      // already did, by asking for this.
      else if (options?.adoptExisting !== true) {
        return yield* new ClaudeAccountHomeEntryConflictError({
          ...context,
          entryName,
          path: link,
        });
      }
      const stamp = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)).toString();
      const kept = `${link}.account-local-${stamp}`;
      yield* fileSystem.rename(link, kept).pipe(
        Effect.catchTags({
          PlatformError: (cause) => fail("remove", link, entryName)(cause),
        }),
      );
      yield* Effect.logInfo("Kept this account's own copy beside the shared one", {
        entryName,
        kept,
      });
    }
    if (state._tag === "Symlink") {
      const resolved = path.resolve(path.dirname(link), state.target);
      if (resolved === target) return;
      yield* fileSystem.remove(link).pipe(
        Effect.catchTags({
          PlatformError: (cause) => fail("remove", link, entryName)(cause),
        }),
      );
    }

    // A link to something that does not exist yet is not useful: a shared
    // entry the primary has never created (no `skills/` on a fresh machine)
    // becomes a real directory there first, so both accounts write into one
    // place from the beginning.
    const exists = yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      if (entryName.includes(".")) return;
      yield* makeDirectory(target);
    }

    const isDirectory =
      (yield* fileSystem.stat(target).pipe(Effect.orElseSucceed(() => undefined)))?.type ===
      "Directory";
    yield* Effect.tryPromise({
      try: () =>
        NodeFSP.symlink(target, link, isDirectory ? (isWindows ? "junction" : "dir") : "file"),
      catch: fail("symlink", link, entryName),
    });
  });

  // One entry that cannot link (a file link on Windows needs elevation) must not keep the others, projects/ above
  // all, from linking; the first failure is still reported.
  const failures = (yield* Effect.forEach(CLAUDE_SHARED_ENTRIES, (entryName) =>
    Effect.result(linkEntry(entryName)),
  )).flatMap((result) => (result._tag === "Failure" ? [result.failure] : []));

  // The account's own things must be the account's own. A credentials file that
  // is a link to another account's is the failure this whole layout exists to
  // prevent, so it is checked rather than assumed.
  yield* Effect.forEach(
    [...CLAUDE_PRIVATE_ENTRIES],
    (entryName) =>
      Effect.gen(function* () {
        const privatePath = path.join(accountHomePath, entryName);
        const state = yield* readLinkState(privatePath, entryName);
        if (state._tag !== "Symlink") return;
        return yield* new ClaudeAccountHomePrivateEntryError({
          ...context,
          entryName,
          path: privatePath,
        });
      }),
    { discard: true },
  );
  if (failures[0] !== undefined) return yield* failures[0];
});

/**
 * The one call upstream's Claude adapter makes (0004-claude-account-home.patch): resolve this
 * instance's layout and materialise it. Never fails the adapter: a home that cannot be linked
 * still runs, with the account's own files, and the reason is logged.
 */
export const materializeForConfig = (config: Pick<ClaudeSettings, "homePath">) =>
  resolveClaudeAccountHomeLayout(config).pipe(
    Effect.flatMap((layout) => materializeClaudeAccountHome(layout)),
    Effect.ignoreCause({ log: true }),
  );
