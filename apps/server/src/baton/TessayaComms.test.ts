import { assert, it } from "@effect/vitest";
import type { MemberRole } from "@t3tools/baton-shared/household";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonRecordService, layer as recordLayer } from "./BatonRecordService.ts";
import { TessayaComms, layer as commsLayer } from "./TessayaComms.ts";
import { HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";

const MEMBERS: Readonly<Record<string, { role: MemberRole; name: string }>> = {
  owner: { role: "owner", name: "Rabee" },
  sara: { role: "adult", name: "Sara" },
  maya: { role: "child", name: "Maya" },
  gus: { role: "guest", name: "Gus" },
};
const household = Layer.succeed(
  TessayaHousehold,
  TessayaHousehold.of({
    grantsOf: (member: string) =>
      Effect.succeed(MEMBERS[member] === undefined ? null : { ...MEMBERS[member], machine: false }),
  } as never),
);

const layer = it.layer(
  commsLayer.pipe(
    Layer.provideMerge(household),
    Layer.provideMerge(recordLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const as =
  (member: string | null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, HouseholdCaller, {
      member,
      assurance: 2,
      via: "test",
    });

const comms = (member: string | null, input: Parameters<TessayaComms["Service"]["call"]>[0]) =>
  Effect.flatMap(TessayaComms, (c) => c.call(input)).pipe(as(member));

const commsRows = Effect.flatMap(BatonRecordService, (r) => r.query({ kind: "comms" }));

layer("TessayaComms", (it) => {
  it.effect("sends a note to a person, who sees it in their inbox and nobody else does", () =>
    Effect.gen(function* () {
      const sent = yield* comms("owner", {
        op: "send",
        to: ["person:sara"],
        kind: "text",
        text: "Running late 🚗",
      });
      assert.strictEqual(sent.status, "done");
      assert.strictEqual(sent.note?.fromLabel, "Rabee");
      assert.deepStrictEqual(sent.note?.forms.glance, { emoji: "🚗", words: "Running late" });
      const sara = yield* comms("sara", { op: "inbox" });
      assert.isTrue((sara.notes ?? []).some((n) => n.id === sent.note?.id));
      assert.isFalse(
        ((yield* comms("maya", { op: "inbox" })).notes ?? []).some((n) => n.id === sent.note?.id),
      );
    }),
  );

  it.effect("delivers a group note by role and a note to all to every member but a guest", () =>
    Effect.gen(function* () {
      yield* comms("owner", { op: "send", to: ["group:kids"], kind: "announce", text: "Dinner" });
      yield* comms("owner", { op: "send", to: ["all"], kind: "announce", text: "Car's here" });
      const texts = (who: string) =>
        Effect.map(comms(who, { op: "inbox" }), (r) =>
          (r.notes ?? []).map((n) => n.text).filter((t) => t === "Dinner" || t === "Car's here"),
        );
      assert.deepStrictEqual(yield* texts("maya"), ["Car's here", "Dinner"]);
      assert.deepStrictEqual(yield* texts("sara"), ["Car's here"]);
      assert.deepStrictEqual(yield* texts("gus"), []);
    }),
  );

  it.effect("refuses a guest's send and keeps a child's urgent from overriding quiet hours", () =>
    Effect.gen(function* () {
      const guest = yield* comms("gus", { op: "send", to: ["all"], kind: "text", text: "hi" });
      assert.strictEqual(guest.status, "refused");
      const stranger = yield* comms("nobody", {
        op: "send",
        to: ["all"],
        kind: "text",
        text: "hi",
      });
      assert.strictEqual(stranger.status, "refused");
      const child = yield* comms("maya", {
        op: "send",
        to: ["person:owner"],
        kind: "text",
        text: "come now",
        urgency: "urgent",
      });
      assert.strictEqual(child.note?.urgency, "soon");
    }),
  );

  it.effect("writes exactly one Record row per act, and never the note's words", () =>
    Effect.gen(function* () {
      const before = (yield* commsRows).length;
      const sent = yield* comms("owner", {
        op: "send",
        to: ["person:sara"],
        kind: "text",
        text: "the secret word is papaya",
        private: true,
      });
      yield* comms("sara", { op: "react", noteId: sent.note!.id, emoji: "❤️" });
      yield* comms("sara", {
        op: "consentSet",
        target: "person:sara",
        caller: "owner",
        state: "allow",
      });
      // Reads are not acts.
      yield* comms("sara", { op: "inbox" });
      yield* comms("sara", { op: "consents" });
      yield* comms("sara", { op: "log" });
      const rows = yield* commsRows;
      assert.strictEqual(rows.length - before, 3);
      assert.isFalse(JSON.stringify(rows).includes("papaya"));
    }),
  );

  it.effect("lets a reaction reach the sender only on a note the reactor can see", () =>
    Effect.gen(function* () {
      const sent = yield* comms("owner", {
        op: "send",
        to: ["person:sara"],
        kind: "text",
        text: "ok?",
      });
      const hidden = yield* comms("maya", { op: "react", noteId: sent.note!.id, emoji: "👍" });
      assert.strictEqual(hidden.status, "refused");
      const reacted = yield* comms("sara", { op: "react", noteId: sent.note!.id, emoji: "👍" });
      assert.deepStrictEqual(reacted.note?.to, ["person:owner"]);
      assert.strictEqual(reacted.note?.replyTo, sent.note!.id);
    }),
  );

  it.effect(
    "sets drop-in consent only for the person it protects or the owner, with a way back",
    () =>
      Effect.gen(function* () {
        const other = yield* comms("sara", {
          op: "consentSet",
          target: "person:maya",
          caller: "sara",
          state: "allow",
        });
        assert.strictEqual(other.status, "refused");
        const child = yield* comms("maya", {
          op: "consentSet",
          target: "person:maya",
          caller: "sara",
          state: "allow",
        });
        assert.strictEqual(child.status, "refused");
        const room = yield* comms("sara", {
          op: "consentSet",
          target: "room:nursery",
          caller: "sara",
          state: "allow",
        });
        assert.strictEqual(room.status, "refused");
        yield* comms("owner", {
          op: "consentSet",
          target: "room:nursery",
          caller: "sara",
          state: "allow",
        });
        yield* comms("owner", {
          op: "consentSet",
          target: "room:nursery",
          caller: "sara",
          state: "knock",
        });
        const listed = (yield* comms("sara", { op: "consents" })).consents ?? [];
        assert.deepStrictEqual(
          listed.filter((c) => c.target === "room:nursery").map((c) => c.state),
          ["knock"],
        );
      }),
  );

  it.effect("shows the owner everyone's log as metadata only", () =>
    Effect.gen(function* () {
      yield* comms("sara", { op: "send", to: ["person:maya"], kind: "text", text: "between us" });
      const owner = (yield* comms("owner", { op: "log" })).notes ?? [];
      const theirs = owner.find((n) => n.from === "sara" && n.to.includes("person:maya"));
      assert.isDefined(theirs);
      assert.strictEqual(theirs?.text, "");
      const maya = (yield* comms("maya", { op: "log" })).notes ?? [];
      assert.isTrue(maya.some((n) => n.text === "between us"));
    }),
  );
});
