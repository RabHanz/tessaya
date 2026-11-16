/**
 * Every client call that changes something is an action (B-046): the RPC instrumentation records it with the session
 * behind it. Reads and subscriptions are not actions. A method missing from both scope maps counts as a change, so a
 * new one is never silently left out.
 */
import { BATON_METHOD_OF } from "@t3tools/tessaya-contracts";
import { memberOfSubject } from "@t3tools/tessaya-shared/household";
import * as Layer from "effect/Layer";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import { instrumentRpc, RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { BATON_RPC_REQUIRED_SCOPES } from "../tessaya/TessayaRpcAuthorization.ts";
import { traced } from "./ActionLog.ts";

const scopesOf = (method: string): ReadonlyArray<string> | undefined => {
  const tag = BATON_METHOD_OF.get(method) ?? method;
  const upstream = RPC_REQUIRED_SCOPES as Readonly<Record<string, string>>;
  const tessaya = BATON_RPC_REQUIRED_SCOPES as Readonly<
    Record<string, string | ReadonlyArray<string>>
  >;
  const scopes = Object.hasOwn(upstream, tag)
    ? upstream[tag]
    : Object.hasOwn(tessaya, tag)
      ? tessaya[tag]
      : undefined;
  if (scopes === undefined) return undefined;
  return typeof scopes === "string" ? [scopes] : scopes;
};

/** True when calling `method` can change state: any scope it needs is more than a read. */
export const rpcChangesState = (method: string): boolean => {
  if (method.startsWith("subscribe") || method.includes(".subscribe")) return false;
  // One method, many ops (home, devices, voice, household): some ops act, so the call counts.
  if (method.endsWith(".call")) return true;
  const scopes = scopesOf(method);
  return scopes === undefined || scopes.some((scope) => !scope.endsWith(":read"));
};

export const rpcActionLayer = (session: Pick<AuthenticatedSession, "subject" | "sessionId">) => {
  const member = memberOfSubject(session.subject);
  return Layer.succeed(RpcInstrumentation)((effect, { rpc }) => {
    const measured = instrumentRpc(effect, rpc._tag);
    return rpcChangesState(rpc._tag)
      ? traced({
          kind: "rpc.call",
          // A paired session is a device he signed in, not proof it is him at it right now.
          actor: {
            kind: member === null ? "owner" : "member",
            id: member ?? "owner",
            certainty: 0.8,
          },
          subject: rpc._tag,
          evidence: [{ kind: "session", ref: String(session.sessionId) }],
        })(measured)
      : measured;
  });
};
