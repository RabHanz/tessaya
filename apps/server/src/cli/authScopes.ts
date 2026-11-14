import {
  AuthTessayaMemorySyncScope,
  type AuthGrantScope,
  AuthGrantScopeNames,
  mixesMemorySync,
} from "@t3tools/contracts";
import { Flag } from "effect/cli";

export const authScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  Flag.Literals("scope", AuthGrantScopeNames).pipe(
    Flag.withDescription(
      `Authorization scope to grant. Repeat for multiple scopes; replaces the default set: ${defaults.join(", ")}.`,
    ),
    Flag.atLeast(0),
    Flag.map((scopes) => [...new Set(scopes.length > 0 ? scopes : defaults)]),
    Flag.filter(
      (scopes) => !mixesMemorySync(scopes),
      () => `${AuthTessayaMemorySyncScope} is a sync-only credential: give it alone.`,
    ),
  );
