import { assert, describe, it } from "@effect/vitest";
import type { PrivateTurn } from "@t3tools/tessaya-shared/privateMemory";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaMemoryService, layer as memoryLayer } from "./TessayaMemoryService.ts";
import {
  TessayaPrivateMemoryService,
  PrivateCaller,
  PrivateKdf,
  StoreMembership,
  layer as privateLayer,
  make as makePrivate,
} from "./TessayaPrivateMemoryService.ts";

const MARKER = "zebracrossing";
const OWNER_PIN = "27182818";
const SARA_PIN = "314159";

const secretsOf = (seed: number) =>
  Layer.mock(ServerSecretStore)({
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes).fill(seed)),
  });
const fast = Layer.succeed(PrivateKdf, { N: 2 ** 10, r: 8, p: 1 });
// A fresh database for every case: each makes his store and Sara's.
const stack = Layer.mergeAll(privateLayer, memoryLayer).pipe(
  Layer.provide(secretsOf(9)),
  Layer.provideMerge(fast),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const test = <A, E>(name: string, body: () => Effect.Effect<A, E, Layer.Success<typeof stack>>) =>
  it.effect(name, () => Effect.provide(body(), stack));

const desk = { session: "desk", desktop: true } as const;
const phone = { session: "phone", desktop: false } as const;
const saraPhone = { session: "sara-phone", desktop: false, member: "sara" } as const;
const as =
  (who: { readonly session: string; readonly desktop: boolean; readonly member?: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, PrivateCaller, who);

const him: PrivateTurn["speaker"] = {
  kind: "owner",
  personId: "owner",
  verified: true,
  inherited: false,
};
const sara: PrivateTurn["speaker"] = {
  kind: "saved",
  personId: "sara",
  verified: true,
  inherited: false,
};
const turn = (over: Partial<PrivateTurn> = {}): PrivateTurn => ({
  route: "assistant",
  typed: false,
  tainted: false,
  speaker: him,
  ...over,
});

/** Every value in every table of the database, as one string: what a copied file would give away. */
const everything = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  const parts: string[] = [];
  for (const { name } of tables)
    parts.push(JSON.stringify(yield* sql.unsafe(`SELECT * FROM "${name}"`)));
  return parts.join("\n");
});

/** His store and Sara's, both made at the desk, then everything locked. */
const setup = Effect.gen(function* () {
  const p = yield* TessayaPrivateMemoryService;
  const owner = yield* as(desk)(p.setup({ name: "Rab", pin: OWNER_PIN }));
  const saraStore = yield* as(desk)(p.setup({ personId: "sara", name: "Sara", pin: SARA_PIN }));
  yield* as(desk)(p.lock());
  return { p, owner: owner.store.id, sara: saraStore.store.id, recovery: owner.recoveryCode };
});

describe("BatonPrivateMemoryService", () => {
  test("keeps no word of a private memory in clear anywhere in the database", () =>
    Effect.gen(function* () {
      const { p, owner } = yield* setup;
      yield* as(desk)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      yield* as(desk)(p.add(owner, { kind: "fact", text: `Prays at the ${MARKER} mosque` }));
      yield* as(desk)(p.lock());
      // Written to a locked store too: it waits sealed to the store's box key.
      yield* as(desk)(p.remember({ turn: turn({ typed: true }), text: `A second ${MARKER} note` }));
      const dump = yield* everything;
      assert.notInclude(dump, MARKER);
      assert.notInclude(dump, OWNER_PIN);
      // The general store, which syncs, and its search (the MCP tools' door) hold nothing of it either.
      const memory = yield* TessayaMemoryService;
      assert.notInclude(JSON.stringify((yield* memory.changesSince(null)).changes), MARKER);
      assert.lengthOf(yield* memory.search({ text: MARKER }), 0);
      // The locked note moves under the store's key when it is next opened.
      yield* as(desk)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      const items = yield* as(desk)(p.list({ storeId: owner, text: MARKER }));
      assert.lengthOf(items, 2);
      assert.notInclude(yield* everything, MARKER);
    }));

  test("opens with the right PIN or the recovery code, for that device only, and re-locks when idle", () =>
    Effect.gen(function* () {
      const { p, owner, recovery } = yield* setup;
      const wrong = yield* Effect.flip(as(desk)(p.unlock({ storeId: owner, pin: "27182819" })));
      assert.strictEqual(wrong.reason, "That PIN is not right.");
      yield* as(phone)(p.unlock({ storeId: owner, recoveryCode: recovery }));
      // The phone opened it; the desktop has not.
      assert.strictEqual(
        (yield* Effect.flip(as(desk)(p.list({ storeId: owner })))).reason,
        "That store is locked. Open it with its PIN first.",
      );
      assert.lengthOf(yield* as(phone)(p.list({ storeId: owner })), 0);
      yield* TestClock.adjust("5 minutes");
      yield* Effect.flip(as(phone)(p.list({ storeId: owner })));
      const store = (yield* as(phone)(p.people)).find((s) => s.id === owner)!;
      assert.isFalse(store.open);
    }));

  test("waits after five wrong PINs, even for the right one, until the wait ends", () =>
    Effect.gen(function* () {
      const { p, owner } = yield* setup;
      for (let i = 0; i < 5; i++)
        yield* Effect.flip(as(desk)(p.unlock({ storeId: owner, pin: "99999998" })));
      const refused = yield* Effect.flip(as(desk)(p.unlock({ storeId: owner, pin: OWNER_PIN })));
      assert.include(refused.reason, "Too many wrong PINs");
      yield* TestClock.adjust("15 minutes");
      const store = yield* as(desk)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      assert.isTrue(store.open);
      const log = yield* as(desk)(p.audit());
      assert.strictEqual(log.rows.filter((r) => r.outcome === "wrong PIN").length, 5);
      assert.isTrue(log.intact);
    }));

  test("does not open without this server's pepper, even with the right PIN; the recovery code still does", () =>
    Effect.gen(function* () {
      const { owner, recovery } = yield* setup;
      const other = yield* Effect.scoped(
        Effect.gen(function* () {
          const q = yield* makePrivate;
          const refused = yield* Effect.flip(
            as(desk)(q.unlock({ storeId: owner, pin: OWNER_PIN })),
          );
          const opened = yield* as(desk)(q.unlock({ storeId: owner, recoveryCode: recovery }));
          return { refused: refused.reason, opened: opened.open };
        }),
      ).pipe(Effect.provide(secretsOf(3)));
      assert.deepStrictEqual(other, { refused: "That PIN is not right.", opened: true });
    }));

  test("lets him open, read and change anyone's store as admin, logs it in both, and nobody else", () =>
    Effect.gen(function* () {
      const { p, owner, sara: saraId } = yield* setup;
      yield* as(saraPhone)(p.unlock({ storeId: saraId, pin: SARA_PIN }));
      yield* as(saraPhone)(p.add(saraId, { kind: "note", text: "Piano on Thursdays" }));
      // Sara cannot open his store, and without his store open, nobody opens hers without her PIN.
      yield* Effect.flip(as(saraPhone)(p.unlock({ storeId: owner, pin: SARA_PIN })));
      assert.include((yield* Effect.flip(as(phone)(p.unlock({ storeId: saraId })))).reason, "PIN");
      yield* as(phone)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      yield* as(phone)(p.unlock({ storeId: saraId }));
      const read = yield* as(phone)(p.list({ storeId: saraId }));
      assert.deepStrictEqual(
        read.map((i) => i.text),
        ["Piano on Thursdays"],
      );
      const edited = yield* as(phone)(
        p.edit({ storeId: saraId, id: read[0]!.id, text: "Piano on Fridays" }),
      );
      assert.strictEqual(edited.text, "Piano on Fridays");
      const hers = yield* as(saraPhone)(p.audit(saraId));
      assert.isTrue(hers.rows.some((r) => r.action === "read" && r.by === "the owner, as admin"));
      const his = yield* as(phone)(p.audit());
      assert.isTrue(
        his.rows.some((r) => r.storeId === owner && r.action === "read (Sara's store)"),
      );
      // Each line names the member a device acted for; his own lines read as before.
      assert.isTrue(hers.rows.some((r) => r.by === "phone or browser, for sara"));
      assert.isFalse(his.rows.some((r) => r.by.includes(", for owner")));
      // A person cannot see the whole log; he can.
      assert.include((yield* Effect.flip(as(saraPhone)(p.audit()))).reason, "every store");
      assert.isTrue(yield* as(phone)(p.forget(saraId, read[0]!.id)));
    }));

  test("recalls only for the speaker's own store, opened on the desktop, in an untainted turn", () =>
    Effect.gen(function* () {
      const { p, owner, sara: saraId } = yield* setup;
      yield* as(desk)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      yield* as(desk)(p.add(owner, { kind: "fact", text: "Anniversary is in August" }));
      const recall = (t: PrivateTurn, who: typeof desk | typeof phone = desk) =>
        as(who)(p.recall({ turn: t, text: "anniversary" }));
      assert.strictEqual((yield* recall(turn())).count, 1);
      assert.strictEqual((yield* recall(turn({ speaker: null, typed: true }))).whose, "yours");
      for (const t of [
        turn({ speaker: { ...him!, verified: false } }),
        turn({ speaker: { ...him!, inherited: true } }),
        turn({
          speaker: { kind: "unverified", personId: null, verified: false, inherited: false },
        }),
        turn({ speaker: { kind: "guest", personId: null, verified: false, inherited: false } }),
        turn({ typed: true, tainted: true }),
        turn({ route: "standing", typed: true }),
        turn({ route: "phone" }),
        turn({ route: "agent", typed: true }),
        turn({ speaker: sara }),
        turn({ route: "outside", speaker: sara }),
      ])
        assert.strictEqual((yield* recall(t)).count, 0, JSON.stringify(t));
      // Only the desktop's own session feeds the assistant.
      assert.include((yield* Effect.flip(recall(turn(), phone))).reason, "desktop");
      // Opened on the phone does not count for the desktop's assistant.
      yield* as(desk)(p.lock());
      yield* as(phone)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      assert.strictEqual((yield* recall(turn())).count, 0);
      // His store opened as admin is not Sara's turn's store, and recall off keeps it from every model.
      yield* as(desk)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      yield* as(desk)(p.unlock({ storeId: saraId }));
      assert.strictEqual((yield* recall(turn({ route: "outside", speaker: sara }))).count, 0);
      yield* as(desk)(p.setRecall(owner, true));
      assert.strictEqual((yield* recall(turn())).count, 0);
    }));

  test("writes the speaker's private memory into their own store, open or locked, and refuses the rest", () =>
    Effect.gen(function* () {
      const { p, owner, sara: saraId } = yield* setup;
      const remember = (t: PrivateTurn, text: string) => as(desk)(p.remember({ turn: t, text }));
      assert.deepStrictEqual(yield* remember(turn(), "Daughter's birthday is in spring"), {
        stored: true,
        whose: "yours",
        reason: null,
      });
      assert.strictEqual(
        (yield* remember(turn({ route: "outside", speaker: sara }), "Exam on Monday")).whose,
        "Sara",
      );
      assert.isFalse(
        (yield* remember(turn({ typed: true, tainted: true }), "from a web page")).stored,
      );
      assert.isFalse((yield* remember(turn({ speaker: null }), "nobody verified")).stored);
      const secret = yield* Effect.flip(remember(turn(), "my password is hunter22x"));
      assert.include(secret.reason, "password");
      yield* as(desk)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      assert.deepStrictEqual(
        (yield* as(desk)(p.list({ storeId: owner }))).map((i) => i.text),
        ["Daughter's birthday is in spring"],
      );
      yield* as(saraPhone)(p.unlock({ storeId: saraId, pin: SARA_PIN }));
      assert.deepStrictEqual(
        (yield* as(saraPhone)(p.list({ storeId: saraId }))).map((i) => i.text),
        ["Exam on Monday"],
      );
    }));

  test("imports into a locked store once, holds what waits for his yes, and exports only with a fresh PIN", () =>
    Effect.gen(function* () {
      const { p, owner } = yield* setup;
      const items = [
        {
          id: "freya-1",
          draft: {
            kind: "fact" as const,
            text: "Keeps the evening prayers",
            sourceRef: "freya:park/fact/42",
            createdAt: "2026-06-07T16:01:40.000Z",
          },
        },
        {
          id: "freya-2",
          draft: { kind: "fact" as const, text: "A doubtful claim", proposed: true },
        },
      ];
      assert.deepStrictEqual(yield* as(desk)(p.deposit("owner", items)), { added: 2, skipped: 0 });
      assert.deepStrictEqual(yield* as(desk)(p.deposit("owner", items)), { added: 0, skipped: 2 });
      yield* as(desk)(p.unlock({ storeId: owner, pin: OWNER_PIN }));
      const shown = yield* as(desk)(p.list({ storeId: owner }));
      assert.deepStrictEqual(
        shown.map((i) => [i.text, i.sourceRef, i.createdAt, i.source]),
        [["Keeps the evening prayers", "freya:park/fact/42", "2026-06-07T16:01:40.000Z", "import"]],
      );
      const waiting = (yield* as(desk)(p.list({ storeId: owner, includeProposed: true }))).filter(
        (i) => i.proposed,
      );
      assert.lengthOf(waiting, 1);
      yield* as(desk)(p.accept(owner, waiting[0]!.id));
      assert.lengthOf(yield* as(desk)(p.list({ storeId: owner })), 2);
      yield* Effect.flip(as(desk)(p.exportStore({ storeId: owner })));
      assert.include(
        yield* as(desk)(p.exportStore({ storeId: owner, pin: OWNER_PIN })),
        "evening prayers",
      );
    }));

  test("backs up as ciphertext that restores and opens with the recovery code; deletes a person's store when voice ID does", () =>
    Effect.gen(function* () {
      const { p, owner, recovery } = yield* setup;
      yield* as(desk)(p.remember({ turn: turn(), text: `Backed up ${MARKER}` }));
      const dump = yield* as(desk)(p.backup);
      assert.notInclude(dump, MARKER);
      yield* Effect.flip(as(phone)(p.backup));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM tessaya_private_items`;
      yield* sql`DELETE FROM tessaya_private_stores`;
      assert.deepStrictEqual(yield* as(desk)(p.restore(dump)), { stores: 2, items: 1 });
      yield* as(desk)(p.unlock({ storeId: owner, recoveryCode: recovery }));
      assert.strictEqual(
        (yield* as(desk)(p.list({ storeId: owner })))[0]!.text,
        `Backed up ${MARKER}`,
      );
      assert.isTrue(yield* as(desk)(p.personDeleted("sara")));
      assert.deepStrictEqual(
        (yield* as(desk)(p.people)).map((s) => s.personId),
        ["owner"],
      );
    }));

  test("logs nothing of a memory, a PIN or a recovery code, even when a PIN is wrong or a blob is broken", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const logger = Logger.make(({ message }) => void lines.push(JSON.stringify(message)));
      yield* Effect.gen(function* () {
        const { p, owner, recovery } = yield* setup;
        yield* Effect.flip(as(desk)(p.unlock({ storeId: owner, pin: "99999998" })));
        yield* as(desk)(p.unlock({ storeId: owner, recoveryCode: recovery }));
        yield* as(desk)(p.add(owner, { kind: "fact", text: `Logged? ${MARKER}` }));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE tessaya_private_items SET sealed_json = replace(sealed_json, '"tag":"', '"tag":"A')`;
        assert.lengthOf(yield* as(desk)(p.list({ storeId: owner })), 0);
        const failures = yield* Effect.flip(
          as(desk)(p.edit({ storeId: owner, id: "nope", text: MARKER })),
        );
        lines.push(failures.message);
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      const all = lines.join("\n");
      assert.notInclude(all, MARKER);
      assert.notInclude(all, OWNER_PIN);
    }));
});

describe("a member's own store, made when they accept (identity I-1)", () => {
  const maya = { session: "maya-phone", desktop: false, member: "maya" } as const;
  const members = (ids: ReadonlyArray<string>) =>
    Layer.succeed(
      StoreMembership,
      StoreMembership.of({ isMember: (id) => Effect.succeed(ids.includes(id)) }),
    );
  test("is made by the member alone, wrapped to his key, and reaches no one else's", () =>
    Effect.gen(function* () {
      const p = yield* TessayaPrivateMemoryService;
      const owner = yield* as(desk)(p.setup({ name: "Rab", pin: OWNER_PIN }));
      yield* as(desk)(p.lock());
      // Maya makes hers on her phone with his store locked; a stranger can't make one.
      const made = yield* as(maya)(p.setup({ personId: "maya", name: "Maya", pin: SARA_PIN }));
      const stranger = yield* Effect.flip(
        as({ session: "x", desktop: false, member: "ali" })(
          p.setup({ personId: "ali", name: "Ali", pin: SARA_PIN }),
        ),
      );
      assert.include(stranger.reason, "member of this home");
      // Nor can she make anyone else's, his least of all.
      for (const personId of ["owner", "ali"])
        assert.include(
          (yield* Effect.flip(as(maya)(p.setup({ personId, name: "x", pin: OWNER_PIN })))).reason,
          "only your own",
        );
      // She sees only her own; his is not there for her.
      assert.deepStrictEqual(
        (yield* as(maya)(p.people)).map((s) => s.personId),
        ["maya"],
      );
      yield* Effect.flip(as(maya)(p.unlock({ storeId: owner.store.id, pin: OWNER_PIN })));
      // His key opens hers (decision 1's default for his home).
      yield* as(phone)(p.unlock({ storeId: owner.store.id, pin: OWNER_PIN }));
      assert.isTrue((yield* as(phone)(p.unlock({ storeId: made.store.id }))).open);
    }).pipe(Effect.provide(members(["maya"]))));
});
