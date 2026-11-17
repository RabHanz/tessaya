// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off
/**
 * Personas acting in an ops system over its MCP, each as its own worker there; only on the brain. The system owns every
 * approval: the inbox shows it, and his decision goes back only as a relay the brain signs after his verified voice.
 */
import { newEventId } from "@t3tools/tessaya-shared/provenance";
import {
  type PersonaOpsAccount,
  type PersonaOpsCallInput,
  type PersonaOpsCallResult,
  type PersonaOpsView,
} from "@t3tools/tessaya-contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { emitAction } from "../provenance/ActionLog.ts";
import { TessayaHousehold } from "./TessayaHousehold.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { PersonaOpsConnection, type PersonaOpsToolResult } from "./PersonaOpsMcpClient.ts";
import {
  generateRelayKeyPem,
  relayKeyOf,
  relayNonce,
  signRelay,
  type RelayKey,
} from "./personaOpsRelay.ts";

export const PersonaOpsConfig = Schema.Struct({
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  /** Non-secret environment for the ops system process (its database URL comes from its own config). */
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** What he calls the system, in her words and in Settings. */
  name: Schema.optionalKey(Schema.String),
  /** The child's environment variables that carry the worker id and its token (the system reads them at start). */
  workerIdEnv: Schema.String,
  tokenEnv: Schema.String,
  /** The ops system's web app, for "approve it in the ops system" links. */
  uiUrl: Schema.optionalKey(Schema.String),
  /** On once the ops system accepts `approval_relay` and he has registered the brain's key. */
  relay: Schema.optionalKey(Schema.Boolean),
  /** Persona (lower case) to its workers.id there. Not secret. */
  personas: Schema.Record(Schema.String, Schema.String),
});
export type PersonaOpsConfig = typeof PersonaOpsConfig.Type;

const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(PersonaOpsConfig));
const readPersonaOpsConfig = (raw: string | undefined): PersonaOpsConfig | null =>
  raw === undefined || raw.trim() === "" ? null : Option.getOrNull(decodeConfig(raw));

export const tokenSecretName = (persona: string) => `persona-ops-token-${persona}`;
export const RELAY_KEY_SECRET = "persona-ops-relay-ed25519";
const PERSONA = /^[a-z0-9-]{1,40}$/;

/** Who is asking: the turn's persona, and whether the turn's voice is his, verified at the act cut on its own audio. */
export interface PersonaOpsActor {
  readonly persona: string | null;
  readonly hisVoice: boolean;
  /** Voice ID's raw score for this turn, when it ran. */
  readonly score: number | null;
  readonly tainted: boolean;
  readonly via: string;
}

export type PersonaOpsAct =
  | { readonly op: "status"; readonly deviceSerial?: string; readonly platform?: string }
  | {
      readonly op: "schedule";
      readonly deviceSerial: string;
      readonly platform: string;
      readonly account: string;
      readonly nicheTerms: ReadonlyArray<string>;
      readonly minutesPerDay: number;
      readonly daysBeforeFirstPost: number;
      readonly site?: string;
      readonly enabled: boolean;
    }
  | { readonly op: "run"; readonly deviceSerial: string; readonly platform: string }
  | {
      readonly op: "post";
      readonly deviceSerial: string;
      readonly platform: string;
      readonly account: string;
      readonly mediaRef: string;
      readonly caption: string;
    }
  | {
      readonly op: "answer";
      readonly approvalId: string;
      readonly decision: "approve" | "reject";
      readonly reason?: string;
    };

interface PersonaOpsActResult {
  readonly status: "ok" | "refused" | "approval" | "error";
  readonly line: string;
  readonly data?: unknown;
  /** This call's ActionLog event. */
  readonly actionId?: string;
}

export class PersonaOps extends Context.Service<
  PersonaOps,
  {
    readonly act: (
      actor: PersonaOpsActor,
      input: PersonaOpsAct,
    ) => Effect.Effect<PersonaOpsActResult>;
    /** Settings: the personas with access to the ops system, and the accounts the ops system shows each. */
    readonly view: Effect.Effect<PersonaOpsView>;
    /** The reverse of installing a token: it leaves the brain's secrets and its connection closes. */
    readonly revoke: (
      persona: string,
    ) => Effect.Effect<{ readonly ok: boolean; readonly line: string }>;
    /** Settings' one door: the view, or a revoke answered with the view after it. */
    readonly call: (input: PersonaOpsCallInput) => Effect.Effect<PersonaOpsCallResult>;
    /** The brain's relay public key and key id, for him to register in the ops system; made on first ask. */
    readonly relayKey: Effect.Effect<{
      readonly keyId: string;
      readonly publicKeyPem: string;
    } | null>;
  }
>()("t3/tessaya/PersonaOps") {}

const TOOL: Record<Exclude<PersonaOpsAct["op"], "answer">, string> = {
  status: "device_warmup_status",
  schedule: "device_warmup_schedule",
  run: "device_warmup_run",
  post: "device_post_enqueue",
};
const RELAY_TOOL = "approval_relay";
const CARD_PREFIX = "ops:";

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const randomBytes = (n: number) => new Uint8Array(NodeCrypto.randomBytes(n));

const make = Effect.fn("PersonaOps.make")(function* (config: PersonaOpsConfig | null) {
  const secrets = yield* ServerSecretStore;
  const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
  const household = yield* Effect.serviceOption(TessayaHousehold);
  const connections = new Map<string, PersonaOpsConnection>();
  let relayKeyCache: RelayKey | null = null;

  const ops = config?.name ?? "the ops system";
  const approvalsLink =
    config?.uiUrl === undefined ? `${ops}` : `${config.uiUrl.replace(/\/+$/, "")}/approvals`;
  const decideThere = `Approve it in ${ops}: ${approvalsLink}.`;

  /** Why the ops system can't be reached from here, or null. */
  const unavailable = Effect.gen(function* () {
    const home = Option.isSome(household) ? yield* household.value.homeOn : null;
    if (home !== null) return `${ops} runs on the brain (${home}), not on this server.`;
    if (config === null) return `${ops} is not set up on this server (TESSAYA_PERSONA_OPS).`;
    return null;
  });

  const readToken = (persona: string) =>
    secrets.get(tokenSecretName(persona)).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
      Effect.map(Option.filter((t) => t !== "")),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const connectionFor = Effect.fn("PersonaOps.connectionFor")(function* (persona: string) {
    const open = connections.get(persona);
    if (open !== undefined) return open;
    const workerId = config?.personas[persona];
    if (config === null || workerId === undefined) return null;
    const token = yield* readToken(persona);
    if (Option.isNone(token)) return null;
    const connection = new PersonaOpsConnection(
      {
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        env: config.env,
        workerIdEnv: config.workerIdEnv,
        tokenEnv: config.tokenEnv,
      },
      workerId,
      token.value,
    );
    connections.set(persona, connection);
    return connection;
  });

  const callTool = (
    connection: PersonaOpsConnection,
    tool: string,
    args: Record<string, unknown>,
  ) =>
    Effect.tryPromise({
      try: () => connection.callTool(tool, args),
      catch: (e) => (e instanceof Error ? e.message : String(e)),
    });

  const mintId = Effect.map(Clock.currentTimeMillis, (now) => ({
    now,
    id: newEventId(now, randomBytes),
  }));

  const log = (
    id: string,
    at: number,
    persona: string,
    kind: string,
    subject: string,
    outcome: string,
    data: Record<string, unknown>,
  ) =>
    emitAction({
      id,
      at,
      kind,
      actor: { kind: "persona", id: `tessaya:${persona}`, certainty: 1 },
      persona,
      subject,
      outcome,
      data,
    });

  /** His decision on a card is his, but a card answer proves no voice or PIN, so the ops system still decides it there. */
  const watchCard = Effect.fn("PersonaOps.watchCard")(function* (
    cardId: string,
    persona: string,
    approvalId: string,
    cause: string,
  ) {
    if (Option.isNone(inbox)) return;
    const phone = inbox.value;
    const answer = yield* phone
      .promptAnswer(cardId)
      .pipe(
        Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (a) => a !== null }),
        Effect.timeoutOption(`${yield* phone.cardLife} millis`),
      );
    if (Option.isNone(answer)) return;
    const { id, now } = yield* mintId;
    yield* log(id, now, persona, "ops.approval.answered", approvalId, "not_relayed", {
      approvalId,
      answer: answer.value,
      cause,
    });
    yield* phone.mirror({
      id: `${cardId}:there`,
      title: `Decide it in ${ops}`,
      detail: `${ops} needs your own yes for this, not one passed on from here. ${decideThere} Or tell ${persona} in your own voice.`,
      buttons: ["OK"],
      yes: 0,
      cancel: 0,
    });
  });

  const card = Effect.fn("PersonaOps.card")(function* (
    persona: string,
    approval: Readonly<Record<string, unknown>>,
    what: string,
    cause: string,
  ) {
    const approvalId = text(approval["approvalId"]);
    if (approvalId === null || Option.isNone(inbox)) return;
    const cardId = `${CARD_PREFIX}${approvalId}`;
    yield* inbox.value.mirror({
      id: cardId,
      title: `${persona[0]!.toUpperCase()}${persona.slice(1)} wants your yes`,
      detail: `${what} ${ops} holds it until you decide. Say "approve it" to ${persona} in your own voice, or decide it in ${ops}.`,
      more: JSON.stringify(record(approval["requestedMutation"])["after"] ?? approval),
      buttons: ["Approve", "Reject"],
      yes: 0,
      cancel: 1,
      needs: "cloud-approve",
    });
    yield* watchCard(cardId, persona, approvalId, cause).pipe(
      Effect.ignore,
      // shortcut: the watch lives in memory; a restart drops it, and the ops system still holds the approval.
      Effect.forkDetach,
    );
  });

  /** Plain words for what an act asks, on its card and its log line. */
  const describe = (input: PersonaOpsAct): string => {
    switch (input.op) {
      case "post":
        return `Post on ${input.platform} as @${input.account} from phone ${input.deviceSerial}: "${input.caption.slice(0, 140)}".`;
      case "run":
        return `Run a warm-up now on ${input.platform}, phone ${input.deviceSerial}.`;
      case "schedule":
        return `${input.enabled ? "Schedule" : "Pause"} the daily warm-up of @${input.account} on ${input.platform}, phone ${input.deviceSerial}.`;
      case "status":
        return "Read the warm-up schedules.";
      case "answer":
        return `${input.decision === "approve" ? "Approve" : "Reject"} ${ops} approval ${input.approvalId}.`;
    }
  };

  const argsOf = (input: Exclude<PersonaOpsAct, { op: "answer" }>, actionId: string) => {
    switch (input.op) {
      case "status":
        return {
          ...(input.deviceSerial === undefined ? {} : { deviceSerial: input.deviceSerial }),
          ...(input.platform === undefined ? {} : { platform: input.platform }),
        };
      case "schedule":
        return {
          deviceSerial: input.deviceSerial,
          enabled: input.enabled,
          plan: {
            nicheTerms: input.nicheTerms,
            minutesPerDay: input.minutesPerDay,
            daysBeforeFirstPost: input.daysBeforeFirstPost,
            watchOnly: true,
            interactions: "none",
            platform: input.platform,
            account: input.account,
            ...(input.site === undefined ? {} : { site: input.site }),
          },
        };
      case "run":
        return { deviceSerial: input.deviceSerial, platform: input.platform };
      case "post":
        // The ActionLog id rides as the idempotency key: the device.* inputs have no note field yet.
        return {
          deviceSerial: input.deviceSerial,
          platform: input.platform,
          account: input.account,
          mediaRef: input.mediaRef,
          caption: input.caption,
          idempotencyKey: `tessaya:${actionId}`,
        };
    }
  };

  const getRelayKey = Effect.gen(function* () {
    if (relayKeyCache !== null) return relayKeyCache;
    const existing = yield* secrets.get(RELAY_KEY_SECRET);
    let pem: string;
    if (Option.isSome(existing)) pem = new TextDecoder().decode(existing.value);
    else {
      pem = generateRelayKeyPem();
      // create, not set: two first asks at once keep the one key that won.
      yield* secrets
        .create(RELAY_KEY_SECRET, new TextEncoder().encode(pem))
        .pipe(
          Effect.catch(() =>
            Effect.flatMap(secrets.get(RELAY_KEY_SECRET), (again) =>
              Option.isSome(again)
                ? Effect.sync(() => void (pem = new TextDecoder().decode(again.value)))
                : Effect.fail("no key"),
            ),
          ),
        );
    }
    relayKeyCache = relayKeyOf(pem);
    return relayKeyCache;
  });

  const act = Effect.fn("PersonaOps.act")(function* (actor: PersonaOpsActor, input: PersonaOpsAct) {
    const why = yield* unavailable;
    if (why !== null) return { status: "error", line: why } satisfies PersonaOpsActResult;
    const persona = actor.persona?.trim().toLowerCase() ?? "";
    if (!PERSONA.test(persona) || config?.personas[persona] === undefined) {
      const who = Object.keys(config?.personas ?? {});
      return {
        status: "refused",
        line:
          who.length === 0
            ? `No persona has ${ops} access.`
            : `Only ${who.join(", ")} can act in ${ops}; ask them.`,
      } satisfies PersonaOpsActResult;
    }
    const connection = yield* connectionFor(persona);
    if (connection === null)
      return {
        status: "refused",
        line: `${persona} has no ${ops} token on the brain yet, so it can't act there.`,
      } satisfies PersonaOpsActResult;
    const { id, now } = yield* mintId;
    const what = describe(input);

    if (input.op === "answer") {
      // Only his own voice, verified on this turn, is proof the ops system accepts; anything else decides it there.
      if (!actor.hisVoice || actor.tainted || actor.score === null)
        return {
          status: "refused",
          line: `Only your own verified voice can pass on your decision. ${decideThere}`,
        } satisfies PersonaOpsActResult;
      if (config?.relay !== true)
        return { status: "refused", line: decideThere } satisfies PersonaOpsActResult;
      const key = yield* getRelayKey.pipe(Effect.option);
      if (Option.isNone(key))
        return {
          status: "error",
          line: `The brain's relay key could not be read. ${decideThere}`,
        } satisfies PersonaOpsActResult;
      const relay = signRelay(key.value, {
        approval_id: input.approvalId,
        decision: input.decision,
        reason: input.reason ?? `The Director, in his own voice on ${actor.via}, via Tessaya.`,
        relayer_action_id: id,
        verification: { method: "voice_owner", score: actor.score },
        issued_at: DateTime.formatIso(DateTime.makeUnsafe(now)),
        nonce: relayNonce(),
      });
      const sent = yield* callTool(connection, RELAY_TOOL, { ...relay }).pipe(Effect.result);
      const result = sent._tag === "Success" ? sent.success : null;
      const outcome = result === null ? "fail" : result.isError ? "refused" : "ok";
      yield* log(id, now, persona, "ops.approval.relay", input.approvalId, outcome, {
        tool: RELAY_TOOL,
        decision: input.decision,
        method: "voice_owner",
        score: actor.score,
        keyId: key.value.keyId,
        ...(result === null ? { error: sent._tag === "Failure" ? sent.failure : "" } : {}),
      });
      if (result === null || result.isError)
        return {
          status: result === null ? "error" : "refused",
          line: `${ops} did not take it (${result === null ? (sent._tag === "Failure" ? sent.failure : "") : (text(record(result.data)["message"]) ?? "refused")}). ${decideThere}`,
          actionId: id,
        } satisfies PersonaOpsActResult;
      if (Option.isSome(inbox)) yield* inbox.value.closePrompt(`${CARD_PREFIX}${input.approvalId}`);
      return {
        status: "ok",
        line: input.decision === "approve" ? `Approved in ${ops}.` : `Rejected in ${ops}.`,
        data: result.data,
        actionId: id,
      } satisfies PersonaOpsActResult;
    }

    const tool = TOOL[input.op];
    const called = yield* callTool(connection, tool, argsOf(input, id)).pipe(Effect.result);
    if (called._tag === "Failure") {
      connections.delete(persona);
      connection.close();
      yield* log(id, now, persona, "ops.call", tool, "fail", { tool, error: called.failure });
      return {
        status: "error",
        line: `${ops} could not be reached: ${called.failure}`,
        actionId: id,
      } satisfies PersonaOpsActResult;
    }
    const result: PersonaOpsToolResult = called.success;
    const data = record(result.data);
    const refusal = text(data["refusal"]);
    const code = text(data["code"]);
    const outcome = result.isError
      ? code === "APPROVAL_REQUIRED"
        ? "approval"
        : "refused"
      : refusal === null
        ? "ok"
        : "refused";
    const approval = record(data["approval"]);
    yield* log(id, now, persona, "ops.call", tool, outcome, {
      tool,
      ...(text(data["requestId"]) === null ? {} : { requestId: data["requestId"] }),
      ...(text(data["auditRecordId"]) === null ? {} : { auditRecordId: data["auditRecordId"] }),
      ...(text(approval["approvalId"]) === null ? {} : { approvalId: approval["approvalId"] }),
      ...(code === null ? {} : { code }),
      ...(refusal === null ? {} : { refusal }),
    });
    if (outcome === "approval") {
      yield* card(persona, approval, what, id);
      return {
        status: "approval",
        line: `That needs his yes first. It is waiting in his inbox and in ${ops}; nothing happens until he decides.`,
        data: { approvalId: approval["approvalId"] ?? null },
        actionId: id,
      } satisfies PersonaOpsActResult;
    }
    if (outcome === "refused")
      return {
        status: "refused",
        line:
          text(data["refusalDetail"]) ??
          text(data["message"]) ??
          `${ops} refused it (${refusal ?? code ?? "no reason"}).`,
        data: result.data,
        actionId: id,
      } satisfies PersonaOpsActResult;
    return {
      status: "ok",
      line: "Done.",
      data: result.data,
      actionId: id,
    } satisfies PersonaOpsActResult;
  });

  const accountsOf = (data: unknown): ReadonlyArray<PersonaOpsAccount> => {
    const schedules = record(data)["schedules"];
    return Array.isArray(schedules)
      ? schedules.map((s) => {
          const row = record(s);
          return {
            platform: String(row["platform"] ?? ""),
            account: String(row["account"] ?? ""),
            deviceSerial: String(row["deviceSerial"] ?? ""),
            enabled: row["enabled"] === true,
          };
        })
      : [];
  };

  const view = Effect.gen(function* () {
    const why = yield* unavailable;
    if (why !== null || config === null)
      return { available: false, name: ops, why: why ?? "", personas: [] } satisfies PersonaOpsView;
    const personas = [];
    for (const [persona, workerId] of Object.entries(config.personas)) {
      const hasToken = Option.isSome(yield* readToken(persona));
      if (!hasToken) {
        personas.push({ persona, workerId, hasToken, accounts: null });
        continue;
      }
      // Each look is an act too: the persona read the ops system as itself.
      const read = yield* act(
        { persona, hisVoice: false, score: null, tainted: false, via: "Settings" },
        { op: "status" },
      );
      personas.push(
        read.status === "ok"
          ? { persona, workerId, hasToken, accounts: accountsOf(read.data) }
          : { persona, workerId, hasToken, accounts: null, error: read.line },
      );
    }
    return { available: true, name: ops, personas } satisfies PersonaOpsView;
  }).pipe(Effect.withSpan("PersonaOps.view"));

  const revoke = Effect.fn("PersonaOps.revoke")(function* (raw: string) {
    const persona = raw.trim().toLowerCase();
    if (!PERSONA.test(persona)) return { ok: false, line: "That is not a persona." };
    yield* secrets.remove(tokenSecretName(persona)).pipe(Effect.ignore);
    connections.get(persona)?.close();
    connections.delete(persona);
    const { id, now } = yield* mintId;
    yield* emitAction({
      id,
      at: now,
      kind: "ops.revoke",
      actor: { kind: "owner", certainty: 1 },
      persona,
      subject: persona,
      outcome: "ok",
      data: {},
    });
    return {
      ok: true,
      line: `${persona}'s ${ops} token is gone from the brain; it can no longer act there.`,
    };
  });

  const relayKey = getRelayKey.pipe(
    Effect.map((k) => ({ keyId: k.keyId, publicKeyPem: k.publicKeyPem })),
    Effect.orElseSucceed(() => null),
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const c of connections.values()) c.close();
      connections.clear();
    }),
  );

  const call = Effect.fn("PersonaOps.call")(function* (input: PersonaOpsCallInput) {
    if (input.op === "revoke") {
      const done = yield* revoke(input.persona);
      if (!done.ok) return { ok: false, error: done.line } satisfies PersonaOpsCallResult;
    }
    return { ok: true, view: yield* view } satisfies PersonaOpsCallResult;
  });

  return PersonaOps.of({ act, view, revoke, call, relayKey });
});

export const layerWith = (config: PersonaOpsConfig | null) =>
  Layer.effect(PersonaOps, make(config));

export const layer = Layer.effect(
  PersonaOps,
  Effect.flatMap(Config.String("TESSAYA_PERSONA_OPS").pipe(Config.withDefault("")), (raw) =>
    make(readPersonaOpsConfig(raw)),
  ),
);
