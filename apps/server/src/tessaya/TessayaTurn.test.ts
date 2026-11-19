import { privatePersonOf, type SpeakerLike } from "@t3tools/tessaya-shared/privateMemory";
import type { LearnInput } from "@t3tools/tessaya-shared/memoryLearning";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { onAction } from "../provenance/ActionLog.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaMemoryLearning } from "./TessayaMemoryLearning.ts";
import {
  MemoryViewer,
  TessayaMemoryService,
  layer as memoryLayer,
} from "./TessayaMemoryService.ts";
import { TessayaPrivateMemoryService } from "./TessayaPrivateMemoryService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";
import type {
  TessayaHouseholdCallInput,
  DeviceItem,
  RegisteredDevice,
} from "@t3tools/tessaya-contracts";
import { layer as MemberPreferencesLayer } from "./MemberPreferences.ts";
import { TurnLiveContext, layer as liveLayer } from "./TurnLiveContext.ts";
import { TessayaUnderstanding } from "./TessayaUnderstanding.ts";
import { TessayaCast } from "./TessayaCast.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import {
  NOT_HIS_VOICE_TO_FORGET,
  boardLine,
  hereLine,
  SessionMember,
  TessayaTurn,
  TurnOrigin,
  layer as turnLayer,
  make as makeTurn,
  topicMoved,
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

const learning = Layer.mock(TessayaMemoryLearning)({
  learn: (input) =>
    Effect.sync(() => {
      learned.push(input);
      return { stored: 1, held: 0 };
    }),
});
/** What went into a member's own store, by person; "nostore" has none. */
const keptFor: Array<[string, string]> = [];
const stores = Layer.mock(TessayaPrivateMemoryService)({
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

/** The bodies a hand-off was asked to wear: "dead-1" refuses, as a body this server cannot move would. */
const castCalls: Array<{ body: string; persona: string; visitOk: boolean | undefined }> = [];
const cast = Layer.mock(TessayaCast)({
  touch: () => Effect.void,
  call: (input, _verified, visitOk) =>
    input.op === "call" && input.body === "dead-1"
      ? Effect.fail("That Tessel is not linked to this server.")
      : Effect.sync(() => {
          if (input.op === "call")
            castCalls.push({ body: input.body, persona: input.persona, visitOk });
          return { personas: [], bodies: [] };
        }),
});

const layer = it.layer(
  turnLayer.pipe(
    Layer.provideMerge(cast),
    Layer.provideMerge(MemberPreferencesLayer),
    Layer.provideMerge(liveLayer),
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
      const memory = yield* TessayaMemoryService;
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
        soon.filter((c) => c.text.includes("birthday")).map(({ at: _at, ...c }) => c),
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
        // The household's device signal, asked as the caller: Rosa's phone is also connected, Tom's only devices are.
        const devices = TessayaHousehold.of({
          call: (input: TessayaHouseholdCallInput) =>
            Effect.succeed(
              input.op === "home"
                ? {
                    status: "done" as const,
                    line: "",
                    around: [
                      { id: "rosa", name: "Rosa", connected: 1, minutesAgo: 0 },
                      { id: "tom", name: "Tom", connected: 0, minutesAgo: 9 },
                    ],
                  }
                : { status: "done" as const, line: "" },
            ),
        } as never);
        const who = Effect.map(
          Effect.provideService(turn.whoIsHome, TessayaHousehold, devices),
          (all) =>
            all.filter((p) => ["hana", "omid", "ivo", "lev", "rosa", "tom"].includes(p.member)),
        );
        assert.deepStrictEqual(
          (yield* who)
            .map((p) => [p.member, p.heard?.via ?? null, p.devices, p.likelyHome])
            .toSorted(),
          [
            ["hana", "desk-1", null, true],
            ["rosa", "rosa-phone", { connected: 1, minutesAgo: 0 }, true],
            ["tom", null, { connected: 0, minutesAgo: 9 }, false],
          ],
        );
        // Her voice places her at the vessel she spoke on; Rosa's typing places her at her phone.
        const now = yield* who;
        assert.strictEqual(now.find((p) => p.member === "hana")?.nearest?.vessel, "desk-1");
        assert.strictEqual(now.find((p) => p.member === "rosa")?.nearest?.vessel, "rosa-phone");
        yield* TestClock.adjust("31 minutes");
        const later = yield* who;
        assert.isFalse(later.find((p) => p.member === "hana")!.likelyHome);
        // A connected device keeps her likely home after her voice goes quiet.
        assert.isTrue(later.find((p) => p.member === "rosa")!.likelyHome);
        yield* TestClock.adjust("24 hours");
        assert.isUndefined((yield* who).find((p) => p.member === "hana"));
      }),
  );

  it.effect(
    "a guest's voiceprint goes to the people graph as nobody, and her line for them comes back",
    () =>
      Effect.gen(function* () {
        const turn = yield* TessayaTurn;
        const observed: Array<[string, string | null]> = [];
        const home = TessayaHousehold.of({
          call: (input: TessayaHouseholdCallInput) =>
            Effect.gen(function* () {
              observed.push([input.op, (yield* HouseholdCaller).member]);
              return input.op === "peopleObserve"
                ? {
                    status: "done" as const,
                    line: "",
                    person: {
                      id: "p1",
                      name: "Ali",
                      status: "guest" as const,
                      recognised: true,
                      line: "You know this voice: it is Ali.",
                    },
                  }
                : { status: "done" as const, line: "" };
            }),
        } as never);
        const print = { model: "m1", vector: "AAAAAA==", ms: 3_000 };
        const guest = { kind: "guest" as const, personId: null, verified: false, inherited: false };
        const there = <A, E>(work: Effect.Effect<A, E>) =>
          Effect.provideService(work, TessayaHousehold, home);
        const heard = yield* there(
          turn.begin({ vessel: device, text: "hi", speaker: guest, print }),
        );
        assert.include(heard.block, "it is Ali");
        assert.deepStrictEqual([heard.who.person, heard.who.name], ["p1", "Ali"]);
        assert.deepInclude(observed, ["peopleObserve", null]);
        // His voice, and a replay, never file a print.
        observed.length = 0;
        const him = { kind: "owner" as const, personId: "owner", verified: true, inherited: false };
        yield* there(turn.begin({ vessel: device, text: "hi", speaker: him, print }));
        yield* there(
          turn.begin({ vessel: device, text: "hi", speaker: guest, print, rehearsal: true }),
        );
        assert.notDeepInclude(observed, ["peopleObserve", null]);
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
          call: (input: TessayaHouseholdCallInput) =>
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

  it.effect(
    "only the owner forgets what she understands of herself, and a member only their own facts",
    () =>
      Effect.gen(function* () {
        const turn = yield* TessayaTurn;
        const reached: Array<string> = [];
        const understanding = TessayaUnderstanding.of({
          current: () => Effect.succeed(null),
          evidence: () => Effect.void,
          forget: (subject, _fact, options) =>
            Effect.sync(() => {
              reached.push(
                `${subject.about === "self" ? "self" : subject.id}:${options.actor.kind}:${options.confirmed === true}`,
              );
              return { status: "done", line: "Forgotten." } as const;
            }),
          restore: (subject) =>
            Effect.sync(() => {
              reached.push(`${subject.about === "self" ? "self" : subject.id}:restore`);
              return { status: "done", line: "Put back." } as const;
            }),
        });
        const as = (speaker: SpeakerLike, about: "them" | "herself", restore = false) =>
          turn
            .understandingFact({ fact: "hates football", about, confirmed: true, restore })
            .pipe(
              Effect.provideService(TurnOrigin, originOf({ vessel: device, text: "", speaker })),
              Effect.provideService(TessayaUnderstanding, understanding),
            );
        const zayd: SpeakerLike = {
          kind: "saved",
          personId: "zayd",
          verified: true,
          inherited: false,
        };
        const refused = "I can change that only when I know it's your voice.";

        assert.strictEqual(yield* as(owner(), "herself"), "Forgotten.");
        assert.strictEqual(yield* as(owner(), "them"), "Forgotten.");
        assert.strictEqual(yield* as(zayd, "them"), "Forgotten.");
        assert.strictEqual(yield* as(zayd, "them", true), "Put back.");
        // Nobody else's: not a member on how she sees herself, nor a carried-over, unverified or guest voice.
        assert.strictEqual(yield* as(zayd, "herself"), refused);
        assert.strictEqual(yield* as(owner({ inherited: true }), "herself"), refused);
        assert.strictEqual(yield* as(owner({ verified: false }), "them"), refused);
        assert.strictEqual(
          yield* as({ kind: "guest", personId: null, verified: true, inherited: false }, "them"),
          refused,
        );
        assert.deepStrictEqual(reached, [
          "self:owner:true",
          "owner:owner:true",
          "zayd:member:true",
          "zayd:restore",
        ]);
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
      const memory = yield* TessayaMemoryService;
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
      const memory = yield* TessayaMemoryService;
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

  it.effect(
    "one persona talking to two people at once holds two live threads, closed when each goes quiet",
    () =>
      Effect.gen(function* () {
        const turn = yield* TessayaTurn;
        const him = owner();
        const maya = owner({ kind: "saved", personId: "maya" });
        const phone: TurnEnvelope["vessel"] = { kind: "phone", id: "p" };
        yield* Effect.all(
          [
            turn.begin({ vessel: device, persona: "operations", speaker: him, text: "lights off" }),
            turn.begin({
              vessel: phone,
              persona: "operations",
              speaker: maya,
              text: "what's for dinner",
            }),
          ],
          { concurrency: "unbounded" },
        );
        yield* TestClock.adjust("1 minute");
        const next = yield* turn.begin({
          vessel: desktop,
          persona: "operations",
          speaker: him,
          text: "and the fan",
        });
        // CS2: his turn sees her other live conversation, never what was said in it; Maya's sees only a count.
        assert.include(next.block, "Your other conversations now");
        assert.include(next.block, "with maya on phone (1 min ago)");
        assert.notInclude(next.block, "dinner");
        const hers = yield* turn.begin({
          vessel: phone,
          persona: "operations",
          speaker: maya,
          text: "and dessert",
          // A rehearsal reads as a real turn and leaves her threads as they were.
          rehearsal: true,
        });
        assert.match(hers.block, /You are also in \d+ other conversations? now/);
        assert.notInclude(hers.block, "owner");
        yield* turn.begin({
          vessel: device,
          text: "rehearsed",
          rehearsal: true,
          persona: "operations",
        });
        // A private moment's turn is a thread of hers too, its own row, with nothing of what was said.
        yield* turn.begin({
          vessel: device,
          text: "just us",
          private: true,
          persona: "operations",
          speaker: him,
        });
        const freya = yield* turn.threads("operations");
        assert.deepStrictEqual(
          freya.map((t) => [t.person, t.vessel.id, t.tier, t.gist]),
          [
            ["owner", "laptop", "public", null],
            ["owner", "desk-1", "private", null],
            ["maya", "p", "public", null],
          ],
        );
        // Her own public self knows it happened, never its words; another persona and Maya's turn learn nothing (D5).
        const after = yield* turn.begin({
          vessel: desktop,
          persona: "operations",
          speaker: him,
          text: "hi",
          rehearsal: true,
        });
        assert.include(after.block, "a private moment");
        assert.notInclude(after.block, "just us");
        const other = yield* turn.begin({
          vessel: desktop,
          persona: "engineering",
          speaker: him,
          text: "hi",
          rehearsal: true,
        });
        assert.notInclude(other.block, "private");
        const mayas = yield* turn.begin({
          vessel: phone,
          persona: "operations",
          speaker: maya,
          text: "hm",
          rehearsal: true,
        });
        const seen = (yield* turn.threads()).filter(
          (t) => t.tier === "public" && t.conversation !== "person:maya",
        ).length;
        assert.include(mayas.block, `You are also in ${seen} other conversations now`);
        assert.lengthOf(yield* turn.threads("engineering"), 0);
        yield* TestClock.adjust("10 minutes");
        assert.deepStrictEqual(
          (yield* turn.threads()).map((t) => [t.person, t.tier]),
          [
            ["owner", "public"],
            ["owner", "private"],
          ],
        );
      }),
  );

  it.effect(
    "his own thread gets a gist when his words move its topic, and her threads and conversation outlast a restart",
    () =>
      Effect.gen(function* () {
        const turn = yield* TessayaTurn;
        const him = owner();
        const asked: Array<string> = [];
        const oneShot = TessayaOneShot.of({
          run: (input) =>
            Effect.sync(() => {
              asked.push(input.prompt);
              return { gist: `topic ${asked.length}` } as never;
            }),
        });
        const loop: TurnEnvelope["vessel"] = { kind: "device", id: "gist-r1" };
        const say = (text: string, conversation = "gist-thread") =>
          Effect.gen(function* () {
            const env = { vessel: loop, persona: "gisty", speaker: him, text, conversation };
            yield* turn.begin(env);
            yield* turn.end(env, { reply: "Sure." });
          }).pipe(Effect.provideService(TessayaOneShot, oneShot));
        yield* say("set the heating schedule for the weekend");
        yield* say("okay thanks");
        assert.lengthOf(asked, 1);
        const gistOf = (ts: ReadonlyArray<{ conversation: string; gist: string | null }>) =>
          ts.find((t) => t.conversation === "gist-thread")?.gist;
        assert.strictEqual(gistOf(yield* turn.threads("gisty")), "topic 1");
        // A sentence that shares the topic leaves it; a new topic writes it again.
        yield* say("make the heating warmer on topic mornings");
        assert.lengthOf(asked, 1);
        yield* say("book a table for dinner with Sara tomorrow");
        assert.lengthOf(asked, 2);
        // Another person's thread never gets one: what Maya talks about is hers.
        const maya = owner({ kind: "saved", personId: "maya" });
        const env = {
          vessel: loop,
          persona: "gisty",
          speaker: maya,
          text: "plan the birthday party menu",
          conversation: "maya-thread",
        };
        yield* turn.begin(env);
        yield* turn
          .end(env, { reply: "Sure." })
          .pipe(Effect.provideService(TessayaOneShot, oneShot));
        assert.lengthOf(asked, 2);
        // A restart (a new server over the same store) has her threads and their conversation.
        const again = yield* makeTurn;
        assert.strictEqual(gistOf(yield* again.threads("gisty")), "topic 2");
        const carried = yield* again.begin({
          vessel: loop,
          persona: "gisty",
          speaker: him,
          text: "and?",
          conversation: "gist-thread",
        });
        assert.include(
          carried.conversation.turns.map((t) => t.content).join(" "),
          "dinner with Sara",
        );
      }),
  );

  it.effect(
    "a private moment that ends leaves her own everyday self one content-free episode, and nobody else",
    () =>
      Effect.gen(function* () {
        const turn = yield* TessayaTurn;
        const memory = yield* TessayaMemoryService;
        const said = "the words of a private moment";
        yield* turn.begin({
          vessel: desktop,
          persona: "companion",
          speaker: owner(),
          text: said,
          private: true,
          conversation: "trace-thread",
        });
        yield* TestClock.adjust("11 minutes");
        yield* turn.threads();
        const kept = (yield* memory
          .list({ limit: 500 })
          .pipe(Effect.provideService(MemoryViewer, "server"))).filter((i) =>
          i.sourceRef?.startsWith("private:"),
        );
        // the earlier test's private moment with another persona left its own; this one is hers alone
        assert.deepStrictEqual(kept.map((i) => i.persona).toSorted(), ["companion", "operations"]);
        kept.splice(0, kept.length, ...kept.filter((i) => i.persona === "companion"));
        assert.lengthOf(kept, 1);
        assert.strictEqual(kept[0]?.kind, "episode");
        assert.strictEqual(kept[0]?.visibility, "persona");
        assert.strictEqual(kept[0]?.persona, "companion");
        assert.notInclude(kept[0]?.text ?? "", said);
      }),
  );

  it.effect("a hand-off moves the conversation's live thread to the named persona, and back", () =>
    Effect.gen(function* () {
      const turn = yield* TessayaTurn;
      const him = owner();
      const say = (persona: string, text: string) =>
        turn.begin({ vessel: desktop, persona, speaker: him, text });
      const handOff = (persona: string, input: { to?: string; back?: boolean }) =>
        turn
          .handOff(input)
          .pipe(
            Effect.provideService(
              TurnOrigin,
              originOf({ vessel: desktop, text: "", speaker: him, persona }),
            ),
          );
      yield* say("engineering", "check the build");
      yield* TestClock.adjust("1 minute");
      // Two personas may share his conversation; only a hand-off moves it.
      assert.notInclude((yield* say("companion", "and the lights?")).block, "handed");
      assert.lengthOf(yield* turn.threads("engineering"), 1);
      yield* TestClock.adjust("1 minute");
      assert.include((yield* handOff("engineering", { to: "Freya" })).line, "Freya has this");
      assert.lengthOf(yield* turn.threads("engineering"), 0);
      // The thread keeps the time it opened: it is the same conversation.
      const [freya] = yield* turn.threads("companion");
      assert.strictEqual((freya?.lastAt ?? 0) - (freya?.openedAt ?? 0), 120_000);
      // Her next turn is told once who handed it to her.
      assert.include(
        (yield* say("companion", "so?")).block,
        "Onyx handed this conversation to you",
      );
      assert.notInclude((yield* say("companion", "and?")).block, "handed");
      // The way back: whoever had it before.
      assert.include((yield* handOff("companion", { back: true })).line, "Onyx has this");
      assert.lengthOf(yield* turn.threads("companion"), 0);
      assert.lengthOf(yield* turn.threads("engineering"), 1);
      // The persona speaking may take it itself; a name with no persona moves nothing.
      assert.include((yield* handOff("engineering", { to: "Zed" })).line, "no persona called Zed");
      assert.lengthOf(yield* turn.threads("engineering"), 1);
    }),
  );

  it.effect("a hand-off on a Tessel wears the persona there, or says plainly it could not", () =>
    Effect.gen(function* () {
      const turn = yield* TessayaTurn;
      // "I said Alfred, I was talking to him" on a short unverified turn (18 Nov, 05:52): a switch, not an act.
      const handOff = (id: string) =>
        turn.handOff({ to: "Alfred" }).pipe(
          Effect.provideService(
            TurnOrigin,
            originOf({
              vessel: { kind: "device", id },
              text: "",
              speaker: owner({ kind: "unverified", personId: null, verified: false }),
              persona: "executive",
            }),
          ),
        );
      castCalls.length = 0;
      assert.include((yield* handOff("tumble-1")).line, "Alfred has this conversation now");
      assert.deepStrictEqual(castCalls, [{ body: "tumble-1", persona: "butler", visitOk: true }]);
      const refused = (yield* handOff("dead-1")).line;
      assert.include(refused, "could not switch to Alfred");
      assert.include(refused, "never that Alfred is here");
    }),
  );

  it.effect("every vessel gets the same memory for the same words and persona", () =>
    Effect.gen(function* () {
      const memory = yield* TessayaMemoryService;
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
        const memory = yield* TessayaMemoryService;
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
        assert.strictEqual(
          yield* as(on(owner()), turn.forget(id)),
          "Forgotten. It can be put back for 30 days.",
        );
        assert.isUndefined((yield* memory.list({ limit: 50 })).find((i) => i.id === id));
        // His voice puts it back from the bin, by the memory's words.
        assert.include(
          yield* as(on(owner()), turn.understandingFact({ fact: "spare key", restore: true })),
          "Put back:",
        );
        assert.isDefined((yield* memory.list({ limit: 50 })).find((i) => i.id === id));
        yield* as(on(owner()), turn.forget(id));
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
        yield* said(desktop, "my desk notes", { speaker: owner() });
        yield* said(device, "my private plans", { speaker: owner() });
        assert.lengthOf(yield* heard({ speaker: owner() }), 4);
        assert.notInclude((yield* heard()).join(" "), "private plans");
        // A turn too short for Voice ID goes on with his thread on that device, only what it said aloud (17 Nov).
        const unsure = owner({ kind: "unverified", personId: null, verified: false });
        assert.deepStrictEqual(yield* heard({ speaker: unsure }), [
          "desk-1 user: my private plans",
          "desk-1 assistant: About my private plans.",
        ]);
        assert.notInclude(
          (yield* heard({
            speaker: owner({ kind: "guest", personId: null, verified: false }),
          })).join(" "),
          "private plans",
        );
        yield* said(device, "can you?", { speaker: unsure });
        assert.include((yield* heard({ speaker: owner() })).join(" "), "can you?");
        yield* TestClock.adjust("3 minutes");
        assert.notInclude((yield* heard({ speaker: unsure })).join(" "), "private plans");
        // A conversation the arbiter names is the one continued.
        yield* said(device, "the kitchen timer", { conversation: "arbiter:k1" });
        assert.lengthOf(yield* heard({ conversation: "arbiter:k1" }), 2);
        // After a quiet spell she starts afresh.
        yield* TestClock.adjust("11 minutes");
        assert.deepStrictEqual(yield* heard(), []);
      }),
  );

  it.effect(
    "recall also asks with the conversation's last messages, written in a stable order",
    () =>
      Effect.gen(function* () {
        const memory = yield* TessayaMemoryService;
        const turn = yield* TessayaTurn;
        yield* memory.add({
          kind: "fact",
          text: "Amira's birthday is on the ninth of March",
          source: "user",
        });
        const conversation = "window:1";
        const asked = { vessel: device, text: "what should I get her?", conversation };
        assert.notInclude((yield* turn.begin(asked)).block, "ninth of March");
        yield* turn.end(
          { vessel: device, text: "Amira's birthday is coming up", conversation },
          { reply: "" },
        );
        const later = yield* turn.begin(asked);
        assert.include(later.block, "ninth of March");
        assert.strictEqual((yield* turn.begin(asked)).block, later.block);
      }),
  );

  it.effect("a doubtful name is checked, and a turn of noise reaches nobody", () =>
    Effect.gen(function* () {
      const turn = yield* TessayaTurn;
      const words = [
        { text: "Call", p: 0.9 },
        { text: "Sara", p: 0.4 },
        { text: "now.", p: 0.9 },
      ];
      // Uncalibrated (an unknown recogniser): taken as heard.
      const plain = yield* turn.begin({ vessel: device, text: "Call Sara now.", words });
      assert.isUndefined(plain.repair);
      const checked = yield* turn.begin({
        vessel: device,
        text: "Call Sara now.",
        words,
        recogniser: "tdt",
      });
      assert.deepStrictEqual(checked.repair, { kind: "clarify", word: "Sara", index: 1 });
      assert.include(checked.notice, "did they say Sara?");
      // A private moment's turn is repaired the same way, and its doubted words never reach the shared log.
      const logged: Array<string> = [];
      const stop = onAction((e) => void logged.push(e.kind));
      const hidden = yield* turn.begin({
        vessel: device,
        text: "Call Sara now.",
        words,
        recogniser: "tdt",
        private: true,
      });
      stop();
      assert.deepStrictEqual(hidden.repair, checked.repair);
      assert.notInclude(logged, "turn.repair.verdict");
      const noise = yield* turn.begin({
        vessel: device,
        text: "Uhh.",
        words: [{ text: "Uhh.", p: null }],
      });
      assert.deepStrictEqual(noise.repair, { kind: "drop", reason: "noise" });
      assert.strictEqual(noise.block, "");
    }),
  );

  it.effect("live state reads for its turns on its vessel, then is gone", () =>
    Effect.gen(function* () {
      const live = yield* TurnLiveContext;
      const turn = yield* TessayaTurn;
      yield* live.inject({
        key: "motion",
        vessel: device.id,
        source: "motion",
        expiresAfterTurns: 2,
        line: "A moment ago your body was dropped.",
      });
      const block = (vessel: TurnEnvelope["vessel"]) =>
        Effect.map(turn.begin({ vessel, text: "hello" }), (c) => c.block);
      assert.notInclude(yield* block(desktop), "dropped");
      assert.include(yield* block(device), "dropped");
      assert.include(yield* block(device), "dropped");
      assert.notInclude(yield* block(device), "dropped");
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
    memory: Context.get(context, TessayaMemoryService),
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
      // One sync round, as TessayaMemorySync runs within seconds of a write.
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

it("tells every turn where she is in a few dozen tokens: vessel, body, room, what it can do, its state, who is home", () => {
  const item = (
    id: string,
    label: string,
    access: string,
    extra: Partial<DeviceItem> = {},
  ): DeviceItem => ({
    id,
    label,
    type: "string",
    access,
    safety: "free" as const,
    ...extra,
  });
  const device: RegisteredDevice = {
    deviceId: "r1-1",
    kind: "r1",
    name: "R1",
    firmware: null,
    via: "mqtt",
    online: true,
    lastSeenAt: null,
    version: null,
    items: [
      item("volume", "Volume", "read,write", { unit: "%" }),
      item("power.battery_pct", "Battery", "read", { unit: "%" }),
      item("camera", "Camera", "read,write", { privacy: true }),
      item("body.current", "Body", "read", { group: "body" }),
      item("body.room", "Room", "read", { group: "body" }),
    ],
    values: [
      { itemId: "volume", value: 70, at: "2026-11-14T12:00:00Z" },
      { itemId: "power.battery_pct", value: 99, at: "2026-11-14T12:00:00Z" },
      { itemId: "camera", value: "on", at: "2026-11-14T12:00:00Z" },
      { itemId: "body.current", value: "the Dock", at: "2026-11-14T12:00:00Z" },
      { itemId: "body.room", value: "study", at: "2026-11-14T12:00:00Z" },
    ],
  };
  const now = Date.parse("2026-11-14T12:05:00Z");
  assert.strictEqual(
    hereLine(device, ["Rab", "Sara"], now),
    "You are speaking through R1, in the Dock, in the study: this turn came through it, so it is on and hears him. Last reported: Volume 70%, Battery 99%. It can: Volume. Likely home: Rab, Sara.",
  );
  // M-077: what this body lets her feel and show, from its own manifest, and the other bodies she wears now
  const embodied = hereLine(
    {
      ...device,
      items: [
        ...device.items,
        item("imu.posture", "Posture", "read", { group: "sensors" }),
        item("eye.mood", "Eyes", "read,write", { group: "eyes" }),
      ],
    },
    null,
    now,
    undefined,
    undefined,
    { also: ["his desktop"], crew: [] },
  );
  assert.include(
    embodied,
    "In this body you feel being picked up, carried or shaken; your feelings show in your eyes on its screen.",
  );
  assert.include(embodied, "Right now you are also in your body on his desktop.");
  // He is talking through it while its link is down (17 Nov): never "offline"; old readings carry their age, and
  // the battery is not said while it charges (16 Nov).
  const linkDown = hereLine(
    {
      ...device,
      online: false,
      items: [...device.items, item("power.charging", "Charging", "read")],
      values: [
        ...device.values,
        { itemId: "power.charging", value: true, at: "2026-11-14T12:00:00Z" },
      ],
    },
    null,
    now + 18 * 3_600_000,
  );
  assert.notInclude(linkDown, "offline");
  assert.include(linkDown, "link to this server is down");
  assert.include(linkDown, "Volume 70% (as of 18 h ago)");
  assert.notInclude(linkDown, "Battery");
  // 18 Nov, 00:38: a day-old "output speaker" said his headphones had not taken; the loop's live word replaces it.
  const playing = {
    ...device,
    items: [...device.items, item("audio.output", "Output", "read,write")],
    values: [
      ...device.values,
      { itemId: "audio.output", value: "speaker", at: "2026-11-13T06:00:00Z" },
    ],
  };
  assert.include(hereLine(playing, null, now), "Output speaker (as of");
  const live = hereLine(playing, null, now, "bt");
  assert.include(live, "plays through Bluetooth");
  assert.notInclude(live, "Output speaker");
  // 18 Nov, 23:07: "What percentage is the volume?" took a tool round on the brain, whose record was another hub's 10%.
  // The vessel's live volume answers it, over that record.
  const loud = {
    ...device,
    items: [...device.items, item("audio.volume", "Volume", "read,write", { unit: "%" })],
    values: [...device.values, { itemId: "audio.volume", value: 10, at: "2026-11-14T09:00:00Z" }],
  };
  const heard = hereLine(loud, null, now, "onboard", 40);
  assert.include(heard, "Its volume is 40% right now, live from it.");
  assert.notInclude(heard, "Volume 10%");
  // A guest's turn (no member) is not told who lives here; nothing known is nothing said.
  assert.strictEqual(hereLine(null, null, now), "");
  assert.isAtMost(
    hereLine(
      device,
      Array.from({ length: 50 }, (_, i) => `Person ${i}`),
      now,
    ).length,
    520,
  );
});

it("moves a thread's topic only on new topic words, never on a short reply", () => {
  assert.isTrue(topicMoved(null, "set the heating schedule for the weekend"));
  assert.isFalse(topicMoved(null, "okay thanks"));
  assert.isFalse(topicMoved("the heating schedule", "make the heating warmer in the mornings"));
  assert.isTrue(topicMoved("the heating schedule", "book a table for dinner tomorrow"));
});

it("tells the owner what his threads are about, and a private moment only as one", () => {
  assert.strictEqual(
    boardLine(
      [
        {
          persona: "Freya",
          person: "you",
          where: "Tumble",
          minutesAgo: 1,
          about: "the heating schedule",
          doing: "playing the Dance scene",
        },
        {
          persona: "Freya",
          person: "you",
          where: "desktop",
          minutesAgo: 4,
          about: "secret",
          private: true,
        },
      ],
      "owner",
    ),
    "Your other conversations now (mention one only if it matters here): Freya with you on Tumble (1 min ago), about the heating schedule, playing the Dance scene; Freya with you on desktop (4 min ago), a private moment.",
  );
});

it("keeps the presence board under its ceiling however many talk to her at once", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    persona: "Freya",
    person: `Person ${i}`,
    where: "the kitchen R1",
    minutesAgo: i,
  }));
  assert.isAtMost(boardLine(many, "owner").length, 400);
  assert.strictEqual(boardLine(many, "guest"), "");
  assert.strictEqual(
    boardLine(many, "member"),
    "You are also in 40 other conversations now; say nothing of them.",
  );
});
