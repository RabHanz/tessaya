// @effect-diagnostics globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off globalJsonInEffect:off effectFnOpportunity:off
/**
 * Memory between servers (MEMORY.md section 6), carried by this server on its own clock (GEN-6), not by T3's window.
 * Each paired peer's sync-only credential is kept in the server's secret store, files of mode 0600 like the provider
 * API keys (not encrypted), and goes only to the origin that issued it, never along a redirect.
 */
import {
  BATON_MEMORY_WS_METHODS,
  TessayaMemoryHistorySearchResult,
  TessayaMemorySyncError,
  TessayaMemorySyncHelloResult,
  TessayaMemorySyncPullResult,
  TessayaMemorySyncPushResult,
  type TessayaMemorySyncPeer,
} from "@t3tools/tessaya-contracts";
import { NOT_HERE } from "@t3tools/tessaya-shared/historyIndex";
import type { MemoryChange } from "@t3tools/tessaya-shared/memory";
import { syncOriginAllowed } from "@t3tools/tessaya-shared/syncOrigin";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { TessayaMemoryService } from "./TessayaMemoryService.ts";

const SECRET = "tessaya-memory-sync-peers";
const ENABLED_KEY = "memory_sync";
/** How often this server looks for its own new memories to send (Memory v2 step 4: a write reaches home in seconds). */
const LOOK_EVERY = "15 seconds";
/** A round with nothing new here still pulls what other servers learned, this often. */
const IDLE_ROUND_MS = 2 * 60_000;

/** Whether a sync round is due: something new here to send, or long enough since the last one to pull. */
export const roundDue = (input: { readonly changedHere: boolean; readonly sinceLastMs: number }) =>
  input.changedHere || input.sinceLastMs >= IDLE_ROUND_MS;
const PEER_TIMEOUT_MS = 15_000;
/** Longer than a peer's own history script may run, shorter than the search's whole deadline. */
const HISTORY_PEER_TIMEOUT_MS = 10_000;
export const SYNC_OFF =
  "Memory sync is off on this server, so it does not ask his other servers, and the history index is not here. Turn memory sync on in Memory to search past work.";

/** Where a credential may go, judged on the origin it came from. */
export const originAllowed = (origin: string): boolean => {
  try {
    return syncOriginAllowed(new URL(origin));
  } catch {
    return false;
  }
};

const StoredPeer = Schema.Struct({
  label: Schema.String,
  origin: Schema.String,
  /** Where the peer is reached, with any relay path (T3 Connect); absent, at its origin. */
  baseUrl: Schema.optionalKey(Schema.String),
  token: Schema.String,
  expiresAt: Schema.Number,
});
const StoredPeers = Schema.Record(Schema.String, StoredPeer);
const decodePeers = Schema.decodeUnknownOption(Schema.fromJsonString(StoredPeers));
type StoredPeers = typeof StoredPeers.Type;

/** One server in a sync round: this one through its own service, a peer over HTTPS. None when it did not answer. */
export interface SyncEndpoint {
  readonly id: string;
  readonly hello: Effect.Effect<Option.Option<typeof TessayaMemorySyncHelloResult.Type>>;
  readonly pull: (
    since: string | null,
  ) => Effect.Effect<Option.Option<typeof TessayaMemorySyncPullResult.Type>>;
  readonly push: (input: {
    readonly from: string;
    readonly changes: ReadonlyArray<MemoryChange>;
    readonly upTo: string;
  }) => Effect.Effect<Option.Option<number>>;
}

/** Every server pulls from every other, once per origin, from the cursor it already holds for it. */
export const syncRound = Effect.fn("BatonMemorySync.round")(function* (
  endpoints: ReadonlyArray<SyncEndpoint>,
) {
  const hellos: Array<
    { readonly endpoint: SyncEndpoint } & typeof TessayaMemorySyncHelloResult.Type
  > = [];
  for (const endpoint of endpoints) {
    const hello = yield* endpoint.hello;
    // Two links to the same server count once.
    if (Option.isSome(hello) && !hellos.some((h) => h.origin === hello.value.origin))
      hellos.push({ endpoint, ...hello.value });
  }
  let applied = 0;
  for (const to of hellos) {
    for (const from of hellos) {
      if (to.origin === from.origin) continue;
      const pulled = yield* from.endpoint.pull(to.cursors[from.origin] ?? null);
      if (Option.isNone(pulled)) continue;
      const pushed = yield* to.endpoint.push({
        from: pulled.value.origin,
        changes: pulled.value.changes as ReadonlyArray<MemoryChange>,
        upTo: pulled.value.upTo,
      });
      if (Option.isSome(pushed)) applied += pushed.value;
    }
  }
  return { servers: hellos.length, applied };
});

/**
 * The peer's method under its base URL, keeping a relay's path. The credential goes only back to the origin that
 * issued it, and only where the base URL may receive it.
 */
export const peerUrl = (
  peer: { readonly origin: string; readonly baseUrl?: string | undefined },
  method: string,
): URL | null => {
  try {
    const base = new URL(peer.baseUrl ?? peer.origin);
    const root = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
    if (!syncOriginAllowed(root) || root.origin !== new URL(peer.origin).origin) return null;
    return new URL(`tessaya/desk/${method}`, root);
  } catch {
    return null;
  }
};

export class TessayaMemorySync extends Context.Service<
  TessayaMemorySync,
  {
    readonly state: Effect.Effect<{
      readonly enabled: boolean;
      readonly peers: ReadonlyArray<TessayaMemorySyncPeer>;
    }>;
    readonly setEnabled: (on: boolean) => Effect.Effect<void>;
    readonly addPeer: (
      input: { readonly environmentId: string } & typeof StoredPeer.Type,
    ) => Effect.Effect<void, TessayaMemorySyncError>;
    readonly forget: (environmentId: string) => Effect.Effect<void, TessayaMemorySyncError>;
    /**
     * The first paired peer whose own index found it (`found`), or else a reached peer's own reason; none when no peer
     * answered. With sync off no peer is asked.
     */
    readonly history: (ask: {
      readonly query?: string;
      readonly session?: string;
    }) => Effect.Effect<Option.Option<typeof TessayaMemoryHistorySearchResult.Type>>;
    readonly run: Effect.Effect<{
      readonly servers: number;
      readonly applied: number;
      readonly refused: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
    }>;
  }
>()("t3/tessaya/TessayaMemorySync") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* TessayaMemoryService;

  // Every read-modify-write of the blob holds this, so a pairing during a round is never lost.
  const lock = yield* Semaphore.make(1);
  const unreadable = new TessayaMemorySyncError({
    detail: "This server's sync credentials could not be read, so nothing was changed.",
  });
  /** The stored peers; a read or decode failure is an error, so nothing is written over them. */
  const readPeersStrict = secrets.get(SECRET).pipe(
    Effect.mapError(() => unreadable),
    Effect.flatMap((bytes) =>
      Option.isNone(bytes)
        ? Effect.succeed<StoredPeers>({})
        : Effect.fromOption(decodePeers(new TextDecoder().decode(bytes.value))).pipe(
            Effect.mapError(() => unreadable),
          ),
    ),
  );
  // For showing and syncing only: an unreadable blob syncs nothing, and is never written from here.
  const readPeers = readPeersStrict.pipe(Effect.orElseSucceed((): StoredPeers => ({})));
  const writePeers = (peers: StoredPeers) =>
    secrets.set(SECRET, new TextEncoder().encode(JSON.stringify(peers))).pipe(Effect.orDie);
  const modify = (change: (peers: StoredPeers) => StoredPeers) =>
    lock.withPermits(1)(Effect.flatMap(readPeersStrict, (peers) => writePeers(change(peers))));

  const enabled = sql<{ readonly value: string }>`
    SELECT value FROM fabric_settings WHERE key = ${ENABLED_KEY}
  `.pipe(
    Effect.map((rows) => rows[0]?.value === "on"),
    Effect.orDie,
  );

  const live = (peers: StoredPeers, now: number) =>
    Object.entries(peers).filter(([, peer]) => peer.expiresAt > now);

  const peerCall = (
    environmentId: string,
    peer: typeof StoredPeer.Type,
    refused: Map<string, string>,
    timeoutMs = PEER_TIMEOUT_MS,
  ) =>
    Effect.fn("BatonMemorySync.peerCall")(function* <A>(
      method: string,
      input: unknown,
      schema: Schema.Codec<A, unknown>,
    ) {
      const url = peerUrl(peer, method);
      if (url === null) return Option.none<A>();
      const response = yield* Effect.tryPromise({
        // Interrupted (a race lost, a deadline passed): the request is dropped, not left open.
        try: (interrupted) =>
          fetch(url, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.any([interrupted, AbortSignal.timeout(timeoutMs)]),
            headers: { authorization: `Bearer ${peer.token}`, "content-type": "application/json" },
            body: JSON.stringify(input),
          }),
        catch: () => "unreachable" as const,
      }).pipe(Effect.option);
      if (Option.isNone(response)) return Option.none<A>();
      if (response.value.status === 401 || response.value.status === 403)
        refused.set(environmentId, peer.token);
      if (!response.value.ok) return Option.none<A>();
      const json = yield* Effect.tryPromise({
        try: () => response.value.json() as Promise<{ value?: unknown }>,
        catch: () => "unreadable" as const,
      }).pipe(Effect.option);
      return Option.isNone(json)
        ? Option.none<A>()
        : Schema.decodeUnknownOption(schema)(json.value.value);
    });

  const remote = (
    environmentId: string,
    peer: typeof StoredPeer.Type,
    refused: Map<string, string>,
  ): SyncEndpoint => {
    const call = peerCall(environmentId, peer, refused);
    return {
      id: environmentId,
      hello: call("baton.memory.syncHello", {}, TessayaMemorySyncHelloResult),
      pull: (since) => call("baton.memory.syncPull", { since }, TessayaMemorySyncPullResult),
      push: (input) =>
        call("baton.memory.syncPush", input, TessayaMemorySyncPushResult).pipe(
          Effect.map(Option.map((out) => out.applied)),
        ),
    };
  };

  const self: SyncEndpoint = {
    id: "self",
    hello: Effect.asSome(memory.syncHello),
    pull: (since) => Effect.asSome(memory.changesSince(since)),
    push: (input) => Effect.asSome(memory.applyChanges(input.from, input.changes, input.upTo)),
  };

  const run = Effect.gen(function* () {
    const peers = yield* readPeers;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const refused = new Map<string, string>();
    const round = yield* syncRound([
      self,
      ...live(peers, now).map(([id, peer]) => remote(id, peer, refused)),
    ]);
    // Revoked, or its session ended there: keeping it would only fail again. Read again first, and drop only the
    // credential that was refused, so one he paired again during the round stays.
    if (refused.size > 0) {
      yield* modify((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id, peer]) => refused.get(id) !== peer.token),
        ),
      ).pipe(Effect.ignoreCause({ log: true }));
    }
    return {
      ...round,
      refused: [...refused.keys()].map((environmentId) => ({
        environmentId,
        label: peers[environmentId]?.label ?? environmentId,
      })),
    };
  }).pipe(Effect.withSpan("BatonMemorySync.run"));

  let seenUpTo: string | null = null;
  let lastRoundAt = Number.NEGATIVE_INFINITY;
  yield* Effect.gen(function* () {
    if (!(yield* enabled)) return;
    const fresh = yield* memory.changesSince(seenUpTo);
    const now = yield* Clock.currentTimeMillis;
    // The first look sends everything once; after that only what is new since the last round.
    if (!roundDue({ changedHere: fresh.changes.length > 0, sinceLastMs: now - lastRoundAt }))
      return;
    yield* run;
    seenUpTo = fresh.upTo;
    lastRoundAt = now;
  }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced(LOOK_EVERY)),
    Effect.forkScoped,
  );

  return TessayaMemorySync.of({
    state: Effect.gen(function* () {
      const peers = yield* readPeers;
      return {
        enabled: yield* enabled,
        peers: Object.entries(peers).map(([environmentId, peer]) => ({
          environmentId,
          label: peer.label,
          expiresAt: peer.expiresAt,
        })),
      };
    }),
    setEnabled: (on) =>
      sql`INSERT INTO fabric_settings (key, value) VALUES (${ENABLED_KEY}, ${on ? "on" : "off"})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(Effect.asVoid, Effect.orDie),
    addPeer: ({ environmentId, ...peer }) =>
      originAllowed(peer.origin) && peerUrl(peer, "baton.memory.syncHello") !== null
        ? modify((peers) => ({ ...peers, [environmentId]: peer }))
        : Effect.fail(
            new TessayaMemorySyncError({
              detail:
                "That server's address is not https, this machine or the tailnet, so its credential was not kept.",
            }),
          ),
    forget: (environmentId) =>
      modify((peers) => {
        const { [environmentId]: _gone, ...rest } = peers;
        return rest;
      }),
    history: Effect.fn("BatonMemorySync.history")(function* (ask) {
      if (!(yield* enabled)) return Option.some({ found: false, text: SYNC_OFF });
      const peers = live(yield* readPeers, DateTime.toEpochMillis(yield* DateTime.now));
      if (peers.length === 0) return Option.none();
      const reasons: Array<string> = [];
      // All at once, the first found wins. A refused credential is left for the sync round to drop, so the map is thrown away.
      return yield* Effect.raceAll(
        peers.map(([id, peer]) =>
          peerCall(
            id,
            peer,
            new Map(),
            HISTORY_PEER_TIMEOUT_MS,
          )(BATON_MEMORY_WS_METHODS.historySearch, ask, TessayaMemoryHistorySearchResult).pipe(
            Effect.flatMap((answer) => {
              if (Option.isSome(answer) && answer.value.found) return Effect.succeed(answer);
              // A peer without the index is no answer; one whose index failed says why.
              if (Option.isSome(answer) && answer.value.text !== NOT_HERE)
                reasons.push(answer.value.text);
              return Effect.fail("not found" as const);
            }),
          ),
        ),
      ).pipe(
        Effect.orElseSucceed(() =>
          reasons[0] === undefined
            ? Option.none<typeof TessayaMemoryHistorySearchResult.Type>()
            : Option.some({ found: false, text: reasons[0] }),
        ),
      );
    }),
    run,
  });
});

export const layer = Layer.effect(TessayaMemorySync, make);
