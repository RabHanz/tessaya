// @effect-diagnostics globalJsonInEffect:off
/**
 * The Margin, his day, lists and reminders (tessaya-ops handoffs/margin-integration-2026-11-28.md), read live over its
 * MCP with the same client as the ops system; nothing is copied here. Writes add and tick only. What The Margin pushes
 * (`announce`) she says on the vessel he is nearest, or leaves as a card on his phone. Every read, write and push is
 * one Record row of kind "margin". Only on the brain, which holds the token.
 */
import { DEFAULT_POLICY } from "@t3tools/tessaya-shared/initiative";
import { inQuietHours, quietHoursOf } from "@t3tools/tessaya-shared/comms";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import {
  announceRoute,
  MARGIN_HOUSEHOLD,
  MARGIN_IDEMPOTENT,
  MARGIN_READS,
  MARGIN_WRITES,
  type MarginAnnounceKind,
  type MarginPriority,
} from "@t3tools/tessaya-shared/margin";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { HomeDevices } from "../home/HomeDevices.ts";
import { houseZone, isoIn } from "./houseZone.ts";
import { PersonaOpsConnection } from "./PersonaOpsMcpClient.ts";
import { readDndUntil, readQuietHours } from "./quietHours.ts";
import { expressOr } from "./TessayaExpression.ts";
import { TessayaHousehold } from "./TessayaHousehold.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { peopleHere, whereToSay } from "./TessayaPresence.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";

export const MARGIN_URL = "https://mcp.themarginapp.com/mcp";
/** The owner's Margin token in the brain's secrets (connector-<id>-<member>). */
export const MARGIN_TOKEN_SECRET = "connector-margin-owner";
const NAME = "The Margin";
/** A read's answer is cut here: one Margin week can be far longer than a voice turn needs. */
const DATA_MAX_CHARS = 8_000;

/** Who is asking: the turn's member (null: nobody known) and the vessel's label. */
export interface MarginActor {
  readonly member: string | null;
  readonly via: string;
  readonly rehearsal: boolean;
}

export interface MarginResult {
  readonly status: "ok" | "refused" | "error";
  readonly line: string;
  readonly data?: unknown;
}

export interface MarginAnnounce {
  readonly text: string;
  /** ISO time it is due; absent means now. */
  readonly due?: string;
  readonly priority?: MarginPriority;
  readonly kind?: MarginAnnounceKind;
  /** False only for what anyone in the room may hear; private by default. */
  readonly private?: boolean;
  /** The Margin's own id for the item, so a second push of it replaces the first card. */
  readonly id?: string;
}

export interface MarginAnnounceResult {
  readonly status: "spoken" | "carded" | "refused";
  readonly line: string;
}

export class TessayaMargin extends Context.Service<
  TessayaMargin,
  {
    readonly read: (
      actor: MarginActor,
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<MarginResult>;
    readonly write: (
      actor: MarginActor,
      tool: string,
      args: Readonly<Record<string, unknown>>,
      reason: string,
    ) => Effect.Effect<MarginResult>;
    /** An item The Margin says is due for him: spoken, or a card. */
    readonly announce: (input: MarginAnnounce) => Effect.Effect<MarginAnnounceResult>;
  }
>()("t3/tessaya/TessayaMargin") {}

type Args = Readonly<Record<string, unknown>>;
const READS: ReadonlySet<string> = new Set(MARGIN_READS);
const WRITES: ReadonlySet<string> = new Set(MARGIN_WRITES);

const capped = (data: unknown): unknown => {
  const text = JSON.stringify(data) ?? "null";
  return text.length <= DATA_MAX_CHARS
    ? data
    : { truncated: true, firstPart: text.slice(0, DATA_MAX_CHARS) };
};
const messageOf = (data: unknown): string | null => {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const m = d["message"] ?? d["error"];
  return typeof m === "string" && m !== "" ? m.slice(0, 300) : null;
};

const make = Effect.fn("TessayaMargin.make")(function* (url: string) {
  const secrets = yield* ServerSecretStore;
  const household = yield* Effect.serviceOption(TessayaHousehold);
  const record = yield* Effect.serviceOption(TessayaRecordService);
  let connection: PersonaOpsConnection | null = null;

  const log = (entry: {
    readonly actor: string;
    readonly subject: string;
    readonly outcome: string;
    readonly detail?: string;
    readonly ref?: string;
  }) => (Option.isNone(record) ? Effect.void : record.value.append({ kind: "margin", ...entry }));

  const unavailable = Effect.gen(function* () {
    const home = Option.isSome(household) ? yield* household.value.homeOn : null;
    return home === null ? null : `${NAME} is reached from her brain (${home}), not this server.`;
  });

  const connect = Effect.gen(function* () {
    if (connection !== null) return connection;
    const token = yield* secrets.get(MARGIN_TOKEN_SECRET).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
      Effect.map(Option.filter((t) => t !== "")),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(token)) return null;
    connection = new PersonaOpsConnection({ url, name: NAME }, null, token.value);
    return connection;
  });

  const call = Effect.fn("TessayaMargin.call")(function* (
    actor: MarginActor,
    kind: "read" | "write",
    tool: string,
    args: Readonly<Record<string, unknown>>,
    reason: string | null,
  ) {
    if (!(kind === "read" ? READS : WRITES).has(tool))
      return {
        status: "refused",
        line: `${tool} is not something I do in ${NAME}: I read it, and add or tick things there.`,
      } satisfies MarginResult;
    // His own things there need him; the home's lists are anyone's at home.
    if (!MARGIN_HOUSEHOLD.has(tool) && actor.member !== OWNER_MEMBER_ID)
      return {
        status: "refused",
        line: `That part of ${NAME} is the owner's own; only he can reach it.`,
      } satisfies MarginResult;
    const why = yield* unavailable;
    if (why !== null) return { status: "error", line: why } satisfies MarginResult;
    if (kind === "write" && actor.rehearsal)
      return {
        status: "ok",
        line: `Done (a replay: nothing reached ${NAME}).`,
      } satisfies MarginResult;
    const open = yield* connect;
    if (open === null)
      return {
        status: "error",
        line: `${NAME} is not connected on this server yet.`,
      } satisfies MarginResult;
    const key = `tessaya:${(yield* Clock.currentTimeMillis).toString(36)}-${(yield* Random.nextIntBetween(0, 0xffffff)).toString(16)}`;
    const sent: Record<string, unknown> = { ...args };
    if (MARGIN_IDEMPOTENT.has(tool)) sent["idempotency_key"] = key;
    if (tool === "add_shopping_item" && reason !== null) sent["reason"] = reason;
    if (tool === "capture") sent["source"] = `Tessaya via ${actor.via}`;
    const called = yield* Effect.tryPromise({
      try: () => open.callTool(tool, sent),
      catch: (e) => (e instanceof Error ? e.message : String(e)),
    }).pipe(Effect.result);
    const outcome = called._tag === "Failure" ? "fail" : called.success.isError ? "refused" : "ok";
    yield* log({
      actor: `Tessaya via ${actor.via}`,
      subject: `${kind} ${tool}`,
      outcome,
      ref: key,
      ...(reason === null ? {} : { detail: reason }),
    });
    if (called._tag === "Failure") {
      open.close();
      connection = null;
      return { status: "error", line: called.failure } satisfies MarginResult;
    }
    if (called.success.isError)
      return {
        status: "refused",
        line: messageOf(called.success.data) ?? `${NAME} refused it.`,
      } satisfies MarginResult;
    return {
      status: "ok",
      line: kind === "write" ? "Done." : "Read.",
      data: capped(called.success.data),
    } satisfies MarginResult;
  });

  const announce = Effect.fn("TessayaMargin.announce")(function* (input: MarginAnnounce) {
    const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (text === "")
      return { status: "refused", line: "Nothing to say." } satisfies MarginAnnounceResult;
    const now = yield* Clock.currentTimeMillis;
    const due = input.due === undefined ? null : Date.parse(input.due);
    const zone = yield* houseZone();
    const quietSpec = (yield* readQuietHours) ?? quietHoursOf(DEFAULT_POLICY.quietHours, zone);
    const quiet = inQuietHours(now, quietSpec) || (yield* readDndUntil(OWNER_MEMBER_ID)) !== null;
    const vessel = yield* whereToSay(OWNER_MEMBER_ID, null, "reminder");
    const others =
      vessel === null
        ? false
        : (yield* peopleHere(vessel)).some((p) => p.member !== OWNER_MEMBER_ID);
    const route = announceRoute({
      priority: input.priority ?? "normal",
      private: input.private !== false,
      dueAt: due !== null && Number.isFinite(due) ? due : null,
      now,
      quiet,
      vessel,
      othersThere: others,
    });
    const devices = yield* Effect.serviceOption(HomeDevices);
    let spoken = false;
    if (route.action === "speak" && Option.isSome(devices)) {
      const line =
        (yield* expressOr("msg.from", {
          facts: { from: `your ${NAME}`, text },
          plain: `From ${NAME}: ${text}`,
        }))?.text.slice(0, 600) ?? `From ${NAME}: ${text}`;
      spoken = yield* devices.value
        .command(route.vessel, { op: "say", text: line }, { who: "Tessaya", surface: "assistant" })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
    }
    const why = spoken ? null : route.action === "card" ? route.why : "the speaker did not take it";
    if (!spoken) {
      const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
      const when =
        due !== null && Number.isFinite(due)
          ? ` Due ${isoIn(due, zone).slice(0, 16).replace("T", " ")}.`
          : "";
      if (Option.isSome(inbox))
        yield* inbox.value.mirror({
          id: `margin-${(input.id ?? text).slice(0, 80)}`,
          title: `From ${NAME}`,
          detail: `${text}${when}`,
          buttons: ["OK"],
          yes: 0,
          cancel: 0,
        });
    }
    yield* log({
      actor: NAME,
      subject: `push ${input.kind ?? "reminder"}`,
      outcome: spoken ? "spoken" : "carded",
      ...(input.id === undefined ? {} : { ref: input.id.slice(0, 200) }),
      detail: spoken
        ? `said on ${route.action === "speak" ? route.vessel : ""}`
        : `card: ${why ?? ""}`,
    });
    return spoken
      ? ({ status: "spoken", line: "Said to him." } satisfies MarginAnnounceResult)
      : ({
          status: "carded",
          line: `Left as a card on his phone (${why}).`,
        } satisfies MarginAnnounceResult);
  });

  yield* Effect.addFinalizer(() => Effect.sync(() => connection?.close()));

  return TessayaMargin.of({
    read: Effect.fn("TessayaMargin.read")((actor: MarginActor, tool: string, args: Args) =>
      call(actor, "read", tool, args, null),
    ),
    write: Effect.fn("TessayaMargin.write")(
      (actor: MarginActor, tool: string, args: Args, reason: string) =>
        call(actor, "write", tool, args, reason),
    ),
    announce,
  });
});

export const layerWith = (url: string) => Layer.effect(TessayaMargin, make(url));

export const layer = Layer.effect(
  TessayaMargin,
  Effect.flatMap(Config.String("TESSAYA_MARGIN_URL").pipe(Config.withDefault(MARGIN_URL)), make),
);
