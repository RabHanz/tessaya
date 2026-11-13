// @effect-diagnostics globalJsonInEffect:off preferSchemaOverJson:off
/**
 * One responder per utterance across every vessel that heard him (R1-P7). A device that hears its wake or her name
 * claims; claims are collected for 250 ms and one is told to answer. The others are told to yield until her reply
 * ends plus 2 s, and a claim from them inside that window yields at once, so her voice from the winner never wakes
 * them. The pick rules are `voiceArbiter.ts` in baton-shared.
 */
import {
  CLAIM_WINDOW_MS,
  QUIET_AFTER_MS,
  pickResponder,
  type VoiceClaim,
} from "@t3tools/baton-shared/voiceArbiter";
import { VoiceClaimInput, type BatonVoiceCallResult } from "@t3tools/baton-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BatonRecordService } from "../baton/BatonRecordService.ts";
import { onPeer } from "../peer/PeerVessels.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import { conversationKey } from "../baton/TessayaTurn.ts";

export type VoiceVerdict =
  | { readonly answer: true; readonly round: string; readonly conversation: string }
  | {
      readonly answer: false;
      readonly round: string;
      /** The conversation the winner continues: "person:<member>" for a verified voice, else the household's. */
      readonly conversation: string;
      readonly winner: string;
      /** Stay quiet, and take speech as her echo, until then (epoch ms). Claim again after it. */
      readonly until: number;
    };

export interface ArbiterState {
  readonly primary: string | null;
  readonly quiet: {
    readonly winner: string;
    readonly until: number;
    readonly conversation: string;
  } | null;
  readonly recent: ReadonlyArray<{
    readonly round: string;
    readonly at: number;
    readonly winner: string;
    readonly claimants: ReadonlyArray<string>;
  }>;
}

/** Until the winner says how long her reply plays, the others stay quiet this long. */
const PROVISIONAL_MS = 20_000;
/** However long a reply says it plays, the others are never held quiet past this. */
const MAX_QUIET_MS = 90_000;
const RECENT_KEEP = 20;
const SETTINGS_KEY = "voice.arbiter";
const decodeSaved = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ primary: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
);

/** The memory lane's rule (TessayaTurn.conversationKey): a verified member's own, else the household's. */
const conversationOf = (c: VoiceClaim): string =>
  conversationKey({
    vessel: { kind: "device", id: c.deviceId },
    text: "",
    speaker:
      c.speaker == null
        ? null
        : {
            kind: c.speaker.verified ? "saved" : "unverified",
            personId: c.speaker.personId,
            verified: c.speaker.verified,
            inherited: false,
          },
  });

export class VoiceArbiter extends Context.Service<
  VoiceArbiter,
  {
    readonly claim: (claim: VoiceClaim) => Effect.Effect<VoiceVerdict>;
    /** The winner's reply plays until `untilMs` (epoch); the others stay quiet until 2 s after. */
    readonly speaking: (deviceId: string, untilMs: number) => Effect.Effect<void>;
    /** The winner's reply ended (or was cut): the others may wake 2 s from now. */
    readonly ended: (deviceId: string) => Effect.Effect<void>;
    readonly setPrimary: (deviceId: string | null) => Effect.Effect<void>;
    readonly state: Effect.Effect<ArbiterState>;
    /**
     * The op on the arbiter of the linked server that has the desk device, when this one has none; null when none
     * answered (or this server has the device, or no links), and this arbiter decides.
     */
    readonly elsewhere: (op: string, args: unknown) => Effect.Effect<BatonVoiceCallResult | null>;
  }
>()("t3/home/VoiceArbiter") {}

interface Round {
  readonly id: string;
  readonly claims: Array<VoiceClaim>;
  readonly decided: Deferred.Deferred<{ readonly winner: string; readonly conversation: string }>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const record = yield* Effect.serviceOption(BatonRecordService);
  const scope = yield* Effect.scope;
  // Found here, where the server's layers are: a device's voice door runs with Baton's services only.
  const home = yield* Effect.serviceOption(HomeAssistantService);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peerMcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  const lastAnswered = new Map<string, number>();
  const recent: Array<ArbiterState["recent"][number]> = [];
  let open: Round | null = null;
  let quiet: { winner: string; until: number; conversation: string } | null = null;
  let counter = 0;

  const saved = yield* sql<{ value: string }>`
    SELECT value FROM fabric_settings WHERE key = ${SETTINGS_KEY}
  `.pipe(Effect.orDie);
  const stored = decodeSaved(saved[0]?.value ?? "{}");
  let primary: string | null = stored._tag === "Some" ? (stored.value.primary ?? null) : null;

  const decide = Effect.fn("VoiceArbiter.decide")(function* (round: Round) {
    yield* Effect.sleep(CLAIM_WINDOW_MS);
    const now = yield* Clock.currentTimeMillis;
    open = null;
    const winner = pickResponder(round.claims, { primary, lastAnswered, now })!;
    lastAnswered.set(winner.deviceId, now);
    const conversation = conversationOf(winner);
    quiet = { winner: winner.deviceId, until: now + PROVISIONAL_MS, conversation };
    const claimants = [...new Set(round.claims.map((c) => c.deviceId))];
    recent.push({ round: round.id, at: now, winner: winner.deviceId, claimants });
    if (recent.length > RECENT_KEEP) recent.shift();
    if (claimants.length > 1 && record._tag === "Some")
      yield* record.value
        .append({
          kind: "device",
          actor: "Tessaya",
          ref: winner.deviceId,
          subject: `Answered on ${winner.deviceId}`,
          outcome: "answered",
          detail: `heard on ${claimants.join(", ")}${winner.answerHere === true ? " (answer here)" : ""}`,
        })
        .pipe(Effect.ignore);
    yield* Deferred.succeed(round.decided, { winner: winner.deviceId, conversation });
  });

  const claim = Effect.fn("VoiceArbiter.claim")(function* (c: VoiceClaim) {
    const now = yield* Clock.currentTimeMillis;
    if (quiet !== null && quiet.until <= now) quiet = null;
    // Her reply is playing elsewhere: what this device heard is her, unless he asked for this one.
    if (quiet !== null && c.answerHere !== true && open === null) {
      if (quiet.winner === c.deviceId) {
        lastAnswered.set(c.deviceId, now);
        const conversation = conversationOf(c);
        quiet = { ...quiet, conversation };
        return { answer: true, round: "follow", conversation } satisfies VoiceVerdict;
      }
      return {
        answer: false,
        round: "quiet",
        winner: quiet.winner,
        until: quiet.until,
        conversation: quiet.conversation,
      } satisfies VoiceVerdict;
    }
    let round = open;
    if (round === null) {
      round = {
        id: `v${now.toString(36)}${(counter++ % 1296).toString(36)}`,
        claims: [],
        decided: yield* Deferred.make<{ winner: string; conversation: string }>(),
      };
      open = round;
      yield* decide(round).pipe(Effect.forkIn(scope));
    }
    round.claims.push(c);
    const { winner, conversation } = yield* Deferred.await(round.decided);
    return winner === c.deviceId
      ? ({ answer: true, round: round.id, conversation } satisfies VoiceVerdict)
      : ({
          answer: false,
          round: round.id,
          winner,
          until: quiet?.until ?? now + PROVISIONAL_MS,
          conversation,
        } satisfies VoiceVerdict);
  });

  return VoiceArbiter.of({
    claim,
    speaking: Effect.fn("VoiceArbiter.speaking")(function* (deviceId: string, untilMs: number) {
      const now = yield* Clock.currentTimeMillis;
      if (quiet?.winner !== deviceId) return;
      quiet = { ...quiet, until: Math.min(untilMs, now + MAX_QUIET_MS) + QUIET_AFTER_MS };
    }),
    ended: Effect.fn("VoiceArbiter.ended")(function* (deviceId: string) {
      const now = yield* Clock.currentTimeMillis;
      if (quiet?.winner === deviceId) quiet = { ...quiet, until: now + QUIET_AFTER_MS };
    }),
    setPrimary: Effect.fn("VoiceArbiter.setPrimary")(function* (deviceId: string | null) {
      primary = deviceId;
      const value = JSON.stringify({ primary });
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${SETTINGS_KEY}, ${value}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
        Effect.orDie,
      );
    }),
    state: Effect.sync(() => ({ primary, quiet, recent: [...recent] })),
    elsewhere: Effect.fn("VoiceArbiter.elsewhere")(function* (op: string, args: unknown) {
      if (links._tag === "None" || peerMcp._tag === "None") return null;
      if (home._tag === "Some" && (yield* home.value.device) !== null) return null;
      const there = yield* onPeer(
        "tessaya_voice_arbiter",
        { op, args: typeof args === "object" && args !== null ? args : {} },
        { takes: (v) => (v as { ok?: unknown } | null)?.ok === true, wait: "2 seconds" },
      ).pipe(
        Effect.provideService(PeerLinks.PeerLinks, links.value),
        Effect.provideService(PeerMcpClient.PeerMcpClient, peerMcp.value),
      );
      return there === null ? null : (there.value as BatonVoiceCallResult);
    }),
  });
});

export const layer = Layer.effect(VoiceArbiter, make);

const decodeClaim = Schema.decodeUnknownOption(VoiceClaimInput);
const decodeDevice = Schema.decodeUnknownOption(
  Schema.Struct({
    deviceId: Schema.String.check(Schema.isMaxLength(60)),
    untilMs: Schema.optionalKey(Schema.Number),
  }),
);
const decodePrimary = Schema.decodeUnknownOption(
  Schema.Struct({ deviceId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(60))) }),
);

/** The arbiter's ops on the voice door and the R1 loop's route; null for an op that is not the arbiter's. */
export const serveArbiter = Effect.fn("VoiceArbiter.serve")(function* (op: string, args: unknown) {
  if (!["arbiter", "claim", "speaking", "ended", "answerFrom"].includes(op)) return null;

  const found = yield* Effect.serviceOption(VoiceArbiter);
  if (found._tag === "None")
    return { ok: false, error: "This server has no voice arbiter." } satisfies BatonVoiceCallResult;
  const arbiter = found.value;
  // A server with no desk device (his desktop's) defers to the linked one that has it: every claim meets in one round.
  const there = yield* arbiter.elsewhere(op, args);
  if (there !== null) return there;
  const bad: BatonVoiceCallResult = { ok: false, error: "That is not a voice request." };
  const ok = (value: unknown): BatonVoiceCallResult => ({ ok: true, value });
  switch (op) {
    case "arbiter":
      return ok(yield* arbiter.state);
    case "claim": {
      const c = decodeClaim(args);
      return c._tag === "None" ? bad : ok(yield* arbiter.claim(c.value));
    }
    case "speaking":
    case "ended": {
      const d = decodeDevice(args);
      if (d._tag === "None" || (op === "speaking" && d.value.untilMs === undefined)) return bad;
      yield* op === "speaking"
        ? arbiter.speaking(d.value.deviceId, d.value.untilMs!)
        : arbiter.ended(d.value.deviceId);
      return ok(null);
    }
    case "answerFrom": {
      const p = decodePrimary(args);
      if (p._tag === "None") return bad;
      yield* arbiter.setPrimary(p.value.deviceId);
      return ok(
        p.value.deviceId === null
          ? "No device is first now: the nearest one answers."
          : `${p.value.deviceId} answers first when it hears you.`,
      );
    }
    default:
      return null;
  }
});
