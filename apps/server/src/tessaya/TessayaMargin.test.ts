// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off preferSchemaOverJson:off
import * as NodeHttp from "node:http";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { TessayaHousehold } from "./TessayaHousehold.ts";
import {
  MARGIN_TOKEN_SECRET,
  TessayaMargin,
  layerWith,
  type MarginActor,
} from "./TessayaMargin.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { type RecordAppend, TessayaRecordService } from "./TessayaRecordService.ts";

const TOKEN = "margin_test_token";

/** The Margin's MCP as far as these tests need: bearer check, a session, and tool calls answered as JSON. */
const startMarginMock = () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = NodeHttp.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end(JSON.stringify({ error: "bad token" }));
        return;
      }
      const msg = JSON.parse(body) as { id?: number; method: string; params?: any };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        msg.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "the-margin" } }
          : (() => {
              calls.push({ name: msg.params.name, args: msg.params.arguments });
              return msg.params.name === "complete_card"
                ? {
                    isError: true,
                    content: [{ type: "text", text: '{"message":"No such card."}' }],
                  }
                : { content: [{ type: "text", text: JSON.stringify({ ok: msg.params.name }) }] };
            })();
      res
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  const url = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    }),
  );
  return { calls, url, close: () => server.close() };
};

const setup = (token: string | null = TOKEN) => {
  const mock = startMarginMock();
  const rows: RecordAppend[] = [];
  const cards: Array<{ id: string; detail: string }> = [];
  const secrets = Layer.succeed(
    ServerSecretStore,
    ServerSecretStore.of({
      get: (name) =>
        Effect.succeed(
          name === MARGIN_TOKEN_SECRET && token !== null
            ? Option.some(new TextEncoder().encode(`${token}\n`))
            : Option.none(),
        ),
      set: () => Effect.void,
      create: () => Effect.void,
      remove: () => Effect.void,
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );
  const record = Layer.succeed(TessayaRecordService, {
    append: (entry: RecordAppend) => Effect.sync(() => void rows.push(entry)),
  } as unknown as TessayaRecordService["Service"]);
  const inbox = Layer.succeed(TessayaPhoneInbox, {
    mirror: (card: (typeof cards)[number]) => Effect.sync(() => void cards.push(card)),
  } as unknown as TessayaPhoneInbox["Service"]);
  const household = Layer.succeed(TessayaHousehold, {
    homeOn: Effect.succeed(null),
  } as unknown as TessayaHousehold["Service"]);
  const layer = Layer.unwrap(
    Effect.map(
      Effect.promise(() => mock.url),
      layerWith,
    ),
  ).pipe(Layer.provide(Layer.mergeAll(secrets, record, household)));
  const run = <A>(body: (m: TessayaMargin["Service"]) => Effect.Effect<A>) =>
    Effect.flatMap(TessayaMargin, body).pipe(
      Effect.provide(Layer.merge(layer, inbox)),
      Effect.ensuring(Effect.sync(mock.close)),
    );
  return { run, calls: mock.calls, rows, cards };
};

const owner: MarginActor = { member: "owner", via: "Tessel", rehearsal: false };
const guest: MarginActor = { member: null, via: "Tessel", rehearsal: false };

it.live(
  "reads and ticks through The Margin, and only what the lists allow, each a margin Record row",
  () => {
    const t = setup();
    return t.run((m) =>
      Effect.gen(function* () {
        const week = yield* m.read(owner, "get_my_week", { date_from: "2026-11-28" });
        assert.strictEqual(week.status, "ok");
        assert.deepStrictEqual(week.data, { ok: "get_my_week" });
        // Never a delete, and never a write passed off as a read.
        assert.strictEqual(
          (yield* m.write(owner, "delete_card", { card_id: "c1" }, "tidy")).status,
          "refused",
        );
        assert.strictEqual((yield* m.read(owner, "add_shopping_item", {})).status, "refused");
        // His own things are his; the home's shopping list is anyone's at home.
        assert.strictEqual((yield* m.read(guest, "list_reminders", {})).status, "refused");
        const milk = yield* m.write(
          guest,
          "add_shopping_item",
          { name: "milk" },
          "he asked for milk",
        );
        assert.strictEqual(milk.status, "ok");
        // The Margin's own refusal comes back in its words.
        const card = yield* m.write(owner, "complete_card", { card_id: "c9" }, "done");
        assert.deepStrictEqual([card.status, card.line], ["refused", "No such card."]);
        assert.deepStrictEqual(
          t.calls.map((c) => c.name),
          ["get_my_week", "add_shopping_item", "complete_card"],
        );
        const added = t.calls[1]!.args;
        assert.strictEqual(added["reason"], "he asked for milk");
        assert.match(String(added["idempotency_key"]), /^tessaya:/);
        assert.deepStrictEqual(
          t.rows.map((r) => [r.kind, r.subject, r.outcome]),
          [
            ["margin", "read get_my_week", "ok"],
            ["margin", "write add_shopping_item", "ok"],
            ["margin", "write complete_card", "refused"],
          ],
        );
      }),
    );
  },
);

it.live("a replay's write and a missing token never reach The Margin", () => {
  const t = setup(null);
  return t.run((m) =>
    Effect.gen(function* () {
      const replay = yield* m.write(
        { ...owner, rehearsal: true },
        "capture",
        { text: "x" },
        "test",
      );
      assert.include(replay.line, "a replay");
      const none = yield* m.read(owner, "list_reminders", {});
      assert.strictEqual(none.status, "error");
      assert.include(none.line, "not connected");
      assert.strictEqual(t.calls.length, 0);
    }),
  );
});

it.live("a push with nowhere to say it becomes a card on his phone, and is recorded", () => {
  const t = setup();
  return t.run((m) =>
    Effect.gen(function* () {
      const out = yield* m.announce({ text: "Call the dentist", priority: "normal", id: "card-7" });
      assert.strictEqual(out.status, "carded");
      assert.deepStrictEqual(
        t.cards.map((c) => [c.id, c.detail]),
        [["margin-card-7", "Call the dentist"]],
      );
      assert.deepStrictEqual(
        t.rows.map((r) => [r.kind, r.subject, r.outcome]),
        [["margin", "push reminder", "carded"]],
      );
    }),
  );
});
