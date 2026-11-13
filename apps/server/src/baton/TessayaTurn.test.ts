import { privatePersonOf, type SpeakerLike } from "@t3tools/baton-shared/privateMemory";
import type { LearnInput } from "@t3tools/baton-shared/memoryLearning";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonMemoryLearning } from "./BatonMemoryLearning.ts";
import { BatonMemoryService, layer as memoryLayer } from "./BatonMemoryService.ts";
import { BatonPrivateMemoryService } from "./BatonPrivateMemoryService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";
import type { BatonHouseholdCallInput } from "@t3tools/baton-contracts";
import { layer as MemberPreferencesLayer } from "./MemberPreferences.ts";
import {
  NOT_HIS_VOICE_TO_FORGET,
  SessionMember,
  TessayaTurn,
  TurnOrigin,
  layer as turnLayer,
  nameOnceLine,
  originOf,
  turnIdentity,
  type TurnEnvelope,
} from "./TessayaTurn.ts";

const learned: Array<LearnInput> = [];
const recalledFor: Array<SpeakerLike | null> = [];
const setup = () => {
  keptFor.length = 0;
  learned.length = 0;
  recalledFor.length = 0;
};

const learning = Layer.mock(BatonMemoryLearning)({
  learn: (input) =>
    Effect.sync(() => {
      learned.push(input);
      return { stored: 1, held: 0 };
    }),
});
/** What went into a member's own store, by person; "nostore" has none. */
const keptFor: Array<[string, string]> = [];
const stores = Layer.mock(BatonPrivateMemoryService)({
  recall: (input) =>
    Effect.sync(() => {
      recalledFor.push(input.turn.speaker);
      return { block: "private memories (yours): he prays at dawn", count: 1, whose: "yours" };
    }),
  remember: (input) =>
    Effect.sync(() => {
      const who = privatePersonOf(input.turn);
      if ("refused" in who) return { stored: false, whose: null, reason: who.refused };
      if (who.personId === "nostore")
        return {
          stored: false,
          whose: null,
          reason: "There is no private store for this person yet.",
        };
      keptFor.push([who.personId, input.text]);
      return { stored: true, whose: who.personId, reason: null };
    }),
});

const layer = it.layer(
  turnLayer.pipe(
    Layer.provideMerge(MemberPreferencesLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(memoryLayer),
    Layer.provideMerge(learning),
    Layer.provideMerge(stores),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const owner = (speaker: Partial<SpeakerLike> = {}): SpeakerLike => ({
  kind: "owner",
  personId: "owner",
  verified: true,
  inherited: false,
  ...speaker,
});
const device: TurnEnvelope["vessel"] = { kind: "device", id: "desk-1" };
const desktop: TurnEnvelope["vessel"] = { kind: "desktop", id: "laptop" };

it.effect("a turn's tools know which vessel heard it", () =>
  Effect.gen(function* () {
    assert.isNull(yield* TurnOrigin);
    const seen = yield* Effect.provideService(
      TurnOrigin,
      TurnOrigin,
      originOf({ vessel: { kind: "device", id: "desk-1" }, origin: "R1", text: "hi" }),
    );
    assert.deepStrictEqual(seen, {
      kind: "device",
      id: "desk-1",
      label: "R1",
      hisVoice: false,
      speaker: null,
      member: "owner",
      assurance: 0,
      tainted: false,
      persona: null,
      rehearsal: false,
    });
    assert.strictEqual(originOf({ vessel: { kind: "phone", id: "p" }, text: "hi" }).label, "phone");
    // His voice verified on this turn's own audio is his yes (identity A2); carried over or unverified is not.
    const said = (s: Partial<SpeakerLike>) =>
      originOf({
        vessel: device,
        text: "hi",
        speaker: { kind: "owner", personId: null, verified: true, inherited: false, ...s },
      }).hisVoice;
    assert.isTrue(said({}));
    assert.isFalse(said({ inherited: true }));
    assert.isFalse(said({ verified: false }));
    assert.isFalse(said({ kind: "guest" }));
  }),
);

layer("TessayaTurn", (it) => {
  it.effect("what his memories say is coming up this week reaches every vessel", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const turn = yield* TessayaTurn;
      yield* memory.setMeta("timeZone", "UTC");
      yield* memory.add({
        kind: "fact",
        text: "Rumi's birthday is the fifth of January",
        source: "user",
      });
      yield* memory.add({
        kind: "fact",
        text: "Tariq's birthday is the ninth of June",
        source: "user",
      });
      yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
      const soon = yield* turn.comingUp;
      assert.deepStrictEqual(
        soon.filter((c) => c.text.includes("birthday")),
        [
          {
            text: "Rumi's birthday is the fifth of January",
            when: "in 3 days",
            kind: "every year",
          },
        ],
      );
    }),
  );

  it.effect(
    "who's home: a verified voice or a member's own device, never a guess, a guest or a replay",
    () =>
      Effect.gen(function* () {
        const turn = yield* TessayaTurn;
        const heard = (over: Partial<TurnEnvelope>) =>
          turn.begin({ vessel: device, origin: "R1", text: "hi", ...over });
        const hana = { kind: "saved" as const, personId: "hana", verified: true, inherited: false };
        const omid = {
          kind: "saved" as const,
          personId: "omid",
          verified: false,
          inherited: false,
        };
        yield* heard({ speaker: hana });
        yield* heard({ speaker: omid });
        yield* heard({ speaker: { ...hana, personId: "ivo" }, rehearsal: true });
        yield* heard({ speaker: { ...hana, personId: "lev" }, addressed: false });
        yield* turn.begin({
          vessel: { kind: "phone", id: "rosa-phone" },
          text: "hi",
          member: "rosa",
        });
        const now = (yield* turn.whoIsHome).filter((p) =>
          ["hana", "omid", "ivo", "lev", "rosa"].includes(p.member),
        );
        assert.deepStrictEqual(now.map((p) => [p.member, p.via, p.likelyHome]).toSorted(), [
          ["hana", "R1", true],
          ["rosa", "phone rosa-phone", true],
        ]);
        yield* TestClock.adjust("31 minutes");
        assert.isFalse((yield* turn.whoIsHome).find((p) => p.member === "hana")!.likelyHome);
        yield* TestClock.adjust("24 hours");
        assert.isUndefined((yield* turn.whoIsHome).find((p) => p.member === "hana"));
      }),
  );

  it.effect(
    "where the members live on another server, preferences are read and changed there",
    () =>
      Effect.gen(function* () {
        const turn = yield* TessayaTurn;
        const sql = yield* SqlClient.SqlClient;
        const asked: Array<[string, string | null, number]> = [];
        const home = TessayaHousehold.of({
          call: (input: BatonHouseholdCallInput) =>
            Effect.gen(function* () {
              const caller = yield* HouseholdCaller;
              asked.push([input.op, caller.member, caller.assurance]);
              return input.op === "preferences"
                ? { status: "done" as const, line: "", preferences: { units: "imperial" } }
                : caller.assurance < 2
                  ? {
                      status: "refused" as const,
                      line: "I need to be sure it's you to change preferences.",
                    }
                  : { status: "done" as const, line: "Kept.", preferences: { units: "metric" } };
            }),
        } as never);
        yield* sql`INSERT OR REPLACE INTO fabric_settings (key, value) VALUES ('household.home', 'laptop')`;
        const nadia = {
          kind: "saved" as const,
          personId: "nadia",
          verified: true,
          inherited: false,
        };
        const there = <A, E>(work: Effect.Effect<A, E>) =>
          Effect.provideService(work, TessayaHousehold, home);
        const read = yield* there(turn.begin({ vessel: device, text: "hi", speaker: nadia }));
        assert.deepStrictEqual(read.preferences, { units: "imperial" });
        const set = yield* there(
          turn
            .setPreference("units", "metric")
            .pipe(
              Effect.provideService(
                TurnOrigin,
                originOf({ vessel: device, text: "", speaker: nadia }),
              ),
            ),
        );
        assert.deepStrictEqual([set.value, set.line], ["metric", "Kept."]);
        // An unverified voice is refused there, by the home's own rule.
        const unsure = yield* Effect.flip(
          there(
            turn
              .setPreference("units", "metric")
              .pipe(
                Effect.provideService(
                  TurnOrigin,
                  originOf({ vessel: device, text: "", speaker: { ...nadia, verified: false } }),
                ),
              ),
          ),
        );
        assert.include(unsure.reason, "sure it's you");
        assert.deepStrictEqual(asked, [
          ["preferences", "nadia", 2],
          ["setPreference", "nadia", 2],
          ["setPreference", "nadia", 1],
        ]);
        yield* sql`DELETE FROM fabric_settings WHERE key = 'household.home'`;
      }),
  );

  it.effect("a spelled name is kept as spelled, said back once, and taught to her voice", () =>
    Effect.gen(function* () {
      const turn = yield* TessayaTurn;
      const settings = yield* ServerSettingsService;
      // His voice for the memory; a member of her own for the name, so other cases' preferences stay as they were.
      const origin = originOf({ vessel: device, text: "", speaker: owner() });
      const zayd = originOf({
        vessel: device,
        text: "",
        speaker: { kind: "saved", personId: "zayd", verified: true, inherited: false },
      });
      const named = yield* turn
        .setPreference("name", "Zaid, Z-A-Y-D")
        .pipe(Effect.provideService(TurnOrigin, zayd));
      assert.deepStrictEqual([named.value, named.line], ["Zayd", "Kept. Zayd, Z-A-Y-D."]);
      const kept = yield* turn
        .remember("My dentist is Dr Qadri, Q-A-D-R-I")
        .pipe(Effect.provideService(TurnOrigin, origin));
      assert.strictEqual(kept.line, "Kept. Qadri, Q-A-D-R-I.");
      const memory = yield* BatonMemoryService;
      assert.isTrue(
        (yield* memory.list({ limit: 500 })).some((i) => i.text === "My dentist is Dr Qadri"),
      );
      // Heard as "Zaid", written "Zayd": her voice learns to say it as heard; "Qadri" was heard right.
      assert.deepStrictEqual((yield* settings.getSettings).voicePronounce, { Zayd: "Zaid" });
    }),
  );

  it.effect(
    "several people in one turn: each answered from their own, nothing private, no leak between them",
    () =>
      Effect.gen(function* () {
        setup();
        const turn = yield* TessayaTurn;
        const sara = { kind: "saved" as const, personId: "sara", verified: true, inherited: false };
        const omar = { kind: "saved" as const, personId: "omar", verified: true, inherited: false };
        const setFor = (speaker: SpeakerLike, key: string, value: string) =>
          turn
            .setPreference(key, value)
            .pipe(
              Effect.provideService(TurnOrigin, originOf({ vessel: device, text: "", speaker })),
            );
        yield* setFor(sara, "units", "metric");
        yield* setFor(sara, "name", "Sar");
        yield* setFor(omar, "units", "imperial");
        const [hers, his, owners] = yield* turn.beginMany([
          { vessel: device, text: "how hot is it", speaker: sara },
          { vessel: device, text: "start a timer", speaker: omar },
          { vessel: device, text: "when do I pray", speaker: owner() },
        ]);
        assert.deepStrictEqual(hers!.preferences, { units: "metric", name: "Sar" });
        assert.deepStrictEqual(his!.preferences, { units: "imperial" });
        assert.strictEqual(hers!.who.name, "Sar");
        // Cross-speaker leak: none of Sara's in Omar's context, and nothing private for anyone, his own included.
        assert.notInclude(JSON.stringify(his), "metric");
        assert.notInclude(JSON.stringify(his), "Sar");
        assert.deepStrictEqual(
          [hers!.privateBlock, his!.privateBlock, owners!.privateBlock],
          ["", "", ""],
        );
        assert.lengthOf(recalledFor, 0);
        assert.notStrictEqual(hers!.conversation.key, his!.conversation.key);
        // One voice alone is a turn as before: his private memories are read.
        assert.include(
          (yield* turn.beginMany([
            { vessel: device, text: "when do I pray", speaker: owner() },
          ]))[0]!.privateBlock,
          "prays",
        );
      }),
  );

  it.effect("each member keeps their own preferences, read in their turns and nobody else's", () =>
    Effect.gen(function* () {
      const turn = yield* TessayaTurn;
      const sara = { kind: "saved" as const, personId: "sara", verified: true, inherited: false };
      const as =
        (speaker: SpeakerLike | null) =>
        <A, E>(work: Effect.Effect<A, E>) =>
          Effect.provideService(work, TurnOrigin, originOf({ vessel: device, text: "", speaker }));
      yield* as(sara)(turn.setPreference("units", "metric"));
      yield* as(sara)(turn.setPreference("name", "Sar"));
      yield* as(owner())(turn.setPreference("timeFormat", "12-hour with AM/PM"));
      const hers = yield* turn.begin({ vessel: device, text: "hi", speaker: sara });
      const his = yield* turn.begin({ vessel: device, text: "hi", speaker: owner() });
      assert.deepStrictEqual(hers.preferences, { units: "metric", name: "Sar" });
      assert.deepStrictEqual(his.preferences, { timeFormat: "12-hour with AM/PM" });
      // A guest has none, and cannot set any.
      const guest = owner({ kind: "guest", personId: null });
      assert.deepStrictEqual(
        (yield* turn.begin({ vessel: device, text: "hi", speaker: guest })).preferences,
        {},
      );
      const refused = yield* Effect.flip(
        turn
          .setPreference("units", "imperial")
          .pipe(
            Effect.provideService(
              TurnOrigin,
              originOf({ vessel: device, text: "", speaker: guest }),
            ),
          ),
      );
      assert.include(refused.reason, "household");
      // Cleared with nothing; an unknown key is refused.
      yield* as(sara)(turn.setPreference("name", null));
      assert.deepStrictEqual(
        (yield* turn.begin({ vessel: device, text: "hi", speaker: sara })).preferences,
        { units: "metric" },
      );
      assert.include(
        (yield* Effect.flip(turn.setPreference("shoeSize", "9"))).reason,
        "no preference",
      );
    }),
  );

  it.effect("another member's 'remember this' goes to their own store, never his", () =>
    Effect.gen(function* () {
      setup();
      const memory = yield* BatonMemoryService;
      const turn = yield* TessayaTurn;
      const before = (yield* memory.list({ limit: 500 })).length;
      const at = (over: Partial<TurnEnvelope>) =>
        originOf({ vessel: device, origin: "R1", text: "", ...over });
      const sara = { kind: "saved" as const, personId: "sara", verified: true, inherited: false };
      // Her verified voice in the room, and her own phone typing.
      const spoken = yield* turn
        .remember("My exam is on Friday")
        .pipe(Effect.provideService(TurnOrigin, at({ speaker: sara })));
      const typed = yield* turn
        .remember("Netball moved to Thursdays")
        .pipe(
          Effect.provideService(
            TurnOrigin,
            originOf({ vessel: { kind: "phone", id: "sara-phone" }, text: "", member: "sara" }),
          ),
        );
      assert.deepStrictEqual([spoken.kept, typed.kept], ["theirs", "theirs"]);
      assert.deepStrictEqual(keptFor, [
        ["sara", "My exam is on Friday"],
        ["sara", "Netball moved to Thursdays"],
      ]);
      // None of it reached his memory.
      assert.lengthOf(yield* memory.list({ limit: 500 }), before);
      // A member with no store yet is told so, and nothing is kept anywhere.
      const none = yield* Effect.flip(
        turn
          .remember("Pick me up at six")
          .pipe(
            Effect.provideService(
              TurnOrigin,
              originOf({ vessel: { kind: "phone", id: "p2" }, text: "", member: "nostore" }),
            ),
          ),
      );
      assert.include(none.reason, "no private store");
      assert.lengthOf(keptFor, 2);
    }),
  );

  it.effect(
    "a member's own device types as that member: kept apart and never teaching his memory",
    () =>
      Effect.gen(function* () {
        setup();
        const turn = yield* TessayaTurn;
        const phone: TurnEnvelope["vessel"] = { kind: "phone", id: "sara-phone" };
        const asSara = <A, E>(work: Effect.Effect<A, E>) =>
          Effect.provideService(work, SessionMember, "sara");
        yield* TestClock.adjust("11 minutes");
        const kept = yield* asSara(
          turn.end(
            { vessel: phone, text: "remember my exam is on Friday" },
            { reply: "Good luck." },
          ),
        );
        assert.isNull(kept);
        assert.lengthOf(learned, 0);
        const hers = yield* asSara(turn.begin({ vessel: phone, text: "and then?" }));
        assert.strictEqual(hers.conversation.key, "person:sara");
        assert.lengthOf(hers.conversation.turns, 2);
        // The owner's household conversation never saw it.
        const his = yield* turn.begin({ vessel: desktop, text: "and then?" });
        assert.notInclude(his.conversation.turns.map((t) => t.content).join(" "), "exam");
        assert.strictEqual(turnIdentity({ vessel: phone, member: "sara" }).member, "sara");
      }),
  );

  it.effect("every vessel gets the same memory for the same words and persona", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const turn = yield* TessayaTurn;
      // A preference is standing memory; the facts are found by what is said.
      yield* memory.add({ kind: "preference", text: "He takes his coffee black", source: "user" });
      for (const text of [
        "The plumber is coming on Thursday at nine",
        "Bin day is Tuesday morning",
      ])
        yield* memory.add({ kind: "fact", text, source: "user" });
      const said = "when is the plumber coming, and how do I take my coffee";
      const viaDesktop = yield* turn.begin({ vessel: desktop, text: said });
      // A device has no session holding standing memory, so it also carries the standing block.
      const viaDevice = yield* turn.begin({ vessel: device, text: said, sessionless: true });
      assert.deepStrictEqual(viaDevice.ids, viaDesktop.ids);
      assert.deepStrictEqual(viaDesktop.ids, (yield* memory.recall({ text: said })).ids);
      assert.isAbove(viaDesktop.ids.length, 0);
      // Standing and the sentence both hold the coffee: the device's block says it once.
      assert.lengthOf(viaDevice.block.split("coffee black"), 2);
      assert.include(viaDesktop.block, "coffee black");
    }),
  );

  it.effect("reads private memories only when this turn's own voice was verified as his", () =>
    Effect.gen(function* () {
      setup();
      const turn = yield* TessayaTurn;
      const read = (speaker: SpeakerLike | null, tainted = false) =>
        Effect.map(
          turn.begin({ vessel: device, text: "when do I pray", speaker, tainted }),
          (c) => c.privateBlock,
        );
      for (const speaker of [
        null,
        owner({ verified: false }),
        owner({ inherited: true }),
        owner({ kind: "guest", personId: null }),
        owner({ kind: "saved", personId: "p1" }),
      ])
        assert.strictEqual(yield* read(speaker), "");
      assert.strictEqual(yield* read(owner(), true), "");
      assert.lengthOf(recalledFor, 0);
      assert.include(yield* read(owner()), "he prays at dawn");
      assert.lengthOf(recalledFor, 1);
    }),
  );

  it.effect("learns only from a turn said to her, by him, that was not a rehearsal", () =>
    Effect.gen(function* () {
      setup();
      const turn = yield* TessayaTurn;
      const end = (envelope: Partial<TurnEnvelope>) =>
        Effect.map(
          turn.end(
            { vessel: device, text: "remember the boiler code is in the drawer", ...envelope },
            { reply: "Noted." },
          ),
          (r) => r !== null,
        );
      assert.isFalse(yield* end({ addressed: false }));
      assert.isFalse(yield* end({ rehearsal: true }));
      assert.isFalse(yield* end({ speaker: owner({ kind: "guest", personId: null }) }));
      assert.isFalse(yield* end({ speaker: owner({ kind: "saved", personId: "p1" }) }));
      assert.lengthOf(learned, 0);
      // Absent counts as said to her until every vessel sends it.
      assert.isTrue(yield* end({ persona: "alfred", turnRef: "t9" }));
      assert.isTrue(yield* end({ speaker: owner(), addressed: true, tainted: true }));
      assert.deepStrictEqual(
        learned.map((l) => [l.sourceRef, l.agent, l.tainted]),
        [
          ["vessel:device:desk-1:t9", "alfred", false],
          ["vessel:device:desk-1", undefined, true],
        ],
      );
    }),
  );

  it.effect(
    "remember keeps his verified words as his, an unknown voice's as told, an agent's for his yes, and no guest's",
    () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        const turn = yield* TessayaTurn;
        const on = (speaker: SpeakerLike | null, rehearsal = false) =>
          originOf({ vessel: device, origin: "R1", text: "", speaker, rehearsal });
        const as = <A, E>(origin: ReturnType<typeof on>, work: Effect.Effect<A, E>) =>
          Effect.provideService(work, TurnOrigin, origin);
        const his = yield* as(on(owner()), turn.remember("The spare key is under the blue pot"));
        const told = yield* as(on(null), turn.remember("The gate code changes every month"));
        const agent = yield* turn.remember("He prefers window seats on flights");
        const dry = yield* as(on(owner(), true), turn.remember("Nothing to keep here at all"));
        const guest = yield* Effect.flip(
          as(on(owner({ kind: "guest", personId: null })), turn.remember("Buy me a pony")),
        );
        assert.deepStrictEqual(
          [his.kept, told.kept, agent.kept, dry.kept],
          ["his", "noted", "held", "rehearsal"],
        );
        assert.include(guest.reason, "only keep things");
        const items = yield* memory.list({ includeProposed: true, limit: 50 } as never);
        const byText = (t: string) => items.find((i) => i.text.startsWith(t));
        assert.strictEqual(byText("The spare key")?.source, "user");
        assert.strictEqual(byText("The gate code")?.source, "thread");
        assert.isTrue(byText("He prefers window")?.proposed);
        assert.isUndefined(byText("Nothing to keep"));
        assert.isUndefined(byText("Buy me"));

        // What he asked to keep stands in every later turn on a device, even from a voice not yet verified (13 Nov, 10:35).
        const next = yield* as(
          on(null),
          turn.begin({ vessel: device, text: "what time is it", sessionless: true }),
        );
        assert.include(next.block, "The gate code changes every month");

        // Forget: only his verified voice; anyone else is told where he can.
        const id = his.id!;
        const refused = yield* as(on(null), turn.forget(id));
        assert.strictEqual(refused, NOT_HIS_VOICE_TO_FORGET);
        assert.isDefined((yield* memory.list({ limit: 50 })).find((i) => i.id === id));
        assert.strictEqual(yield* as(on(owner()), turn.forget(id)), "Forgotten.");
        assert.isUndefined((yield* memory.list({ limit: 50 })).find((i) => i.id === id));

        // About: the closest memories, his own words marked.
        const about = yield* turn.about("gate code");
        assert.include(about[0]!.line, "The gate code changes every month");
      }),
  );

  it.effect(
    "one conversation per person or household, continued on whichever vessel answers next",
    () =>
      Effect.gen(function* () {
        const turn = yield* TessayaTurn;
        const said = (
          vessel: TurnEnvelope["vessel"],
          text: string,
          over: Partial<TurnEnvelope> = {},
        ) => turn.end({ vessel, text, ...over }, { reply: `About ${text}.` });
        const heard = (over: Partial<TurnEnvelope> = {}) =>
          Effect.map(turn.begin({ vessel: device, text: "and then?", ...over }), (c) =>
            c.conversation.turns.map((t) => `${t.vessel} ${t.role}: ${t.content}`),
          );
        // Earlier cases in this layer spoke too; a quiet spell first, so this one starts afresh.
        yield* TestClock.adjust("11 minutes");
        yield* said(desktop, "the shop deploy");
        // Not said to her, or a rehearsal: never part of the conversation.
        yield* said(desktop, "the television", { addressed: false });
        yield* said(device, "a replay", { rehearsal: true });
        assert.deepStrictEqual(yield* heard(), [
          "laptop user: the shop deploy",
          "laptop assistant: About the shop deploy.",
        ]);
        // His verified voice has its own conversation; the household's stays apart from it.
        yield* said(device, "my private plans", { speaker: owner() });
        assert.lengthOf(yield* heard({ speaker: owner() }), 2);
        assert.notInclude((yield* heard()).join(" "), "private plans");
        // A conversation the arbiter names is the one continued.
        yield* said(device, "the kitchen timer", { conversation: "arbiter:k1" });
        assert.lengthOf(yield* heard({ conversation: "arbiter:k1" }), 2);
        // After a quiet spell she starts afresh.
        yield* TestClock.adjust("11 minutes");
        assert.deepStrictEqual(yield* heard(), []);
      }),
  );
});

/** A server with its own database and turn pipeline; it lives as long as the test's scope. */
const home = Layer.build(
  turnLayer.pipe(
    Layer.provideMerge(MemberPreferencesLayer),
    Layer.provideMerge(memoryLayer),
    Layer.provideMerge(learning),
    Layer.provideMerge(stores),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
).pipe(
  Effect.map((context) => ({
    memory: Context.get(context, BatonMemoryService),
    turn: Context.get(context, TessayaTurn),
  })),
);

it.effect(
  "said to a device on one server, recalled on the desktop's after a sync (cross-vessel)",
  () =>
    Effect.gen(function* () {
      const r1Server = yield* home;
      const laptopServer = yield* home;
      yield* r1Server.turn
        .remember("The boiler service is booked for the twelfth")
        .pipe(
          Effect.provideService(TurnOrigin, originOf({ vessel: device, origin: "R1", text: "" })),
        );
      const before = yield* laptopServer.turn.begin({
        vessel: desktop,
        text: "when is the boiler service",
      });
      assert.notInclude(before.block, "boiler service is booked");
      // One sync round, as BatonMemorySync runs within seconds of a write.
      const hello = yield* laptopServer.memory.syncHello;
      const pulled = yield* r1Server.memory.changesSince(
        hello.cursors[r1Server.memory.origin] ?? null,
      );
      yield* laptopServer.memory.applyChanges(pulled.origin, pulled.changes, pulled.upTo);
      const after = yield* laptopServer.turn.begin({
        vessel: desktop,
        text: "when is the boiler service",
      });
      assert.include(after.block, "boiler service is booked for the twelfth");
    }),
);

it("carries who the turn is from and how sure, beside hisVoice and the speaker (identity I-2)", () => {
  const room = { kind: "device" as const, id: "kitchen" };
  const voice = (kind: SpeakerLike["kind"], verified: boolean, personId: string | null) => ({
    kind,
    personId,
    verified,
    inherited: false,
    confidence: 0.71,
  });
  const of = (turn: TurnEnvelope) => {
    const o = originOf(turn);
    return [o.member, o.assurance, o.hisVoice];
  };
  assert.deepStrictEqual(of({ vessel: room, text: "hi", speaker: voice("owner", true, "owner") }), [
    "owner",
    2,
    true,
  ]);
  assert.deepStrictEqual(of({ vessel: room, text: "hi", speaker: voice("saved", true, "sara") }), [
    "sara",
    2,
    false,
  ]);
  assert.deepStrictEqual(of({ vessel: room, text: "hi", speaker: voice("saved", false, "sara") }), [
    "sara",
    1,
    false,
  ]);
  assert.deepStrictEqual(of({ vessel: room, text: "hi", speaker: voice("guest", false, null) }), [
    null,
    0,
    false,
  ]);
  // Typed on his desktop: his own signed-in device. An agent's turn names him but proves nothing.
  assert.deepStrictEqual(of({ vessel: { kind: "desktop", id: "desktop" }, text: "hi" }), [
    "owner",
    2,
    false,
  ]);
  assert.deepStrictEqual(of({ vessel: { kind: "mcp", id: "agent" }, text: "hi" }), [
    "owner",
    0,
    false,
  ]);
  assert.strictEqual(originOf({ vessel: room, text: "hi", tainted: true }).tainted, true);
});

it("tells the brain a newly recognised speaker's name once, and nothing otherwise", () => {
  assert.include(nameOnceLine("Maya"), "it is Maya");
  assert.include(nameOnceLine("Maya"), "not again");
  assert.strictEqual(nameOnceLine(undefined), "");
  assert.strictEqual(nameOnceLine("  "), "");
});
