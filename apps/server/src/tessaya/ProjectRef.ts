/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
/**
 * The project a directory belongs to, the same answer on every box (D72).
 *
 * Reuses T3's own `RepositoryIdentityResolver` (git remote → canonical key),
 * so a checkout on one machine and one on another are the same project
 * even when their paths differ. A directory with no remote falls back to its
 * folder name, which is weaker and is marked `dir:` so it never collides with
 * a repository key.
 */
import type { TessayaProjectRef } from "@t3tools/tessaya-contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";

export const folderProjectRef = (cwd: string): TessayaProjectRef => {
  const leaf =
    cwd
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .pop() ?? cwd;
  return { key: `dir:${leaf.toLowerCase()}`, label: leaf };
};

export const projectRefFor = (cwd: string): Effect.Effect<TessayaProjectRef> =>
  Effect.gen(function* () {
    const resolver = yield* Effect.serviceOption(RepositoryIdentityResolver);
    if (resolver._tag === "None") return folderProjectRef(cwd);
    const identity = yield* resolver.value
      .resolve(cwd)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (identity === null) return folderProjectRef(cwd);
    // The checkout's own folder name keeps its capitals ("Storefront", not "storefront").
    const folder = folderProjectRef(cwd).label;
    const name = identity.name ?? identity.displayName ?? folder;
    return {
      key: identity.canonicalKey,
      label: name.toLowerCase() === folder.toLowerCase() ? folder : name,
    };
  });

/** For reads that must answer promptly (the fleet): past `budget` the folder's own name stands in. */
export const projectRefWithin = (
  cwd: string,
  budget: Duration.Input,
): Effect.Effect<TessayaProjectRef> =>
  Effect.gen(function* () {
    // Detached so only the wait times out: the lookup finishes and fills the resolver's cache for the next read.
    const lookup = yield* Effect.forkDetach(projectRefFor(cwd));
    const found = yield* Fiber.join(lookup).pipe(Effect.timeoutOption(budget));
    return Option.getOrElse(found, () => folderProjectRef(cwd));
  });
