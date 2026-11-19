/**
 * One device across his machines (M-097): a phone paired once holds a session on each of his servers, all labelled with
 * one household device id. Signing it out on any one (Authorized clients, or the phone itself) signs it out on every
 * one: the server tells her brain, and the brain tells each linked machine. A reverse for one pairing.
 */
import {
  householdDeviceOf,
  HOUSEHOLD_DEVICE,
  HOUSEHOLD_DEVICE_REVOKE_TOOL,
} from "@t3tools/tessaya-contracts";
import type { AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { brainOn, makeBrainLink } from "./BrainHost.ts";
import { emitAction } from "./turnActions.ts";

/** Devices already being signed out here: their own removals don't start another round (no echo between machines). */
const signingOut = new Set<string>();

/** Signs the device out on this machine; how many of its sessions were open here. */
export const revokeHere = Effect.fn("HouseholdDevices.revokeHere")(function* (device: string) {
  if (!HOUSEHOLD_DEVICE.test(device)) return 0;
  signingOut.add(device);
  const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
  if (Option.isNone(auth)) return 0;
  const sessions = yield* auth.value.listSessions().pipe(Effect.orElseSucceed(() => []));
  let revoked = 0;
  for (const s of sessions)
    if (householdDeviceOf(s.client.label) === device)
      if (yield* auth.value.revokeSession(s.sessionId).pipe(Effect.orElseSucceed(() => false)))
        revoked++;
  return revoked;
});

/** Her brain's round: here, then every machine linked to it (any link but a read-only one may narrow access). */
export const revokeEverywhereFromBrain = Effect.fn("HouseholdDevices.revokeEverywhereFromBrain")(
  function* (device: string) {
    const here = yield* revokeHere(device);
    const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
    const mcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
    if (Option.isNone(links) || Option.isNone(mcp)) return here;
    const listed = yield* links.value.list.pipe(Effect.orElseSucceed(() => []));
    const counts = yield* Effect.forEach(
      listed.filter((l) => l.status !== "expired"),
      (l) =>
        mcp.value
          .call({
            environmentId: l.environmentId,
            tool: HOUSEHOLD_DEVICE_REVOKE_TOOL,
            arguments: { device },
            limits: { runtimeMode: "approval-required", interactionMode: "default" },
            success: Schema.Struct({ revoked: Schema.Number }),
          })
          .pipe(
            Effect.timeout("15 seconds"),
            Effect.map((r) => r.revoked),
            Effect.catchCause((cause) =>
              Effect.logWarning("household device: not signed out there", {
                machine: l.label,
                why: String(cause),
              }).pipe(Effect.as(0)),
            ),
          ),
      { concurrency: "unbounded" },
    );
    return here + counts.reduce((a, b) => a + b, 0);
  },
);

/**
 * A household device was signed out here (not expired): every other machine of his follows, through the brain. Queued
 * when the brain is away, so a sign-out is never lost.
 */
const signOutEverywhere = Effect.fn("HouseholdDevices.signOutEverywhere")(function* (
  device: string,
) {
  yield* emitAction({
    kind: "household.device.revoked",
    actor: { kind: "owner", certainty: 1 },
    subject: device,
    outcome: "everywhere",
  });
  if ((yield* brainOn) === null) {
    yield* revokeEverywhereFromBrain(device);
    return;
  }
  const brain = yield* makeBrainLink;
  yield* brain.sendOrQueue("deviceRevoke", { device });
});

/** The session making this request (set by the Tessaya RPC gate), for "sign this phone out". */
export const CallerSessionId = Context.Reference<string | null>(
  "t3/tessaya/HouseholdDevices/CallerSessionId",
  { defaultValue: () => null },
);

/**
 * "Sign this phone out of the household": every machine signs it out (the brain's round), then this one, last, since
 * revoking here ends the caller's own connection. A phone paired before households is signed out here only.
 */
export const signOutCaller = Effect.fn("HouseholdDevices.signOutCaller")(function* () {
  const sessionId = yield* CallerSessionId;
  const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
  if (sessionId === null || Option.isNone(auth)) return { everywhere: false };
  const sessions = yield* auth.value.listSessions().pipe(Effect.orElseSucceed(() => []));
  const device = householdDeviceOf(sessions.find((s) => s.sessionId === sessionId)?.client.label);
  if (device === null) {
    yield* auth.value
      .revokeSession(sessionId as AuthSessionId)
      .pipe(Effect.ignoreCause({ log: true }), Effect.delay("1 second"), Effect.forkDetach);
    return { everywhere: false };
  }
  signingOut.add(device);
  yield* signOutEverywhere(device);
  yield* revokeHere(device).pipe(Effect.delay("1 second"), Effect.forkDetach);
  return { everywhere: true };
});

/** Watches this machine's sessions: a household device revoked here is revoked on all his machines. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(SessionStore);
    const repo = yield* Effect.serviceOption(AuthSessionRepository);
    if (Option.isNone(store) || Option.isNone(repo)) return;
    const deviceOf = new Map<string, string>();
    for (const s of yield* store.value.listActive().pipe(Effect.orElseSucceed(() => []))) {
      const device = householdDeviceOf(s.client.label);
      if (device !== null) deviceOf.set(s.sessionId, device);
    }
    yield* store.value.streamChanges.pipe(
      Stream.runForEach((change) =>
        Effect.gen(function* () {
          if (change.type === "clientUpserted") {
            const device = householdDeviceOf(change.clientSession.client.label);
            if (device !== null) deviceOf.set(change.clientSession.sessionId, device);
            return;
          }
          const device = deviceOf.get(change.sessionId);
          deviceOf.delete(change.sessionId);
          if (device === undefined || signingOut.has(device)) return;
          // An expired session also leaves; only a revoke is someone signing the device out.
          const row = yield* repo.value
            .getById({ sessionId: change.sessionId })
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(row) || row.value.revokedAt === null) return;
          signingOut.add(device);
          yield* signOutEverywhere(device);
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }),
);
