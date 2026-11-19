/**
 * Add a phone: one QR pairs it with this machine and all of his others. Off her brain, the brain gives its own code and
 * its machines' (M-097). Each is a one-time standard code `t3 pair` would mint, labelled with one household device id
 * so a sign-out anywhere is a sign-out everywhere (HouseholdDevices).
 */
import { AuthStandardClientScopes, type PeerLinkSummary } from "@t3tools/contracts";
import {
  householdDeviceLabel,
  HOUSEHOLD_DEVICE,
  PHONE_PAIRING_TOOL,
  PHONE_PAIRING_TTL_MINUTES,
  PhonePairingError,
  type PhonePairingResult,
} from "@t3tools/tessaya-contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { brainOn, makeBrainLink } from "./BrainHost.ts";

export const PhonePairingCode = Schema.Struct({
  credential: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
});

const PEER_WAIT = Duration.seconds(15);

/** This machine's own code for a phone: the standard client scopes, one use, ten minutes. */
export const codeHere = Effect.fn("PhonePairing.codeHere")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  device?: string,
) {
  const issued = yield* auth
    .createPairingLink({
      ttl: Duration.minutes(PHONE_PAIRING_TTL_MINUTES),
      label:
        device !== undefined && HOUSEHOLD_DEVICE.test(device)
          ? householdDeviceLabel(device)
          : "Phone",
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
    device: string,
  ) {
    const { url } = yield* links.resolve(link.environmentId);
    if (isLocalLoopbackHost(new URL(url).hostname))
      return yield* new PhonePairingError({
        reason: "It is reached only through this machine, so the phone cannot reach it.",
      });
    const code = yield* mcp.call({
      environmentId: link.environmentId,
      tool: PHONE_PAIRING_TOOL,
      arguments: { device },
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

/** A new household device id: not a secret (it is a label), only unique. */
const newDevice = Effect.map(
  Effect.all([Random.nextIntBetween(0, 2 ** 30), Random.nextIntBetween(0, 2 ** 30)]),
  ([a, b]) => `hd-${a.toString(36).padStart(6, "0")}${b.toString(36).padStart(6, "0")}`,
);

const ownEnvironment = Effect.gen(function* () {
  const env = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  return Option.isNone(env) ? null : yield* env.value.getEnvironmentId;
});

/** One machine's code as it travels from her brain to the machine the phone is pairing on. */
const FromBrain = Schema.Struct({
  environmentId: Schema.String,
  credential: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  linked: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      label: Schema.String,
      pairingUrl: Schema.String,
      expiresAt: Schema.DateTimeUtcFromString,
    }),
  ),
  missed: Schema.Array(Schema.Struct({ label: Schema.String, reason: Schema.String })),
});
const decodeFromBrain = Schema.decodeUnknownOption(FromBrain);
const encodeFromBrain = Schema.encodeSync(FromBrain);

/**
 * Her brain's end (BrainReceive `phoneCodes`): its own code and its machines', for the device, leaving out the machines
 * the phone is already getting a code from.
 */
export const codesAtBrain = Effect.fn("PhonePairing.codesAtBrain")(function* (
  device: string,
  skip: ReadonlyArray<string>,
) {
  const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
  if (auth._tag === "None" || !HOUSEHOLD_DEVICE.test(device)) return null;
  const code = yield* codeHere(auth.value, device);
  const { linked, missed } = yield* fanOut(device, new Set(skip));
  return encodeFromBrain({
    environmentId: String(yield* ownEnvironment),
    credential: code.credential,
    expiresAt: code.expiresAt,
    linked,
    missed,
  });
});

/** Codes from this machine's own links, but for the machines in `skip`. */
const fanOut = Effect.fn("PhonePairing.fanOut")(function* (
  device: string,
  skip: ReadonlySet<string>,
) {
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const mcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  const listed =
    links._tag === "None" || mcp._tag === "None" || !(yield* links.value.enabled)
      ? []
      : yield* links.value.list.pipe(Effect.orElseSucceed(() => []));
  const linked: Array<PhonePairingResult["linked"][number]> = [];
  const missed: Array<PhonePairingResult["missed"][number]> = [];
  const asked = listed.filter((link) => {
    if (skip.has(link.environmentId)) return false;
    const reason = skipReason(link);
    if (reason !== null) missed.push({ label: link.label, reason });
    return reason === null;
  });
  if (links._tag === "Some" && mcp._tag === "Some") {
    const answers = yield* Effect.forEach(
      asked,
      (link) => codeThere(links.value, mcp.value, link, device),
      { concurrency: "unbounded" },
    );
    answers.forEach((answer, index) => {
      if (answer._tag === "Success") linked.push(answer.success);
      else missed.push({ label: asked[index]!.label, reason: answer.failure.message });
    });
  }
  return { linked, missed };
});

/** Codes for a phone: here, her brain's, and every machine that can give one; the rest say why not. */
export const issue = Effect.fn("PhonePairing.issue")(function* () {
  const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
  if (auth._tag === "None")
    return yield* new PhonePairingError({ reason: "Pairing is not available on this server." });
  const device = yield* newDevice;
  const here = yield* codeHere(auth.value, device);
  const self = yield* ownEnvironment;
  const linked: Array<PhonePairingResult["linked"][number]> = [];
  const missed: Array<PhonePairingResult["missed"][number]> = [];
  let brain = self;
  const brainLabel = yield* brainOn;
  if (brainLabel !== null) {
    // Not her brain: the brain hands out its machines' codes, so this one pairing reaches the whole household.
    const answer = yield* (yield* makeBrainLink).send("phoneCodes", {
      device,
      skip: self === null ? [] : [String(self)],
    });
    const got = Option.flatMap(answer, decodeFromBrain);
    const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
    const link =
      Option.isNone(links) || Option.isNone(got)
        ? undefined
        : (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).find(
            (l) => l.environmentId === got.value.environmentId,
          );
    if (Option.isSome(got) && Option.isSome(links) && link !== undefined) {
      const { url } = yield* links.value
        .resolve(link.environmentId)
        .pipe(Effect.orElseSucceed(() => ({ url: "" })));
      if (url !== "") {
        linked.push({
          environmentId: link.environmentId,
          label: link.label,
          pairingUrl: setPairingTokenOnUrl(new URL("/pair", url), got.value.credential).toString(),
          expiresAt: got.value.expiresAt,
        });
        brain = link.environmentId;
      }
      for (const l of got.value.linked)
        if (l.environmentId !== self)
          linked.push({ ...l, environmentId: l.environmentId as never });
      missed.push(...got.value.missed);
    } else
      missed.push({
        label: brainLabel,
        reason: "Her brain did not answer; only this machine's own links are in this code.",
      });
  }
  const mine = yield* fanOut(device, new Set(linked.map((l) => String(l.environmentId))));
  linked.push(...mine.linked);
  missed.push(...mine.missed.filter((m) => !linked.some((l) => l.label === m.label)));
  return {
    here,
    linked,
    missed,
    device,
    ...(brain === null ? {} : { brain }),
  } satisfies PhonePairingResult;
});
