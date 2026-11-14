import { assert, it } from "@effect/vitest";
import type { MemberRole } from "@t3tools/tessaya-shared/household";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaRecordService, layer as recordLayer } from "./TessayaRecordService.ts";
import { TessayaComms, layer as commsLayer } from "./TessayaComms.ts";
import { HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";
import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { HomeDevices } from "../home/HomeDevices.ts";
import { TurnOrigin } from "./TessayaTurn.ts";

/** A pretend house: an R1 in the kitchen and the owner's desktop, which takes notes; what each was sent. */
const house = () => {
  const said: Array<{ id: string; op: string; text?: string }> = [];
  const written: Array<{ id: string; value: unknown }> = [];
  const device = (
    deviceId: string,
    kind: string,
    items: ReadonlyArray<string> = [],
    member?: string,
  ) => ({
    deviceId,
    kind,
    name: deviceId,
    firmware: null,
    via: kind === "r1" ? ("mqtt" as const) : ("client" as const),
    ...(member === undefined ? {} : { member }),
    online: true,
    lastSeenAt: null,
    version: null,
    items: items.map((id) => ({
      id,
      label: id,
      type: "action",
      access: "write",
      safety: "free" as const,
    })),
    values: [],
  });
  const devices = [
    device("r1-kitchen", "r1"),
    device("desk-1", "desktop", ["comms.note"]),
    device("desk-sara", "desktop", ["comms.note"], "sara"),
  ];
  const registry = DeviceRegistry.of({
    list: Effect.succeed(devices),
    get: (id: string) => Effect.succeed(devices.find((d) => d.deviceId === id) ?? null),
    write: (id: string, _item: string, value: unknown) =>
      Effect.sync(() => {
        written.push({ id, value });
        return { status: "sent" as const, line: "" };
      }),
  } as never);
  const homeDevices = HomeDevices.of({
    command: (id: string, c: { op: string; text?: string }) =>
      Effect.sync(() => {
        said.push({ id, op: c.op, ...(c.text === undefined ? {} : { text: c.text }) });
        return { status: "done" as const, line: "" };
      }),
  } as never);
  const inHouse = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(DeviceRegistry, registry),
      Effect.provideService(HomeDevices, homeDevices),
    );
  return { said, written, inHouse };
};

const MEMBERS: Readonly<Record<string, { role: MemberRole; name: string }>> = {
  owner: { role: "owner", name: "Omid" },
  sara: { role: "adult", name: "Sara" },
  maya: { role: "child", name: "Maya" },
  gus: { role: "guest", name: "Gus" },
};
const household = Layer.succeed(
  TessayaHousehold,
  TessayaHousehold.of({
    grantsOf: (member: string) =>
      Effect.succeed(MEMBERS[member] === undefined ? null : { ...MEMBERS[member], machine: false }),
    call: () =>
      Effect.succeed({
        status: "done" as const,
        line: "",
        members: Object.entries(MEMBERS).map(([id, m]) => ({ id, ...m, state: "active" })),
      }),
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
/** Comms is off until the owner turns it on. */
const on = comms("owner", { op: "settings", enabled: true });

const commsRows = Effect.flatMap(TessayaRecordService, (r) => r.query({ kind: "comms" }));

layer("TessayaComms", (it) => {
  it.effect("sends a note to a person, who sees it in their inbox and nobody else does", () =>
    Effect.gen(function* () {
      yield* on;
      const sent = yield* comms("owner", {
        op: "send",
        to: ["person:sara"],
        kind: "text",
        text: "Running late 🚗",
      });
      assert.strictEqual(sent.status, "done");
      assert.strictEqual(sent.note?.fromLabel, "Omid");
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
      yield* on;
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
      yield* on;
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
      yield* on;
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
      yield* on;
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
      yield* on;
      yield* comms("sara", { op: "send", to: ["person:maya"], kind: "text", text: "between us" });
      const owner = (yield* comms("owner", { op: "log" })).notes ?? [];
      const theirs = owner.find((n) => n.from === "sara" && n.to.includes("person:maya"));
      assert.isDefined(theirs);
      assert.strictEqual(theirs?.text, "");
      const maya = (yield* comms("maya", { op: "log" })).notes ?? [];
      assert.isTrue(maya.some((n) => n.text === "between us"));
    }),
  );

  it.effect("sends nothing while comms is off, and only the owner turns it on", () =>
    Effect.gen(function* () {
      yield* comms("owner", { op: "settings", enabled: false });
      const off = yield* comms("owner", { op: "send", to: ["all"], kind: "text", text: "hi" });
      assert.strictEqual(off.status, "refused");
      assert.strictEqual(
        (yield* comms("sara", { op: "settings", enabled: true })).status,
        "refused",
      );
      const back = yield* comms("owner", { op: "settings", enabled: true });
      assert.isTrue(back.settings?.enabled);
    }),
  );

  it.effect("plays an announcement on the R1 and puts the card on the owner's desktop", () =>
    Effect.gen(function* () {
      yield* on;
      const h = house();
      const sent = yield* comms("sara", {
        op: "send",
        to: ["all"],
        kind: "announce",
        text: "The car's here",
      }).pipe(h.inHouse);
      assert.deepStrictEqual(sent.delivered, ["r1-kitchen", "desk-1"]);
      assert.deepStrictEqual(
        h.said.map((x) => `${x.id} ${x.op}${x.text === undefined ? "" : ` ${x.text}`}`),
        ["r1-kitchen eye", "r1-kitchen say From Sara: The car's here"],
      );
      assert.deepStrictEqual(
        h.written.map((w) => `${w.id} ${(w.value as { id: string }).id}`),
        [`desk-1 ${sent.note?.id}`],
      );
    }),
  );

  it.effect("sends nothing anywhere for a replay, and says so", () =>
    Effect.gen(function* () {
      yield* on;
      const h = house();
      const sent = yield* comms("sara", {
        op: "send",
        to: ["all"],
        kind: "announce",
        text: "x",
      }).pipe(
        h.inHouse,
        Effect.provideService(TurnOrigin, {
          kind: "device",
          id: "replay-1",
          label: "R1",
          rehearsal: true,
        }),
      );
      assert.match(sent.line, /replay/);
      assert.deepStrictEqual(h.written, []);
      assert.isTrue(h.said.every((x) => x.op === "eye" || x.op === "say"));
      const inbox = yield* comms("owner", { op: "inbox" });
      assert.isFalse((inbox.notes ?? []).some((n) => n.id === sent.note?.id));
    }),
  );

  it.effect("holds a note for someone it can't reach and tells them once when they're back", () =>
    Effect.gen(function* () {
      yield* on;
      const sent = yield* comms("owner", {
        op: "send",
        to: ["person:maya"],
        kind: "text",
        text: "Call me",
      });
      assert.match(sent.line, /waits for Maya/);
      const service = yield* TessayaComms;
      // Earlier tests left notes for Maya too: each sender is counted once, then nothing is told again.
      const told = yield* service.waitingFor("maya", "r1-kitchen");
      assert.isTrue(told.some((w) => w.from === "Omid" && w.count >= 1));
      assert.deepStrictEqual(yield* service.waitingFor("maya", "r1-kitchen"), []);
    }),
  );

  it.effect(
    "shows a private note only as existing to an unsure voice, and plays it to a sure one",
    () =>
      Effect.gen(function* () {
        yield* on;
        const sent = yield* comms("owner", {
          op: "send",
          to: ["person:sara"],
          kind: "text",
          text: "the code is 4321",
          private: true,
        });
        const unsure = yield* Effect.flatMap(TessayaComms, (c) => c.call({ op: "inbox" })).pipe(
          Effect.provideService(HouseholdCaller, { member: "sara", assurance: 1, via: "R1" }),
        );
        const seen = (unsure.notes ?? []).find((n) => n.id === sent.note?.id);
        assert.strictEqual(seen?.text, "");
        const refusedPlay = yield* Effect.flatMap(TessayaComms, (c) =>
          c.call({ op: "play", noteId: sent.note!.id }),
        ).pipe(Effect.provideService(HouseholdCaller, { member: "sara", assurance: 1, via: "R1" }));
        assert.strictEqual(refusedPlay.status, "refused");
        const played = yield* comms("sara", { op: "play", noteId: sent.note!.id });
        assert.match(played.line, /4321/);
      }),
  );

  it.effect("keeps a member's do-not-disturb until it ends, and turns it off", () =>
    Effect.gen(function* () {
      const on1 = yield* comms("sara", { op: "dnd", until: "2099-01-01T00:00:00.000Z" });
      assert.strictEqual(on1.settings?.dndUntil, "2099-01-01T00:00:00.000Z");
      const past = yield* comms("sara", { op: "dnd", until: "1969-12-31T00:00:00.000Z" });
      assert.strictEqual(past.status, "refused");
      yield* comms("sara", { op: "dnd", until: null });
      assert.isNull((yield* comms("sara", { op: "settings" })).settings?.dndUntil);
    }),
  );

  it.effect(
    "sounds an owner's emergency everywhere through quiet hours until each person says okay",
    () =>
      Effect.gen(function* () {
        const fire = {
          id: "fire",
          label: "Fire",
          text: "Fire: get out now",
          who: "any" as const,
          children: false,
          automations: false,
        };
        assert.strictEqual(
          (yield* comms("sara", { op: "emergencyKinds", kinds: [fire] })).status,
          "refused",
        );
        yield* comms("owner", { op: "emergencyKinds", kinds: [fire] });
        yield* comms("owner", {
          op: "settings",
          quietHours: { from: "00:00", to: "23:59", timeZone: "UTC" },
        });
        assert.strictEqual(
          (yield* comms("gus", { op: "emergency", kind: "fire" })).status,
          "refused",
        );
        const h = house();
        const sounding = yield* comms("maya", { op: "emergency", kind: "fire" }).pipe(h.inHouse);
        assert.strictEqual(sounding.status, "done");
        // Children's vessels are left out of this kind; the adults and the owner must answer.
        assert.deepStrictEqual([...(sounding.emergency?.pending ?? [])].toSorted(), [
          "owner",
          "sara",
        ]);
        const says = () => h.said.filter((x) => x.op === "say").length;
        assert.strictEqual(says(), 1);
        assert.strictEqual(
          (yield* comms("sara", { op: "emergency", kind: "fire" })).status,
          "refused",
        );
        yield* TestClock.adjust("20 seconds");
        assert.strictEqual(says(), 2);
        yield* comms("sara", { op: "emergencyAck" });
        yield* TestClock.adjust("20 seconds");
        assert.strictEqual(says(), 3);
        const last = yield* comms("owner", { op: "emergencyAck" });
        assert.match(last.line, /stopped/);
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(says(), 3);
        // Rate-limited: not again within two minutes.
        assert.strictEqual(
          (yield* comms("owner", { op: "emergency", kind: "fire" })).status,
          "refused",
        );
        yield* comms("owner", { op: "settings", quietHours: null });
      }),
  );

  it.effect(
    "stops everywhere on a false alarm, which a child can't call on someone else's alarm",
    () =>
      Effect.gen(function* () {
        const drill = {
          id: "drill",
          label: "Drill",
          text: "This is a drill",
          who: "adults" as const,
          children: true,
          automations: true,
        };
        yield* comms("owner", { op: "emergencyKinds", kinds: [drill] });
        assert.strictEqual(
          (yield* comms("maya", { op: "emergency", kind: "drill" })).status,
          "refused",
        );
        const h = house();
        // An automation (Home Assistant through an agent token) may set off a kind open to automations.
        const auto = yield* Effect.flatMap(TessayaComms, (c) =>
          c.call({ op: "emergency", kind: "drill" }),
        ).pipe(
          Effect.provideService(HouseholdCaller, {
            member: "owner",
            service: true,
            assurance: 0,
            via: "an agent",
          }),
          h.inHouse,
        );
        assert.strictEqual(auto.status, "done");
        assert.strictEqual((yield* comms("maya", { op: "emergencyCancel" })).status, "refused");
        const stopped = yield* comms("sara", { op: "emergencyCancel" }).pipe(h.inHouse);
        assert.match(stopped.line, /false alarm/);
        const before = h.said.filter((x) => x.op === "say").length;
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(h.said.filter((x) => x.op === "say").length, before);
        assert.isNull((yield* comms("owner", { op: "settings" })).emergency ?? null);
      }),
  );

  it.effect("puts a member's note on their own desktop, never on someone else's", () =>
    Effect.gen(function* () {
      yield* on;
      const h = house();
      const sent = yield* comms("owner", {
        op: "send",
        to: ["person:sara"],
        kind: "text",
        text: "Dinner at eight",
      }).pipe(h.inHouse);
      assert.deepStrictEqual(sent.delivered, ["desk-sara"]);
      assert.deepStrictEqual(
        h.written.map((w) => w.id),
        ["desk-sara"],
      );
    }),
  );
});
