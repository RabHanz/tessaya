/**
 * Add a phone (16 Nov): this machine's own one-time code, and one from each machine linked to it over a full-access
 * peer link, so one QR pairs the phone with all of them. Each code is the same short-lived pairing link `t3 pair`
 * mints, listed (and revocable) under that machine's Authorized clients.
 */
import { AuthStandardClientScopes, type PeerLinkSummary } from "@t3tools/contracts";
import {
  PHONE_PAIRING_TOOL,
  PHONE_PAIRING_TTL_MINUTES,
  PhonePairingError,
  type PhonePairingResult,
} from "@t3tools/tessaya-contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

export const PhonePairingCode = Schema.Struct({
  credential: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
});

const PEER_WAIT = Duration.seconds(15);

/** This machine's own code for a phone: the standard client scopes, one use, ten minutes. */
export const codeHere = Effect.fn("PhonePairing.codeHere")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
) {
  const issued = yield* auth
    .createPairingLink({
      ttl: Duration.minutes(PHONE_PAIRING_TTL_MINUTES),
      label: "Phone",
      scopes: AuthStandardClientScopes,
    })
    .pipe(Effect.mapError((error) => new PhonePairingError({ reason: error.message })));
  return {
    id: issued.id,
    credential: issued.credential,
    ...(issued.label === undefined ? {} : { label: issued.label }),
    expiresAt: issued.expiresAt,
  };
});

/** Only another of his machines over a full-access link may ask: that link already reaches a shell here. */
export const mayAskHere = (client: McpInvocationContext.McpClientCaller | undefined): boolean =>
  client?.linked === true &&
  McpInvocationContext.clientModeCeiling(client).runtimeMode === "full-access";

/** Why a linked machine cannot be in the phone's code, or null when it is asked. */
export const skipReason = (link: PeerLinkSummary): string | null =>
  link.status === "expired"
    ? "Its link has expired; link it again."
    : link.access !== "full-access"
      ? "It is linked with less than full access, so it will not hand out a pairing code."
      : null;

/** One linked machine's code, on the address this machine reaches it at. */
const codeThere = Effect.fn("PhonePairing.codeThere")(
  function* (
    links: PeerLinks.PeerLinks["Service"],
    mcp: PeerMcpClient.PeerMcpClient["Service"],
    link: PeerLinkSummary,
  ) {
    const { url } = yield* links.resolve(link.environmentId);
    if (isLocalLoopbackHost(new URL(url).hostname))
      return yield* new PhonePairingError({
        reason: "It is reached only through this machine, so the phone cannot reach it.",
      });
    const code = yield* mcp.call({
      environmentId: link.environmentId,
      tool: PHONE_PAIRING_TOOL,
      arguments: {},
      limits: { runtimeMode: "full-access", interactionMode: "default" },
      success: PhonePairingCode,
    });
    return {
      environmentId: link.environmentId,
      label: link.label,
      pairingUrl: setPairingTokenOnUrl(new URL("/pair", url), code.credential).toString(),
      expiresAt: code.expiresAt,
    };
  },
  Effect.timeoutOrElse({
    duration: PEER_WAIT,
    orElse: () => Effect.fail(new PhonePairingError({ reason: "It did not answer." })),
  }),
  Effect.result,
);

/** Codes for a phone: here, and from every linked machine that can give one; the rest say why not. */
export const issue = Effect.fn("PhonePairing.issue")(function* () {
  const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
  if (auth._tag === "None")
    return yield* new PhonePairingError({ reason: "Pairing is not available on this server." });
  const here = yield* codeHere(auth.value);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const mcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  const listed =
    links._tag === "None" || mcp._tag === "None" || !(yield* links.value.enabled)
      ? []
      : yield* links.value.list.pipe(Effect.orElseSucceed(() => []));
  const linked: Array<PhonePairingResult["linked"][number]> = [];
  const missed: Array<PhonePairingResult["missed"][number]> = [];
  const asked = listed.filter((link) => {
    const reason = skipReason(link);
    if (reason !== null) missed.push({ label: link.label, reason });
    return reason === null;
  });
  if (links._tag === "Some" && mcp._tag === "Some") {
    const answers = yield* Effect.forEach(
      asked,
      (link) => codeThere(links.value, mcp.value, link),
      { concurrency: "unbounded" },
    );
    answers.forEach((answer, index) => {
      if (answer._tag === "Success") linked.push(answer.success);
      else missed.push({ label: asked[index]!.label, reason: answer.failure.message });
    });
  }
  return { here, linked, missed } satisfies PhonePairingResult;
});
