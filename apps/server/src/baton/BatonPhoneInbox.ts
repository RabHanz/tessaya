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
  PROMPT_TTL_MS,
  QUEUE_MAX,
  askLine,
  isConnected,
  type AskSource as AskSourceType,
  type AskStatus,
  type PhoneAsk,
  type PhonePrompt,
} from "@t3tools/tessaya-shared/phoneRelay";
import {
  BatonDesktopState,
  BatonPhoneError,
  type BatonPhoneCallInput,
} from "@t3tools/tessaya-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BatonRecordService } from "./BatonRecordService.ts";

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
  readonly title: string;
  readonly detail: string;
  readonly buttons: string;
  readonly yes: number;
  readonly cancel: number;
  readonly needs: string | null;
  readonly status: string;
  readonly answer: number | null;
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

/** Who left the words: set by the transport from the caller's session, and "device" (not his) when nobody set it. */
export const AskSource = Context.Reference<AskSourceType>("t3/baton/BatonPhoneInbox/AskSource", {
  defaultValue: () => "device",
});

export type PostResult =
  | { readonly ok: true; readonly ask: PhoneAsk }
  | { readonly ok: false; readonly why: string };

/** On: the one brain on this server answers asks (S6); off: the desktop does. */
const BRAIN_ANSWERS_KEY = "brain.asks";

export class BatonPhoneInbox extends Context.Service<
  BatonPhoneInbox,
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
    /** Runs agents' check-and-post one at a time, so two at once cannot both pass the cap. */
    readonly agentsInTurn: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** The desktop's latest account of itself (`tessaya_state`), kept in memory only. */
    readonly publishState: (state: BatonDesktopState) => Effect.Effect<void>;
    readonly desktopState: Effect.Effect<{
      readonly at: number;
      readonly state: BatonDesktopState;
    } | null>;
  }
>()("t3/baton/BatonPhoneInbox") {}

/**
 * The outside agent asking (its MCP session, made safe for an id), set only by the MCP toolkit; null for the phone,
 * the web bar and any client, which cannot name one.
 */
export const AskOwner = Context.Reference<string | null>("t3/baton/BatonPhoneInbox/AskOwner", {
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

export const make = Effect.gen(function* () {
  const record = yield* Effect.serviceOption(BatonRecordService);
  const agentPosts = yield* Semaphore.make(1);
  let latestState: { readonly at: number; readonly state: BatonDesktopState } | null = null;
  const sql = yield* SqlClient.SqlClient;
  let lastSeen: number | null = null;

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
    yield* sql`UPDATE fabric_phone_prompts SET status = 'closed' WHERE status = 'pending' AND expires_at <= ${now}`;
    // Old answered rows are only history.
    yield* sql`DELETE FROM fabric_phone_asks WHERE status IN ('answered','failed','expired') AND created_at <= ${now - 3 * ASK_TTL_MS}`;
    yield* sql`DELETE FROM fabric_phone_prompts WHERE status IN ('answered','closed') AND expires_at <= ${now - PROMPT_TTL_MS}`;
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
    const waiting = yield* sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM fabric_phone_asks WHERE status IN ('queued','taken')`.pipe(
      Effect.orDie,
    );
    if ((waiting[0]?.n ?? 0) >= QUEUE_MAX) {
      return { ok: false as const, why: "Too many asks are waiting. Let your computer catch up." };
    }
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

  const mirror = Effect.fn("BatonPhoneInbox.mirror")(function* (prompt: PhonePrompt) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      INSERT OR REPLACE INTO fabric_phone_prompts (id, title, detail, buttons, yes, cancel, needs, status, answer, created_at, expires_at)
      VALUES (${prompt.id}, ${prompt.title.slice(0, 200)}, ${prompt.detail.slice(0, 4000)}, ${encodeButtons(prompt.buttons.slice(0, MAX_BUTTONS))},
              ${prompt.yes}, ${prompt.cancel}, ${prompt.needs ?? null}, 'pending', NULL, ${now}, ${now + PROMPT_TTL_MS})
    `.pipe(Effect.orDie);
  });

  const pending = Effect.gen(function* () {
    yield* sweep;
    const rows =
      yield* sql<PromptRow>`SELECT * FROM fabric_phone_prompts WHERE status = 'pending' ORDER BY created_at`.pipe(
        Effect.orDie,
      );
    return rows.map((r): PhonePrompt => ({
      id: r.id,
      title: r.title,
      detail: r.detail,
      buttons: decodeButtons(r.buttons),
      yes: r.yes,
      cancel: r.cancel,
      ...(r.needs === "cloud-approve" ? { needs: "cloud-approve" as const } : {}),
    }));
  });

  const answerPrompt = Effect.fn("BatonPhoneInbox.answerPrompt")(function* (
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
      return false;
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
  });

  return BatonPhoneInbox.of({
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
    mirror,
    pending,
    answerPrompt,
    promptAnswer,
    closePrompt,
    agentsInTurn: Semaphore.withPermit(agentPosts),
    publishState: Effect.fn("BatonPhoneInbox.publishState")(function* (state: BatonDesktopState) {
      latestState = { at: yield* Clock.currentTimeMillis, state };
    }),
    desktopState: Effect.sync(() => latestState),
  });
});

export const layer = Layer.effect(BatonPhoneInbox, make);

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

const decodeDesktopState = Schema.decodeUnknownOption(BatonDesktopState);

const AGENT_ASKS_OPEN_MAX = 3;
const AGENT_ASK_OPEN =
  "Your last request is still waiting for the Director. Check it with tessaya_ask_status before asking again.";
const AGENT_ASKS_FULL =
  "Agents already have three requests waiting for the Director, so nothing was asked. Try again later.";

/** The desktop's calls (`baton.phone.call`): every argument is checked here, whatever the window sent. */
export const phoneCall = Effect.fn("BatonPhoneInbox.call")(function* (input: BatonPhoneCallInput) {
  const inbox = yield* BatonPhoneInbox;
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
    // The desktop's account of itself: only the fields BatonDesktopState names survive the decode.
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
  }
});
