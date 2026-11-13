// @effect-diagnostics nodeBuiltinImport:off globalJson:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonMemoryService } from "./BatonMemoryService.ts";
import {
  BatonMemorySync,
  layer,
  roundDue,
  SYNC_OFF,
  peerUrl,
  syncRound,
  type SyncEndpoint,
} from "./BatonMemorySync.ts";

/** A server holding its own changes by time, and the newest change it has applied from each peer. */
const server = (id: string, origin: string) => {
  const own: Array<{ readonly at: string }> = [];
  const applied: Record<string, string> = {};
  const endpoint: SyncEndpoint = {
    id,
    hello: Effect.sync(() => Option.some({ origin, cursors: { ...applied } })),
    pull: (since) =>
      Effect.sync(() =>
        Option.some({
          origin,
          changes: own.filter((c) => since === null || c.at > since) as never,
          upTo: own.at(-1)?.at ?? "",
        }),
      ),
    push: (input) =>
      Effect.sync(() => {
        if (input.upTo !== "") applied[input.from] = input.upTo;
        return Option.some(input.changes.length);
      }),
  };
  return { endpoint, own, applied };
};
const change = (at: string) => ({ at });

it.effect(
  "carries each server's changes to every other once, from the cursor it holds, and counts one server once",
  () =>
    Effect.gen(function* () {
      const here = server("self", "https://laptop");
      const box = server("box", "https://box");
      const sameBox = server("box-again", "https://box");
      box.own.push(change("2026-11-07T10:00:00Z"), change("2026-11-07T11:00:00Z"));
      here.own.push(change("2026-11-07T10:30:00Z"));
      const first = yield* syncRound([here.endpoint, box.endpoint, sameBox.endpoint]);
      assert.deepStrictEqual(first, { servers: 2, applied: 3 });
      assert.strictEqual(here.applied["https://box"], "2026-11-07T11:00:00Z");
      // The cursor holds: nothing new from the box is carried again.
      const second = yield* syncRound([here.endpoint, box.endpoint]);
      assert.strictEqual(second.applied, 0);
    }),
);

it("sends a credential only to the origin that issued it, under a relay's path when it has one", () => {
  const origin = "https://box.example:8443";
  assert.strictEqual(
    peerUrl({ origin }, "baton.memory.syncPull")?.href,
    "https://box.example:8443/tessaya/desk/baton.memory.syncPull",
  );
  assert.strictEqual(
    peerUrl(
      { origin: "https://relay.t3.codes", baseUrl: "https://relay.t3.codes/e/abc123" },
      "baton.memory.syncPull",
    )?.href,
    "https://relay.t3.codes/e/abc123/tessaya/desk/baton.memory.syncPull",
  );
  // A base URL on another origin than the one that issued the credential is refused.
  assert.isNull(
    peerUrl({ origin: "https://relay.t3.codes", baseUrl: "https://elsewhere.example/e/1" }, "x"),
  );
  assert.isNull(peerUrl({ origin: "http://box.example" }, "baton.memory.syncPull"));
  assert.isNull(peerUrl({ origin: "not a url" }, "baton.memory.syncPull"));
});

const stored = new Map<string, Uint8Array>();
const secrets = Layer.mock(ServerSecretStore)({
  get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
  set: (name, value) => Effect.sync(() => void stored.set(name, value)),
});
const memory = Layer.mock(BatonMemoryService)({
  origin: "https://laptop",
  syncHello: Effect.succeed({ origin: "https://laptop", cursors: {} }),
});

it.effect("keeps a peer's credential in the secret store, and shows it without its token", () =>
  Effect.gen(function* () {
    const sync = yield* BatonMemorySync;
    yield* sync.addPeer({
      environmentId: "box",
      label: "Server",
      origin: "https://box.example",
      token: "sync-token",
      expiresAt: 10_000,
    });
    yield* sync.setEnabled(true);
    const state = yield* sync.state;
    assert.deepStrictEqual(state, {
      enabled: true,
      peers: [{ environmentId: "box", label: "Server", expiresAt: 10_000 }],
    });
    assert.include(new TextDecoder().decode(stored.get("tessaya-memory-sync-peers")), "sync-token");
    yield* sync.forget("box");
    assert.deepStrictEqual((yield* sync.state).peers, []);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(Layer.mergeAll(secrets, memory)),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);

const serviceLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(secrets, memory)),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const blob = () => new TextDecoder().decode(stored.get("tessaya-memory-sync-peers"));
const peer = (origin: string, token = "sync-token") => ({
  label: "Server",
  origin,
  token,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

it.effect("keeps a credential only for https, this machine or the tailnet", () =>
  Effect.gen(function* () {
    const sync = yield* BatonMemorySync;
    const refused = yield* Effect.flip(
      sync.addPeer({ environmentId: "far", ...peer("http://box.example") }),
    );
    assert.include(refused.detail, "not https");
    // Built from octets: an address inside the tailnet block.
    const tailnet = [100, 100, 1, 2].join(".");
    yield* sync.addPeer({ environmentId: "tail", ...peer(`http://${tailnet}:3773`) });
    yield* sync.addPeer({ environmentId: "here", ...peer("http://127.0.0.1:3773") });
    assert.notInclude(blob(), "box.example");
    assert.include(blob(), tailnet);
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("never writes over credentials it cannot read", () =>
  Effect.gen(function* () {
    const sync = yield* BatonMemorySync;
    stored.set("tessaya-memory-sync-peers", new TextEncoder().encode("not json"));
    yield* Effect.flip(sync.addPeer({ environmentId: "box", ...peer("https://box.example") }));
    yield* Effect.flip(sync.forget("box"));
    assert.strictEqual(blob(), "not json");
    stored.delete("tessaya-memory-sync-peers");
  }).pipe(Effect.provide(serviceLayer)),
);

it.live("drops only the credential a peer refused, not one paired again during the round", () =>
  Effect.gen(function* () {
    const sync = yield* BatonMemorySync;
    stored.delete("tessaya-memory-sync-peers");
    const server = NodeHttp.createServer((_request, response) => {
      // He pairs the box again while the round is out: its stored token changes before the refusal lands.
      const now = JSON.parse(blob()) as Record<string, { token: string }>;
      now["box"] = { ...now["box"]!, token: "new-token" };
      stored.set("tessaya-memory-sync-peers", new TextEncoder().encode(JSON.stringify(now)));
      response.writeHead(401).end();
    });
    yield* Effect.callback<void>(
      (resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void)),
    );
    const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
    yield* sync.addPeer({ environmentId: "box", ...peer(origin, "old-token") });
    yield* sync.addPeer({ environmentId: "gone", ...peer(origin, "gone-token") });
    const round = yield* sync.run;
    server.close();
    assert.sameMembers(
      round.refused.map((r) => r.environmentId),
      ["box", "gone"],
    );
    const left = JSON.parse(blob()) as Record<string, { token: string }>;
    assert.deepStrictEqual(Object.keys(left), ["box"]);
    assert.strictEqual(left["box"]?.token, "new-token");
  }).pipe(Effect.provide(serviceLayer)),
);

it.live(
  "searches past work on every paired peer at once and takes the first found, past one that hangs; off asks none",
  () =>
    Effect.gen(function* () {
      const sync = yield* BatonMemorySync;
      stored.delete("tessaya-memory-sync-peers");
      const seen: Array<string> = [];
      const server = NodeHttp.createServer((request, response) => {
        const token = request.headers.authorization ?? "";
        seen.push(`${request.url} ${token}`);
        if (token === "Bearer hangs") return;
        const found = token === "Bearer with-index";
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ value: { found, text: found ? "the hits" : "its index failed" } }));
      });
      yield* Effect.callback<void>(
        (resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void)),
      );
      const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
      yield* sync.setEnabled(true);
      assert.isTrue(Option.isNone(yield* sync.history({ query: "pricing" })));
      yield* sync.addPeer({ environmentId: "slow", ...peer(origin, "hangs") });
      yield* sync.addPeer({ environmentId: "a", ...peer(origin, "no-index") });
      yield* sync.addPeer({ environmentId: "b", ...peer(origin, "with-index") });
      assert.deepStrictEqual(
        yield* sync.history({ query: "pricing" }),
        Option.some({ found: true, text: "the hits" }),
      );
      assert.sameMembers(
        seen,
        ["hangs", "no-index", "with-index"].map(
          (t) => `/tessaya/desk/baton.memory.historySearch Bearer ${t}`,
        ),
      );
      // None found: a reached peer's own reason comes back.
      yield* sync.forget("slow");
      yield* sync.forget("b");
      assert.deepStrictEqual(
        yield* sync.history({ query: "pricing" }),
        Option.some({ found: false, text: "its index failed" }),
      );
      // Off means off: no peer is asked, and the answer says why.
      seen.length = 0;
      yield* sync.setEnabled(false);
      assert.deepStrictEqual(
        yield* sync.history({ query: "pricing" }),
        Option.some({ found: false, text: SYNC_OFF }),
      );
      assert.deepStrictEqual(seen, []);
      server.closeAllConnections();
      server.close();
      stored.delete("tessaya-memory-sync-peers");
    }).pipe(Effect.provide(serviceLayer)),
);

it("sends a new memory at the next look, and otherwise pulls from the other servers every two minutes", () => {
  assert.isTrue(roundDue({ changedHere: true, sinceLastMs: 15_000 }));
  assert.isFalse(roundDue({ changedHere: false, sinceLastMs: 15_000 }));
  assert.isTrue(roundDue({ changedHere: false, sinceLastMs: 120_000 }));
  // The first look after start: nothing has run yet.
  assert.isTrue(roundDue({ changedHere: false, sinceLastMs: Number.POSITIVE_INFINITY }));
});
