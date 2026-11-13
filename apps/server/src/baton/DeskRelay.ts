// @effect-diagnostics globalDate:off globalJsonInEffect:off preferSchemaOverJson:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off globalFetch:off abortControllerInEffect:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off
/**
 * Placement (b) of SPINE-UNIFY §3: his desk turn runs on the household's home server. This server relays it over the
 * peer link (direct, tailnet or relay: whatever `PeerLinks.resolve` finds now), and runs the home server's calls to
 * the desktop's hands here, by a long poll it makes itself, so the home server needs no link back.
 */
import { readDeskTurn } from "@t3tools/baton-shared/deskTurnStream";
import {
  createHandsBroker,
  publishedSpecs,
  type HandsBroker,
  type HandsCall,
  type HandsResult,
} from "@t3tools/baton-shared/remoteHands";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { RoomToolSet } from "../home/R1Brain.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { DeskTurnBody, deskTurnStream } from "./DeskTurn.ts";
import { TessayaHousehold } from "./TessayaHousehold.ts";

/** What a server sends the home server: his turn, the desktop's offered hands, and the turn's id for its relay. */
export const PeerTurnBody = Schema.Struct({
  ...DeskTurnBody.fields,
  turnId: Schema.String.check(Schema.isMaxLength(80)),
  offered: Schema.Unknown,
});
export type PeerTurnBody = typeof PeerTurnBody.Type;

/**
 * Turns the home server is running for another server, each with the broker its hands calls wait in.
 * shortcut: in memory; a restart drops a turn in progress, which the desktop then answers itself.
 */
const relayed = new Map<string, { readonly broker: HandsBroker; readonly owner: string }>();

/** The home server's end: run the turn here with the desktop's hands reached through the caller's relay. */
export const servePeerTurn = (body: PeerTurnBody, owner: string, tools: RoomToolSet) =>
  Stream.unwrap(
    Effect.sync(() => {
      const broker = createHandsBroker({
        now: () => Date.now(),
        newId: () => globalThis.crypto.randomUUID(),
      });
      broker.publish(publishedSpecs(body.offered) ?? []);
      relayed.set(body.turnId, { broker, owner });
      const { turnId: _turnId, offered: _offered, ...turn } = body;
      // Claude Code's file tools act on this server's files, not his laptop's: never here (placement a only).
      return deskTurnStream(turn, tools, false, broker).pipe(
        Stream.ensuring(Effect.sync(() => relayed.delete(body.turnId))),
      );
    }),
  );

/** The relay's long poll and answers, for the server that owns the turn only. */
export const peerTurnHands = async (
  owner: string,
  path: string,
  json: Readonly<Record<string, unknown>>,
): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> => {
  const turn = relayed.get(String(json["turnId"] ?? ""));
  if (turn === undefined || turn.owner !== owner)
    return { status: 404, json: { message: "No such turn." } };
  if (path === "take") return { status: 200, json: { call: await turn.broker.take(20_000) } };
  if (path === "reply" && typeof json["id"] === "string")
    return turn.broker.reply(json["id"], json["result"] as HandsResult)
      ? { status: 200, json: { ok: true } }
      : { status: 404, json: { message: "No such call." } };
  return { status: 404, json: { message: "No such page." } };
};

/** The household's home server's link, read now: its label is a setting, its address whatever the link finds. */
const homeLink = Effect.gen(function* () {
  const household = yield* Effect.serviceOption(TessayaHousehold);
  const peers = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  if (Option.isNone(household) || Option.isNone(peers)) return null;
  const label = yield* household.value.homeOn;
  if (label === null) return null;
  const links = peers.value;
  if (!(yield* links.enabled)) return null;
  const link = (yield* links.list.pipe(Effect.orElseSucceed(() => []))).find(
    (l) => l.status !== "expired" && l.label === label,
  );
  return link === undefined
    ? null
    : yield* links.resolve(link.environmentId).pipe(Effect.option, Effect.map(Option.getOrNull));
});

/**
 * This server's end: his turn on the home server, her words as they come, and the home server's calls to the desktop
 * run on `hands` here. Null when there is no home server to reach, so the caller runs the turn itself.
 */
export const relayDeskTurn = Effect.fn("DeskRelay.relay")(function* (
  body: DeskTurnBody,
  hands: HandsBroker | null,
) {
  const home = yield* homeLink;
  if (home === null) return null;
  const turnId = globalThis.crypto.randomUUID();
  const post = (path: string, payload: unknown, signal: AbortSignal) =>
    fetch(new URL(path, home.url), {
      method: "POST",
      headers: { authorization: `Bearer ${home.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  return Stream.callback((queue: Queue.Queue<string, unknown>) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      // The home server's calls to the desktop: taken there, run here behind the desktop's own gate, answered there.
      const relayHands = async () => {
        while (!controller.signal.aborted) {
          const taken = await post("/tessaya/peer/turn-hands/take", { turnId }, controller.signal)
            .then((r) => (r.ok ? (r.json() as Promise<{ call?: HandsCall | null }>) : null))
            .catch(() => null);
          if (taken === null) return;
          const call = taken.call ?? null;
          if (call === null) continue;
          const result: HandsResult =
            hands === null
              ? { ok: false, error: "The desktop is not listening." }
              : await hands.call(call.session, call.tool, call.args, call.origin);
          await post(
            "/tessaya/peer/turn-hands/reply",
            { turnId, id: call.id, result },
            controller.signal,
          ).catch(() => undefined);
        }
      };
      void relayHands();
      let spoke = false;
      const ran = yield* Effect.tryPromise({
        try: async (signal) => {
          signal.addEventListener("abort", () => controller.abort());
          const response = await post(
            "/tessaya/peer/turn",
            { ...body, turnId, offered: hands?.published() ?? [] },
            controller.signal,
          );
          if (!response.ok || response.body === null)
            throw new Error(`The home server did not take the turn (${response.status}).`);
          await readDeskTurn(response.body, (words) => {
            spoke = true;
            Queue.offerUnsafe(queue, words);
          });
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.exit);
      controller.abort();
      // Nothing said yet: the caller answers here instead. Mid-answer: she says so, as any turn does.
      if (ran._tag === "Failure" && !spoke) return yield* Queue.fail(queue, ran.cause);
      if (ran._tag === "Failure")
        Queue.offerUnsafe(queue, " Sorry, something went wrong on my side.");
      yield* Queue.end(queue);
    }),
  );
});
