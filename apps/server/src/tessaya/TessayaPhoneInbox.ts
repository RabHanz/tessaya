/**
 * The phone's durable inbox for the desktop assistant: what the phone page asked, kept until the desktop answers it or it
 * expires, and the desktop's own questions mirrored so the phone can answer them. The desktop is the only worker; the
 * server never runs an ask. An ask is marked source "phone" only when the caller is his own (`AskSource`); any other
 * token's words are "device", which the desktop's gate never treats as his.
 */
import {
  ASK_LEASE_MS,
  ASK_TEXT_MAX,
  ASK_TTL_MS,
  BAR_ASK_TTL_MS,
  BAR_NOT_CONNECTED,
  CLIENT_ID,
  PROMPT_EXPIRED,
  PROMPT_TTL_MS,
  askLine,
  isConnected,
  type AskSource as AskSourceType,
  type AskStatus,
  type PhoneAsk,
  type PhonePrompt,
} from "@t3tools/tessaya-shared/phoneRelay";
import {
  TessayaDesktopState,
  BatonPhoneError,
  TessayaInboxSync,
  TessayaInboxAnswer,
  TessayaInboxCard,
  type TessayaPhoneCallInput,
} from "@t3tools/tessaya-contracts";
import {
  OWNER_MEMBER_ID,
  type Assurance,
  type PrincipalRole,
} from "@t3tools/tessaya-shared/household";
import { approvalRefusal } from "@t3tools/tessaya-shared/trust";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { makeBrainLink } from "./BrainHost.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";

interface AskRow {
  readonly id: string;
  readonly text: string;
  readonly source: string;
  readonly origin: string | null;
  readonly his_voice: number | null;
  readonly status: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly taken_at: number | null;
  readonly spoken: string | null;
  readonly card: string | null;
  readonly error: string | null;
}
interface PromptRow {
  readonly id: string;
  readonly expires_at: number;
  readonly title: string;
  readonly detail: string;
  readonly buttons: string;
  readonly yes: number;
  readonly cancel: number;
  readonly needs: string | null;
  readonly status: string;
  readonly answer: number | null;
  readonly batch: string | null;
  readonly more: string | null;
}

const fromAsk = (r: AskRow): PhoneAsk => ({
  id: r.id,
  text: r.text,
  source: r.source === "phone" ? "phone" : "device",
  origin: r.origin ?? (r.source === "phone" ? "phone" : null),
  hisVoice: r.his_voice === 1,
  status: r.status as AskStatus,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  spoken: r.spoken,
  card: r.card,
  error: r.error,
});

/** A question can carry this many answers; the cloud card needs one per assistant-and-account, then Deny and Decide later. */
export const MAX_BUTTONS = 8;
const ButtonsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeButtons = Schema.encodeSync(ButtonsJson);
const decodeButtons = Schema.decodeSync(ButtonsJson);

/** A batch card's answers: Approve all and Deny answer every item; Review each shows the items as their own cards. */
export const BATCH_BUTTONS = ["Approve all", "Review each", "Deny"] as const;
const isBatch = (p: Pick<PhonePrompt, "buttons">) =>
  p.buttons.length === BATCH_BUTTONS.length && BATCH_BUTTONS.every((b, i) => p.buttons[i] === b);

/** The linked-server tool the inbox swaps by. */
export const INBOX_SYNC_TOOL = "tessaya_inbox_sync";
/** How often each server swaps with the others when nothing changed: a server back from away catches up. */
const SWAP_EVERY = "30 seconds";
/** Another server's cards not heard of for this long are not shown: it is away. */
const REMOTE_FRESH_MS = 3 * 60_000;
/** A card of another server that expired is remembered this long, so a late answer hears it expired. */
const LAPSED_KEEP_MS = 3_600_000;

const fromPrompt = (r: PromptRow): PhonePrompt => ({
  id: r.id,
  title: r.title,
  detail: r.detail,
  ...(r.more === null ? {} : { more: r.more }),
  buttons: decodeButtons(r.buttons),
  yes: r.yes,
  cancel: r.cancel,
  ...(r.needs === "cloud-approve" ? { needs: "cloud-approve" as const } : {}),
});

/** Who left the words: set by the transport from the caller's session, and "device" (not his) when nobody set it. */
export const AskSource = Context.Reference<AskSourceType>(
  "t3/tessaya/TessayaPhoneInbox/AskSource",
  {
    defaultValue: () => "device",
  },
);

export type PostResult =
  | { readonly ok: true; readonly ask: PhoneAsk }
  | { readonly ok: false; readonly why: string };

/** On: the one brain on this server answers asks (S6); off: the desktop does. */
const BRAIN_ANSWERS_KEY = "brain.asks";

export class TessayaPhoneInbox extends Context.Service<
  TessayaPhoneInbox,
  {
    /** The phone posts; a repeat of the same client id returns the first (a retry never asks twice). */
    readonly post: (input: {
      readonly id: string;
      readonly text: string;
      /** How long it may wait for the desktop; the phone page's 24 hours when absent. */
      readonly ttlMs?: number;
      /** The device he said it to, when it came through one (his R1 asking his laptop). */
      readonly origin?: string;
      /** Said in his own verified voice on that device. */
      readonly hisVoice?: boolean;
    }) => Effect.Effect<PostResult>;
    readonly get: (id: string) => Effect.Effect<PhoneAsk | null>;
    readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<PhoneAsk>>;
    /** The desktop takes the oldest waiting ask (null when none), and is counted as connected. */
    readonly take: Effect.Effect<PhoneAsk | null>;
    /** Until the next ask is posted, or `ms` pass: the desktop waits here rather than polling every few seconds. */
    readonly waitForAsk: (ms: number) => Effect.Effect<void>;
    readonly renew: (id: string) => Effect.Effect<void>;
    readonly answer: (id: string, spoken: string, card: string) => Effect.Effect<boolean>;
    readonly fail: (id: string, message: string) => Effect.Effect<boolean>;
    readonly connected: Effect.Effect<boolean>;
    /** The one brain on this server answers asks (SPINE-UNIFY S6), as the desktop's one-brain setting says. */
    readonly brainAnswers: Effect.Effect<boolean>;
    readonly setBrainAnswers: (on: boolean) => Effect.Effect<void>;
    /** The desktop mirrors a question it is asking him. */
    readonly mirror: (prompt: PhonePrompt) => Effect.Effect<void>;
    /**
     * Several changes on one card (BATCH_BUTTONS). Each item stays its own card with its own tier and answer, hidden
     * while the batch card waits; answering the batch answers each item as a single answer would.
     */
    readonly mirrorBatch: (batch: {
      readonly id: string;
      readonly title: string;
      readonly detail: string;
      readonly items: ReadonlyArray<PhonePrompt>;
    }) => Effect.Effect<void>;
    /** The newest batch card still waiting, for "approve them all" said aloud; null when none. */
    readonly pendingBatch: Effect.Effect<PhonePrompt | null>;
    readonly pending: Effect.Effect<ReadonlyArray<PhonePrompt>>;
    /** The phone answers a mirrored question; false if it was already answered or gone. */
    /**
     * The phone's answer to a mirrored card; `by` is who answered and how sure (identity I-2), kept on the card and
     * written to the Record as "Approved by Sara (A3, her phone)".
     */
    readonly answerPrompt: (
      id: string,
      index: number,
      by?: PromptApprover,
    ) => Effect.Effect<boolean>;
    /** The desktop asks whether the phone answered: the button index, or null. */
    readonly promptAnswer: (id: string) => Effect.Effect<number | null>;
    readonly closePrompt: (id: string) => Effect.Effect<void>;
    /** Whether that card (this server's or another's) waited too long and was dropped unanswered. */
    readonly expired: (id: string) => Effect.Effect<boolean>;
    /** Whether a batch card expired in the last hour, for "approve them all" said after it did. */
    readonly expiredBatch: Effect.Effect<boolean>;
    /** How long a card waits for his answer: the server's `approvalCardMinutes`. */
    readonly cardLife: Effect.Effect<number>;
    /** What this server sends `to` another: its own waiting cards and his answers to that server's. */
    readonly outgoing: (to: string) => Effect.Effect<TessayaInboxSync>;
    /** Another server's cards and answers to this one's: the answers are applied and recorded here. */
    readonly absorb: (theirs: TessayaInboxSync) => Effect.Effect<void>;
    /** `absorb`, answered with `outgoing` for the caller: one call swaps both ways, so a one-way link is enough. */
    readonly exchange: (theirs: TessayaInboxSync) => Effect.Effect<TessayaInboxSync>;
    /** Runs agents' check-and-post one at a time, so two at once cannot both pass the cap. */
    readonly agentsInTurn: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** The desktop's latest account of itself (`tessaya_state`), kept in memory only. */
    readonly publishState: (state: TessayaDesktopState) => Effect.Effect<void>;
    readonly desktopState: Effect.Effect<{
      readonly at: number;
      readonly state: TessayaDesktopState;
    } | null>;
  }
>()("t3/tessaya/TessayaPhoneInbox") {}

/**
 * The outside agent asking (its MCP session, made safe for an id), set only by the MCP toolkit; null for the phone,
 * the web bar and any client, which cannot name one.
 */
export const AskOwner = Context.Reference<string | null>("t3/tessaya/TessayaPhoneInbox/AskOwner", {
  defaultValue: () => null,
});

/** Who answered a card: their member id and name, their assurance (A0-A4) and the device it came from. */
export interface PromptApprover {
  readonly member: string | null;
  readonly name: string;
  readonly assurance: number;
  readonly via: string;
}

/** The Record's words for who answered a card. */
export const approverLine = (by: PromptApprover) => `${by.name} (A${by.assurance}, ${by.via})`;

/**
 * Someone answers a card, from the phone page or his desktop: a yes counts only from a member whose role and assurance
 * may give it (identity I-2), and a card that waited too long says so. True when taken, false when already answered,
 * else the line to show.
 */
export const answerCard = Effect.fn("BatonPhoneInbox.answerCard")(function* (
  id: string,
  index: number,
  approver: PromptApprover & { readonly role: PrincipalRole | null },
) {
  const inbox = yield* TessayaPhoneInbox;
  const card = (yield* inbox.pending).find((p) => p.id === id);
  if (card === undefined && (yield* inbox.expired(id))) return PROMPT_EXPIRED;
  // Saying no narrows: anyone who may see the card may decline it.
  const refusal =
    card === undefined || index !== card.yes
      ? null
      : approvalRefusal({
          risky: card.needs === "cloud-approve",
          approver: {
            member: approver.member,
            role: approver.role,
            assurance: approver.assurance as Assurance,
          },
        });
  if (refusal !== null) return refusal;
  const { role: _, ...by } = approver;
  return yield* inbox.answerPrompt(id, index, by);
});

/** A card as it travels between a worker and her brain. */
const ForwardedPrompt = Schema.Struct({
  ...TessayaInboxCard.fields,
  expiresAt: Schema.optionalKey(Schema.Number),
  on: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
const decodePrompt = Schema.decodeUnknownOption(ForwardedPrompt);
const decodeForwarded = Schema.decodeUnknownOption(Schema.Array(ForwardedPrompt));
const ForwardedApprover = TessayaInboxAnswer.fields.by;
const decodeApprover = Schema.decodeUnknownOption(ForwardedApprover);
const ForwardedBatch = Schema.Struct({
  id: TessayaInboxCard.fields.id,
  title: TessayaInboxCard.fields.title,
  detail: TessayaInboxCard.fields.detail,
  items: Schema.Array(ForwardedPrompt).check(Schema.isMaxLength(50)),
});
const decodeBatch = Schema.decodeUnknownOption(ForwardedBatch);

/** Her brain's end of a worker's inbox call (BrainReceive); undefined for a call it does not know. */
export const inboxAtBrain = Effect.fn("BatonPhoneInbox.atBrain")(function* (
  inbox: TessayaPhoneInbox["Service"],
  op: string,
  args: Readonly<Record<string, unknown>>,
) {
  const id = typeof args["id"] === "string" ? args["id"] : null;
  switch (op) {
    case "mirror": {
      const prompt = decodePrompt(args["prompt"]);
      if (Option.isNone(prompt)) return undefined;
      yield* inbox.mirror(prompt.value);
      return true;
    }
    case "mirrorBatch": {
      const batch = decodeBatch(args["batch"]);
      if (Option.isNone(batch)) return undefined;
      yield* inbox.mirrorBatch(batch.value);
      return true;
    }
    case "pending":
      return yield* inbox.pending;
    case "expiredBatch":
      return yield* inbox.expiredBatch;
    case "answerPrompt": {
      const index = args["index"];
      if (id === null || typeof index !== "number") return undefined;
      const by = args["by"] === undefined ? Option.none() : decodeApprover(args["by"]);
      return yield* inbox.answerPrompt(id, index, Option.getOrUndefined(by));
    }
    case "promptAnswer":
      return id === null ? undefined : yield* inbox.promptAnswer(id);
    case "closePrompt":
      if (id === null) return undefined;
      yield* inbox.closePrompt(id);
      return true;
    case "expired":
      return id === null ? undefined : yield* inbox.expired(id);
  }
  return undefined;
});

export const make = Effect.gen(function* () {
  const record = yield* Effect.serviceOption(TessayaRecordService);
  const agentPosts = yield* Semaphore.make(1);
  let latestState: { readonly at: number; readonly state: TessayaDesktopState } | null = null;
  const sql = yield* SqlClient.SqlClient;
  let lastSeen: number | null = null;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const cardLife = Option.isNone(settings)
    ? Effect.succeed(PROMPT_TTL_MS)
    : settings.value.getSettings.pipe(
        Effect.map((s) => s.approvalCardMinutes * 60_000),
        Effect.orElseSucceed(() => PROMPT_TTL_MS),
      );
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const self = Option.isNone(environment)
    ? "this-server"
    : String(yield* environment.value.getEnvironmentId);
  let selfLabel: string | null = null;
  const labelHere = Effect.gen(function* () {
    if (selfLabel === null && Option.isSome(environment))
      selfLabel = yield* environment.value.getDescriptor.pipe(
        Effect.map((d) => d.label.slice(0, 80)),
        Effect.orElseSucceed(() => null),
      );
    return selfLabel ?? "this machine";
  });
  /** His other servers' waiting cards, by environment, as each last sent them; shown beside this server's own. */
  const remote = new Map<
    string,
    { readonly label: string; readonly at: number; readonly cards: ReadonlyArray<TessayaInboxCard> }
  >();
  /** His answers to another server's cards, sent with every swap until that server's cards no longer list them. */
  const outbox = new Map<string, ReadonlyArray<TessayaInboxAnswer>>();
  /** Other servers' cards that expired unanswered, by id. */
  const lapsed = new Map<string, { readonly at: number; readonly batch: boolean }>();
  const changes = yield* Queue.sliding<void>(1);
  const changed = Effect.sync(() => Queue.offerUnsafe(changes, undefined));

  let arrived = yield* Deferred.make<void>();
  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      UPDATE fabric_phone_asks SET status = 'expired'
      WHERE status IN ('queued', 'taken') AND expires_at <= ${now}
    `;
    // The desktop renews every ask it works on, so a lapsed lease means it is gone mid-turn: running it
    // again could act twice, so it is dropped and the phone says to ask again.
    yield* sql`
      UPDATE fabric_phone_asks SET status = 'expired'
      WHERE status = 'taken' AND taken_at <= ${now - ASK_LEASE_MS}
    `;
    yield* sql`UPDATE fabric_phone_prompts SET status = 'expired' WHERE status = 'pending' AND expires_at <= ${now}`;
    // Old answered rows are only history.
    yield* sql`DELETE FROM fabric_phone_asks WHERE status IN ('answered','failed','expired') AND created_at <= ${now - 3 * ASK_TTL_MS}`;
    yield* sql`DELETE FROM fabric_phone_prompts WHERE status IN ('answered','closed','expired') AND expires_at <= ${now - LAPSED_KEEP_MS}`;
  }).pipe(Effect.orDie);

  const read = (id: string) =>
    sql<AskRow>`SELECT * FROM fabric_phone_asks WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : fromAsk(rows[0]))),
      Effect.orDie,
    );

  const post = Effect.fn("BatonPhoneInbox.post")(function* (input: {
    readonly id: string;
    readonly text: string;
    readonly ttlMs?: number;
    readonly origin?: string;
    readonly hisVoice?: boolean;
  }) {
    const trimmed = input.text.trim();
    if (!CLIENT_ID.test(input.id))
      return { ok: false as const, why: "That request had no valid id." };
    if (trimmed === "") return { ok: false as const, why: "Say something." };
    if (trimmed.length > ASK_TEXT_MAX)
      return { ok: false as const, why: "That is too long. Keep it short." };
    yield* sweep;
    const again = yield* read(input.id);
    if (again !== null) return { ok: true as const, ask: again };
    const now = yield* Clock.currentTimeMillis;
    const source = yield* AskSource;
    yield* sql`
      INSERT INTO fabric_phone_asks (id, text, source, origin, his_voice, status, created_at, expires_at)
      VALUES (${input.id}, ${trimmed}, ${source}, ${input.origin?.slice(0, 40) ?? null}, ${input.hisVoice === true ? 1 : 0}, 'queued', ${now}, ${now + (input.ttlMs ?? ASK_TTL_MS)})
    `.pipe(Effect.orDie);
    const was = arrived;
    arrived = yield* Deferred.make<void>();
    yield* Deferred.succeed(was, undefined);
    return { ok: true as const, ask: (yield* read(input.id))! };
  });
  const waitForAsk = (ms: number) =>
    Effect.suspend(() => Deferred.await(arrived)).pipe(
      Effect.timeoutOption(`${Math.max(0, Math.min(15_000, ms))} millis`),
      Effect.asVoid,
    );

  const take = Effect.gen(function* () {
    yield* sweep;
    const now = yield* Clock.currentTimeMillis;
    lastSeen = now;
    const rows = yield* sql<AskRow>`
      SELECT * FROM fabric_phone_asks WHERE status = 'queued' ORDER BY created_at, id LIMIT 1
    `.pipe(Effect.orDie);
    const row = rows[0];
    if (row === undefined) return null;
    yield* sql`UPDATE fabric_phone_asks SET status = 'taken', taken_at = ${now} WHERE id = ${row.id}`.pipe(
      Effect.orDie,
    );
    return (yield* read(row.id))!;
  });

  /** The desktop is still working on it: its lease and its deadline move on, so it is not taken twice. */
  const renew = Effect.fn("BatonPhoneInbox.renew")(function* (id: string) {
    const now = yield* Clock.currentTimeMillis;
    lastSeen = now;
    yield* sql`UPDATE fabric_phone_asks SET taken_at = ${now}, expires_at = MAX(expires_at, ${now + ASK_LEASE_MS})
      WHERE id = ${id} AND status = 'taken'`.pipe(Effect.orDie);
  });

  const get = Effect.fn("BatonPhoneInbox.get")(function* (id: string) {
    yield* sweep;
    return yield* read(id);
  });

  const recent = Effect.fn("BatonPhoneInbox.recent")(function* (limit: number) {
    yield* sweep;
    const rows =
      yield* sql<AskRow>`SELECT * FROM fabric_phone_asks ORDER BY created_at DESC, id DESC LIMIT ${limit}`.pipe(
        Effect.orDie,
      );
    return rows.map(fromAsk);
  });

  const settle = Effect.fn("BatonPhoneInbox.settle")(function* (
    id: string,
    status: "answered" | "failed",
    spoken: string | null,
    card: string | null,
    error: string | null,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* read(id);
    if (current === null || current.status !== "taken") return false;
    yield* sql`
      UPDATE fabric_phone_asks SET status = ${status}, answered_at = ${now}, spoken = ${spoken}, card = ${card}, error = ${error}
      WHERE id = ${id}
    `.pipe(Effect.orDie);
    return true;
  });

  const answer = (id: string, spoken: string, card: string) =>
    settle(id, "answered", spoken.slice(0, 4000), card.slice(0, 4000), null);
  const fail = (id: string, message: string) =>
    settle(id, "failed", null, null, message.slice(0, 500));

  const insertPrompt = Effect.fn("BatonPhoneInbox.insertPrompt")(function* (
    prompt: PhonePrompt,
    batch: string | null,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      INSERT OR REPLACE INTO fabric_phone_prompts (id, title, detail, buttons, yes, cancel, needs, status, answer, created_at, expires_at, batch, more)
      VALUES (${prompt.id}, ${prompt.title.slice(0, 200)}, ${prompt.detail.slice(0, 4000)}, ${encodeButtons(prompt.buttons.slice(0, MAX_BUTTONS))},
              ${prompt.yes}, ${prompt.cancel}, ${prompt.needs ?? null}, 'pending', NULL, ${now}, ${now + (yield* cardLife)}, ${batch}, ${prompt.more?.slice(0, 2000) ?? null})
    `.pipe(Effect.orDie);
    yield* changed;
  });
  const mirror = (prompt: PhonePrompt) => insertPrompt(prompt, null);

  const mirrorBatch = Effect.fn("BatonPhoneInbox.mirrorBatch")(function* (batch: {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
    readonly items: ReadonlyArray<PhonePrompt>;
  }) {
    // The batch card first, so its items are never shown on their own while it waits.
    yield* insertPrompt(
      {
        id: batch.id,
        title: batch.title,
        detail: batch.detail,
        buttons: BATCH_BUTTONS,
        yes: 0,
        cancel: 2,
        // The strictest item's tier: a yes to all is a yes to each.
        ...(batch.items.some((i) => i.needs === "cloud-approve")
          ? { needs: "cloud-approve" as const }
          : {}),
      },
      null,
    );
    for (const item of batch.items) yield* insertPrompt(item, batch.id);
  });

  const localRows = Effect.gen(function* () {
    yield* sweep;
    // A batch's items wait behind their batch card until it is answered ("Review each") or gone.
    return yield* sql<PromptRow>`
      SELECT * FROM fabric_phone_prompts p WHERE status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM fabric_phone_prompts b WHERE b.id = p.batch AND b.status = 'pending')
      ORDER BY created_at`.pipe(Effect.orDie);
  });

  /** Other servers' cards still waiting and not answered here, each with the machine it is on. */
  const remoteCards = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return [...remote].flatMap(([env, r]) => {
      if (now - r.at > REMOTE_FRESH_MS) return [];
      const answered = new Set((outbox.get(env) ?? []).map((a) => a.id));
      return r.cards
        .filter((c) => c.expiresAt > now && !answered.has(c.id))
        .map((c) => ({ env, on: r.label, card: c }));
    });
  });

  /** This server's cards and the others', one card per id: a batch asked on several machines is one card. */
  const pending = Effect.gen(function* () {
    const here = (yield* localRows).map((r) => ({ on: null, card: fromPrompt(r) }));
    const there = (yield* remoteCards).map(({ on, card: { expiresAt: _, ...card } }) => ({
      on,
      card: card as PhonePrompt,
    }));
    const byId = new Map<string, Array<{ on: string | null; card: PhonePrompt }>>();
    for (const part of [...here, ...there])
      byId.set(part.card.id, [...(byId.get(part.card.id) ?? []), part]);
    const label = yield* labelHere;
    return [...byId.values()].map((parts): PhonePrompt => {
      const first = parts[0]!;
      if (parts.length === 1)
        return first.on === null ? first.card : { ...first.card, on: first.on };
      const ons = parts.map((p) => p.on ?? label);
      return {
        ...first.card,
        title: `${first.card.title}, on ${parts.length} machines`.slice(0, 200),
        detail: parts.map((p, i) => `On ${ons[i]}:\n${p.card.detail}`).join("\n\n"),
        on: ons.join(", "),
        // The strictest machine's tier: a yes here is a yes on each.
        ...(parts.some((p) => p.card.needs === "cloud-approve")
          ? { needs: "cloud-approve" as const }
          : {}),
      };
    });
  });

  const answerOne = Effect.fn("BatonPhoneInbox.answerOne")(function* (
    id: string,
    index: number,
    by?: PromptApprover,
  ) {
    yield* sweep;
    const rows =
      yield* sql<PromptRow>`SELECT * FROM fabric_phone_prompts WHERE id = ${id} AND status = 'pending'`.pipe(
        Effect.orDie,
      );
    const row = rows[0];
    const buttons = row === undefined ? 0 : decodeButtons(row.buttons).length;
    if (row === undefined || !Number.isInteger(index) || index < 0 || index >= buttons)
      return false as const;
    yield* sql`UPDATE fabric_phone_prompts SET status = 'answered', answer = ${index}, answered_by = ${by === undefined ? null : approverLine(by)}, answered_level = ${by?.assurance ?? null} WHERE id = ${id}`.pipe(
      Effect.orDie,
    );
    if (by !== undefined && Option.isSome(record))
      yield* record.value.append({
        kind: "approval",
        actor: by.name,
        ref: id,
        subject: row.title,
        outcome:
          index === row.yes ? "approved" : index === row.cancel ? "declined" : `chose ${index + 1}`,
        detail: `${index === row.yes ? "Approved" : "Answered"} by ${approverLine(by)}`,
      });
    return row;
  });

  const answerPrompt = Effect.fn("BatonPhoneInbox.answerPrompt")(function* (
    id: string,
    index: number,
    by?: PromptApprover,
  ) {
    // Another server's card (or its part of one across machines) is answered there: sent now, kept until it is.
    const there = (yield* remoteCards).filter(
      ({ card }) =>
        card.id === id && Number.isInteger(index) && index >= 0 && index < card.buttons.length,
    );
    for (const { env } of there)
      outbox.set(env, [
        ...(outbox.get(env) ?? []),
        {
          id,
          index,
          by: by ?? { member: null, name: "someone", assurance: 0, via: "another of his servers" },
        },
      ]);
    if (there.length > 0) yield* changed;
    const here = yield* answerLocal(id, index, by);
    return here || there.length > 0;
  });

  const answerLocal = Effect.fn("BatonPhoneInbox.answerLocal")(function* (
    id: string,
    index: number,
    by?: PromptApprover,
  ) {
    const row = yield* answerOne(id, index, by);
    if (row === false) return false;
    yield* changed;
    // A batch's yes or no is each item's, through the same answer and Record row a single card gets.
    if (index === row.yes || index === row.cancel) {
      const items =
        yield* sql<PromptRow>`SELECT * FROM fabric_phone_prompts WHERE batch = ${id} AND status = 'pending'`.pipe(
          Effect.orDie,
        );
      for (const item of items)
        yield* answerOne(item.id, index === row.yes ? item.yes : item.cancel, by);
    }
    return true;
  });

  const promptAnswer = Effect.fn("BatonPhoneInbox.promptAnswer")(function* (id: string) {
    const rows = yield* sql<PromptRow>`SELECT * FROM fabric_phone_prompts WHERE id = ${id}`.pipe(
      Effect.orDie,
    );
    return rows[0]?.status === "answered" ? rows[0].answer : null;
  });

  const closePrompt = Effect.fn("BatonPhoneInbox.closePrompt")(function* (id: string) {
    yield* sql`UPDATE fabric_phone_prompts SET status = 'closed' WHERE id = ${id} AND status = 'pending'`.pipe(
      Effect.orDie,
    );
    yield* changed;
  });

  const expired = Effect.fn("BatonPhoneInbox.expired")(function* (id: string) {
    yield* sweep;
    const rows = yield* sql<{
      status: string;
    }>`SELECT status FROM fabric_phone_prompts WHERE id = ${id}`.pipe(Effect.orDie);
    if (rows[0]?.status === "expired") return true;
    const now = yield* Clock.currentTimeMillis;
    return (
      lapsed.has(id) ||
      [...remote.values()].some((r) => r.cards.some((c) => c.id === id && c.expiresAt <= now))
    );
  });

  const expiredBatch = Effect.gen(function* () {
    yield* sweep;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM fabric_phone_prompts
      WHERE status = 'expired' AND buttons = ${encodeButtons(BATCH_BUTTONS)} AND expires_at > ${now - LAPSED_KEEP_MS}`.pipe(
      Effect.orDie,
    );
    return (rows[0]?.n ?? 0) > 0 || [...lapsed.values()].some((l) => l.batch);
  });

  const outgoing = Effect.fn("BatonPhoneInbox.outgoing")(function* (to: string) {
    const cards = (yield* localRows)
      .slice(0, 50)
      .map((r): TessayaInboxCard => ({ ...fromPrompt(r), expiresAt: r.expires_at }));
    return {
      from: self,
      label: yield* labelHere,
      cards,
      answers: (outbox.get(to) ?? []).slice(0, 50),
    } satisfies TessayaInboxSync;
  });

  const absorb = Effect.fn("BatonPhoneInbox.absorb")(function* (theirs: TessayaInboxSync) {
    if (theirs.from === self) return;
    const now = yield* Clock.currentTimeMillis;
    // A card of theirs gone unanswered past its time expired there; a late answer here is told so.
    for (const c of remote.get(theirs.from)?.cards ?? [])
      if (c.expiresAt <= now && !theirs.cards.some((n) => n.id === c.id))
        lapsed.set(c.id, { at: now, batch: isBatch(c) });
    for (const [id, l] of lapsed) if (now - l.at > LAPSED_KEEP_MS) lapsed.delete(id);
    remote.set(theirs.from, { label: theirs.label, at: now, cards: theirs.cards });
    // An answer is done once their cards no longer list it (applied, or gone there).
    const waiting = (outbox.get(theirs.from) ?? []).filter((a) =>
      theirs.cards.some((c) => c.id === a.id),
    );
    if (waiting.length === 0) outbox.delete(theirs.from);
    else outbox.set(theirs.from, waiting);
    for (const a of theirs.answers)
      yield* answerLocal(a.id, a.index, {
        ...a.by,
        via: `${a.by.via}, through ${theirs.label}`.slice(0, 120),
      });
  });

  const exchange = Effect.fn("BatonPhoneInbox.exchange")(function* (theirs: TessayaInboxSync) {
    yield* absorb(theirs);
    return yield* outgoing(theirs.from);
  });

  // Every linked server, both ways in one call each: at once on a change here, and every half minute.
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peerMcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  if (Option.isSome(links) && Option.isSome(peerMcp)) {
    const swap = Effect.gen(function* () {
      if (!(yield* links.value.enabled)) return;
      const linked = (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).filter(
        (l) => l.status !== "expired",
      );
      yield* Effect.forEach(
        linked,
        (link) =>
          outgoing(String(link.environmentId)).pipe(
            Effect.flatMap((mine) =>
              peerMcp.value.call({
                environmentId: link.environmentId,
                tool: INBOX_SYNC_TOOL,
                arguments: mine,
                limits: { runtimeMode: "approval-required", interactionMode: "default" },
                success: TessayaInboxSync,
              }),
            ),
            Effect.timeout("10 seconds"),
            Effect.flatMap(absorb),
            Effect.ignore,
          ),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("BatonPhoneInbox.swap"));
    yield* Queue.take(changes).pipe(
      Effect.andThen(swap),
      Effect.ignoreCause({ log: true }),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* swap.pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced(SWAP_EVERY)),
      Effect.forkScoped,
    );
  }

  // One inbox, on her brain: a worker's cards wait there and are answered there (one-brain §2.1). Kept here only while
  // the brain can't be reached, so an act still asks; reads take both, so such a card is never lost.
  const brain = yield* makeBrainLink;
  /** The brain's answer to an inbox call; None on the brain itself, or when it can't be reached. */
  const atBrain = Effect.fn("BatonPhoneInbox.atBrain")(function* (
    op: string,
    args: Record<string, unknown>,
  ) {
    if (yield* brain.isBrain) return Option.none<unknown>();
    return yield* brain.send("inbox", { op, args });
  });
  const brainSaid = Effect.fn("BatonPhoneInbox.brainSaid")(function* (
    op: string,
    args: Record<string, unknown>,
  ) {
    return Option.getOrNull(yield* atBrain(op, args)) === true;
  });
  const brainPending = Effect.gen(function* () {
    const here = yield* pending;
    const there = Option.flatMap(yield* atBrain("pending", {}), decodeForwarded);
    if (Option.isNone(there)) return here;
    return [...there.value, ...here.filter((c) => !there.value.some((t) => t.id === c.id))];
  });
  const mirrorAtBrain = Effect.fn("BatonPhoneInbox.mirrorAtBrain")(function* (prompt: PhonePrompt) {
    if (Option.isNone(yield* atBrain("mirror", { prompt }))) yield* mirror(prompt);
  });
  const mirrorBatchAtBrain = Effect.fn("BatonPhoneInbox.mirrorBatchAtBrain")(function* (
    batch: Parameters<typeof mirrorBatch>[0],
  ) {
    if (Option.isNone(yield* atBrain("mirrorBatch", { batch }))) yield* mirrorBatch(batch);
  });
  const answerAtBrain = Effect.fn("BatonPhoneInbox.answerAtBrain")(function* (
    id: string,
    index: number,
    by?: PromptApprover,
  ) {
    return (
      (yield* brainSaid("answerPrompt", { id, index, ...(by === undefined ? {} : { by }) })) ||
      (yield* answerPrompt(id, index, by))
    );
  });
  const promptAnswerAtBrain = Effect.fn("BatonPhoneInbox.promptAnswerAtBrain")(function* (
    id: string,
  ) {
    const there = Option.getOrNull(yield* atBrain("promptAnswer", { id }));
    return typeof there === "number" ? there : yield* promptAnswer(id);
  });
  const closeAtBrain = Effect.fn("BatonPhoneInbox.closeAtBrain")(function* (id: string) {
    yield* atBrain("closePrompt", { id });
    yield* closePrompt(id);
  });
  const expiredAtBrain = Effect.fn("BatonPhoneInbox.expiredAtBrain")(function* (id: string) {
    return (yield* brainSaid("expired", { id })) || (yield* expired(id));
  });

  return TessayaPhoneInbox.of({
    post,
    get,
    recent,
    take,
    waitForAsk,
    renew,
    answer,
    fail,
    connected: Effect.map(Clock.currentTimeMillis, (now) => isConnected(lastSeen, now)),
    brainAnswers: sql<{
      value: string;
    }>`SELECT value FROM fabric_settings WHERE key = ${BRAIN_ANSWERS_KEY}`.pipe(
      Effect.map((rows) => rows[0]?.value === "1"),
      Effect.orElseSucceed(() => false),
    ),
    setBrainAnswers: Effect.fn("BatonPhoneInbox.setBrainAnswers")(function* (on: boolean) {
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${BRAIN_ANSWERS_KEY}, ${on ? "1" : "0"})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(Effect.orDie);
    }),
    mirror: mirrorAtBrain,
    mirrorBatch: mirrorBatchAtBrain,
    pending: brainPending,
    pendingBatch: Effect.map(brainPending, (cards) => cards.findLast(isBatch) ?? null),
    answerPrompt: answerAtBrain,
    promptAnswer: promptAnswerAtBrain,
    closePrompt: closeAtBrain,
    expired: expiredAtBrain,
    expiredBatch: Effect.gen(function* () {
      return (yield* brainSaid("expiredBatch", {})) || (yield* expiredBatch);
    }),
    cardLife,
    outgoing,
    absorb,
    exchange,
    agentsInTurn: Semaphore.withPermit(agentPosts),
    publishState: Effect.fn("BatonPhoneInbox.publishState")(function* (state: TessayaDesktopState) {
      latestState = { at: yield* Clock.currentTimeMillis, state };
    }),
    desktopState: Effect.sync(() => latestState),
  });
});

export const layer = Layer.effect(TessayaPhoneInbox, make);

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

const decodeDesktopState = Schema.decodeUnknownOption(TessayaDesktopState);

const AGENT_ASKS_OPEN_MAX = 3;
const AGENT_ASK_OPEN =
  "Your last request is still waiting for the Director. Check it with tessaya_ask_status before asking again.";
const AGENT_ASKS_FULL =
  "Agents already have three requests waiting for the Director, so nothing was asked. Try again later.";

/** The desktop's calls (`baton.phone.call`): every argument is checked here, whatever the window sent. */
export const phoneCall = Effect.fn("BatonPhoneInbox.call")(function* (
  input: TessayaPhoneCallInput,
) {
  const inbox = yield* TessayaPhoneInbox;
  const a = input.args;
  const bad = () => new BatonPhoneError({ reason: "That phone call was not understood." });
  const id = str(a["id"], 80);
  switch (input.op) {
    // The web intent bar leaves words for the lead the same way the phone page does, and reads where they stand.
    case "ask": {
      // Nothing is queued with no desktop to take it, and what is queued expires in minutes, not a day.
      if (!(yield* inbox.connected)) return { value: { ok: false, line: BAR_NOT_CONNECTED } };
      // An outside agent's (tessaya_ask): one open request each and three in all, so agents never fill his queue.
      // Only the MCP toolkit names an owner; an `mcp-` id from anyone else would count against the agents'.
      const owner = yield* AskOwner;
      const asked = id ?? "";
      if (owner === null ? asked.startsWith("mcp-") : !asked.startsWith(`mcp-${owner}-`))
        return yield* bad();
      const post = inbox.post({
        id: id ?? "",
        text: typeof a["text"] === "string" ? a["text"] : "",
        ttlMs: BAR_ASK_TTL_MS,
        ...(typeof a["origin"] === "string" && a["origin"].trim() !== ""
          ? { origin: a["origin"].trim() }
          : {}),
        ...(a["hisVoice"] === true ? { hisVoice: true } : {}),
      });
      const made =
        owner === null
          ? yield* post
          : yield* inbox.agentsInTurn(
              Effect.gen(function* () {
                const open = (yield* inbox.recent(100)).filter(
                  (ask) =>
                    ask.id.startsWith("mcp-") &&
                    (ask.status === "queued" || ask.status === "taken"),
                );
                if (open.some((ask) => ask.id.startsWith(`mcp-${owner}-`)))
                  return { ok: false as const, why: AGENT_ASK_OPEN };
                if (open.length >= AGENT_ASKS_OPEN_MAX)
                  return { ok: false as const, why: AGENT_ASKS_FULL };
                return yield* post;
              }),
            );
      if (!made.ok) return { value: { ok: false, line: made.why } };
      return {
        value: {
          ok: true,
          status: made.ask.status,
          line: askLine(made.ask, yield* inbox.connected),
        },
      };
    }
    case "askGet": {
      if (id === null) return yield* bad();
      const ask = yield* inbox.get(id);
      return {
        value:
          ask === null ? null : { status: ask.status, line: askLine(ask, yield* inbox.connected) },
      };
    }
    // The desktop's account of itself: only the fields TessayaDesktopState names survive the decode.
    case "state": {
      // Its caps bound every string and list, so an oversized account does not decode.
      const state = decodeDesktopState(a["state"]);
      if (Option.isNone(state)) return yield* bad();
      yield* inbox.publishState(state.value);
      return { value: null };
    }
    case "stateGet": {
      const latest = yield* inbox.desktopState;
      return {
        value: {
          connected: (yield* inbox.connected) && latest !== null,
          at: latest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(latest.at)),
          state: latest?.state ?? null,
        },
      };
    }
    case "renew": {
      if (id === null) return yield* bad();
      yield* inbox.renew(id);
      return { value: null };
    }
    case "take": {
      const waitMs = typeof a["waitMs"] === "number" ? a["waitMs"] : 0;
      let ask = yield* inbox.take;
      // A desktop that says it will wait is answered the moment an ask arrives (13 Nov: the R1's laptop ask sat up to
      // 30 s in the queue between polls).
      if (ask === null && waitMs > 0) {
        yield* inbox.waitForAsk(waitMs);
        ask = yield* inbox.take;
      }
      return {
        value:
          ask === null
            ? null
            : {
                id: ask.id,
                text: ask.text,
                source: ask.source,
                origin: ask.origin,
                hisVoice: ask.hisVoice,
              },
      };
    }
    case "answer":
    case "fail": {
      const text =
        input.op === "answer"
          ? (str(a["card"], 4000) ?? str(a["spoken"], 4000))
          : str(a["message"], 500);
      if (id === null || text === null) return yield* bad();
      const done =
        input.op === "answer"
          ? yield* inbox.answer(
              id,
              typeof a["spoken"] === "string" ? a["spoken"] : text,
              typeof a["card"] === "string" ? a["card"] : text,
            )
          : yield* inbox.fail(id, text);
      return { value: done };
    }
    case "prompt": {
      const title = str(a["title"], 200);
      const detail = str(a["detail"], 4000);
      const buttons = Array.isArray(a["buttons"])
        ? a["buttons"]
            .filter((b): b is string => typeof b === "string")
            .map((b) => b.slice(0, 60))
            .slice(0, MAX_BUTTONS)
        : [];
      const yes = Number(a["yes"]);
      const cancel = Number(a["cancel"]);
      if (
        id === null ||
        title === null ||
        detail === null ||
        buttons.length < 2 ||
        ![yes, cancel].every((n) => Number.isInteger(n) && n >= 0 && n < buttons.length)
      ) {
        return yield* bad();
      }
      yield* inbox.mirror({
        id,
        title,
        detail,
        buttons,
        yes,
        cancel,
        ...(a["needs"] === "cloud-approve" ? { needs: "cloud-approve" as const } : {}),
      });
      return { value: true };
    }
    case "promptPoll":
      return id === null ? yield* bad() : { value: yield* inbox.promptAnswer(id) };
    case "promptClose":
      if (id === null) return yield* bad();
      yield* inbox.closePrompt(id);
      return { value: true };
    // His desktop window shows the cards waiting on any of his servers, and answers them as him at his own desk.
    case "cards":
      return { value: yield* inbox.pending };
    case "cardAnswer": {
      const index = Number(a["index"]);
      if (id === null || !Number.isInteger(index)) return yield* bad();
      return {
        value: yield* answerCard(id, index, {
          member: OWNER_MEMBER_ID,
          role: "owner",
          name: "him",
          assurance: 3,
          via: "his desktop",
        }),
      };
    }
  }
});
