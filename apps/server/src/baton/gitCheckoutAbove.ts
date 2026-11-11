import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * False only when no folder from `cwd` up holds a `.git` entry and git is not pointed elsewhere, so `git rev-parse`
 * could only answer "not a repository". Spawning git costs seconds on a busy Windows machine; a few stats do not.
 * Any doubt (an unreadable folder, a symlink that does not resolve) answers true and lets git decide.
 */
export const mayBeInGitCheckout = Effect.fn("mayBeInGitCheckout")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env["GIT_DIR"] !== undefined || env["GIT_WORK_TREE"] !== undefined) return true;
  // git walks the physical path, so a symlinked folder inside a checkout still finds its .git.
  let dir = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => null));
  if (dir === null) return true;
  while (true) {
    const found = yield* fileSystem
      .exists(path.join(dir, ".git"))
      .pipe(Effect.orElseSucceed(() => true));
    if (found) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
});
