import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaMemoryLearning } from "./TessayaMemoryLearning.ts";
import { layer as memoryLayer } from "./TessayaMemoryService.ts";
import { TessayaPrivateMemoryService } from "./TessayaPrivateMemoryService.ts";
import { layer as MemberPreferencesLayer } from "./MemberPreferences.ts";
import { layer as expressionLayer, TessayaExpression } from "./TessayaExpression.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { TessayaTurn, layer as turnLayer, type TurnEnvelope } from "./TessayaTurn.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TessayaMood, layer as moodLayer } from "./TessayaMood.ts";
import { TessayaPeople } from "./TessayaPeople.ts";
import { TessayaPresence, layer as presenceLayer } from "./TessayaPresence.ts";

const learning = Layer.mock(TessayaMemoryLearning)({
  learn: () => Effect.succeed({ stored: 1, held: 0, corrections: 1 }),
});
const stores = Layer.mock(TessayaPrivateMemoryService)({
  recall: () => Effect.succeed({ block: "", count: 0, whose: "yours" }),
});

const setup = (enabled = true) =>
  turnLayer.pipe(
    Layer.provideMerge(expressionLayer),
    Layer.provideMerge(Layer.mock(TessayaOneShot)({})),
    Layer.provideMerge(moodLayer),
    Layer.provideMerge(MemberPreferencesLayer),
    Layer.provideMerge(
      ServerSettingsService.layerTest({ tessayaMood: { enabled, intensity: 0.6, bondCap: 0.15 } }),
    ),
    Layer.provideMerge(memoryLayer),
    Layer.provideMerge(learning),
    Layer.provideMerge(stores),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

/** The cheap read's answer with only its tone set. */
const toneOnly = (tone: string) => ({ tone, topic: "none", theirs: "none", shared: null });

const his: TurnEnvelope = {
  vessel: { kind: "desktop", id: "laptop" },
  text: "morning",
  persona: "companion",
  timeZone: "UTC",
};
const blockOf = (turn: TurnEnvelope) =>
  Effect.map(
    Effect.flatMap(TessayaTurn, (t) => t.begin(turn)),
    (c) => c.block,
  );

it.effect("his return after hours is in his next turn once; nobody else hears or sees it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
    assert.notInclude(yield* blockOf(his), "away");
    yield* TestClock.adjust("9 hours");
    // Sara's turn neither hears his mood nor resolves his absence.
    assert.notInclude(yield* blockOf({ ...his, member: "sara" }), "away");
    const back = yield* blockOf(his);
    // Named, and "they" with no pronouns of their own: never "he" for everyone (16 Nov).
    assert.include(back, "Owner was away 9 h");
    assert.include(back, "never ask where they were");
    assert.include(back, "Your mood now: sulky");
    assert.notInclude(yield* blockOf(his), "away");
    const mood = yield* TessayaMood;
    assert.strictEqual((yield* mood.view("companion", "UTC", OWNER_MEMBER_ID)).label, "sulky");
    // A line to no one in particular shows the general mood: his sulk is his alone (16 Nov).
    const said = yield* Effect.flatMap(TessayaExpression, (x) =>
      x.express("msg.private", { persona: "companion", facts: { from: "Sara" } }),
    );
    assert.notStrictEqual(said?.mood, "sulky");
    assert.strictEqual((yield* mood.view("companion", "UTC", "sara")).label, "neutral");
  }).pipe(Effect.provide(setup())),
);

it.effect("a correction the learning loop kept moves the corrected persona", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
    const turns = yield* TessayaTurn;
    yield* turns.end({ ...his, persona: "butler" }, { reply: "Noted." });
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ persona: string; reason: string }>`
      SELECT persona, reason FROM tessaya_affect_state ORDER BY persona
    `;
    assert.deepStrictEqual(rows, [{ persona: "butler", reason: "they corrected her" }]);
  }).pipe(Effect.provide(setup())),
);

it.effect("off: no line, a neutral face, and the state is cleared", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO tessaya_affect_state VALUES ('companion', '{"seenAt":0}', 'x', 'x')`;
    assert.strictEqual(
      (yield* Effect.flatMap(TessayaMood, (m) => m.view("companion"))).label,
      "neutral",
    );
    assert.deepStrictEqual(yield* sql`SELECT persona FROM tessaya_affect_state`, []);
    assert.notInclude(yield* blockOf(his), "mood");
  }).pipe(Effect.provide(setup(false))),
);

it.effect(
  "how a voice sounds moves her relationship with that person only, and nobody's when unsure",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
      const sql = yield* SqlClient.SqlClient;
      const warmth = (member: string) =>
        Effect.map(
          sql<{
            state_json: string;
          }>`SELECT state_json FROM tessaya_affect_state WHERE persona = 'companion'`,
          (rows) =>
            (JSON.parse(rows[0]?.state_json ?? "{}").people?.[member]?.reaction?.warmth ??
              0) as number,
        );
      // A guest's voice (no verdict) moves no one's.
      yield* blockOf({ ...his, vessel: { kind: "device", id: "tessel-1" }, emotion: "sad" });
      assert.deepStrictEqual(yield* sql`SELECT persona FROM tessaya_affect_state`, []);
      yield* blockOf({ ...his, member: "sara", emotion: "sad" });
      assert.isAbove(yield* warmth("sara"), 0.1);
      assert.strictEqual(yield* warmth(OWNER_MEMBER_ID), 0);
      yield* blockOf({ ...his, emotion: "sad" });
      assert.isAbove(yield* warmth(OWNER_MEMBER_ID), 0.1);
    }).pipe(Effect.provide(setup())),
);

it.effect(
  "each person sees only their own row; the owner sees all; an owned device shows its owner's only with nobody else there",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
      const mood = yield* TessayaMood;
      yield* mood.hisWords("companion", "you are useless", "sara");
      yield* mood.hisWords("companion", "thank you, well done", OWNER_MEMBER_ID);
      const sara = yield* mood.inner("companion", "sara");
      assert.deepStrictEqual(
        sara.people.map((p) => [p.member, p.view.label, p.view.why]),
        [["sara", "hurt", ["they were rude to her"]]],
      );
      assert.strictEqual(sara.general.label, "neutral");
      const all = yield* mood.inner("companion", OWNER_MEMBER_ID);
      assert.deepStrictEqual(all.people.map((p) => p.member).toSorted(), [OWNER_MEMBER_ID, "sara"]);
      // A guest's view never carries anyone's.
      assert.deepStrictEqual((yield* mood.inner("companion", "guest")).people, []);
      // The Tessel tied to Sara with her mood on: hers at rest; someone unnamed there, the general mood; he alone there,
      // his; nobody around a while, hers again. Who is there is the one presence estimate.
      const presence = yield* TessayaPresence;
      const why = Effect.map(mood.atDevice("tessel-1", "companion"), (v) => v.why);
      assert.strictEqual((yield* mood.atDevice("tessel-1", "companion")).label, "hurt");
      yield* presence.note({ member: null, source: "handled", vessel: "tessel-1" });
      assert.deepStrictEqual(yield* why, []);
      yield* TestClock.adjust("30 minutes");
      yield* presence.note({ member: OWNER_MEMBER_ID, source: "voice", vessel: "tessel-1" });
      assert.deepStrictEqual(yield* why, ["they praised her"]);
      yield* TestClock.adjust("2 hours");
      assert.deepStrictEqual(yield* why, ["they were rude to her"]);
      // An untied device shows only the general mood.
      assert.strictEqual((yield* mood.atDevice("tessel-2", "companion")).label, "neutral");
    }).pipe(
      Effect.provide(
        moodLayer.pipe(
          Layer.provideMerge(
            Layer.mock(TessayaOneShot)({
              run: ({ prompt }) =>
                Effect.succeed(toneOnly(prompt.includes("useless") ? "rude" : "praise")) as never,
            }),
          ),
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              tessayaMood: {
                enabled: true,
                intensity: 0.6,
                bondCap: 0.15,
                devices: { "tessel-1": { owner: "sara", show: true } },
              },
            }),
          ),
          Layer.provideMerge(presenceLayer),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
);

it.effect(
  "his words move her through the cheap model's tone: sorry lifts her, a plain ask moves nothing",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
      const mood = yield* TessayaMood;
      const sql = yield* SqlClient.SqlClient;
      yield* mood.hisWords("companion", "turn the lamp on", OWNER_MEMBER_ID);
      assert.deepStrictEqual(yield* sql`SELECT persona FROM tessaya_affect_state`, []);
      yield* mood.hisWords("companion", "you are useless", OWNER_MEMBER_ID);
      // A short hurt on her face, and she knows why.
      const hurt = yield* mood.view("companion", undefined, OWNER_MEMBER_ID);
      assert.strictEqual(hurt.label, "hurt");
      assert.deepStrictEqual(hurt.why, ["they were rude to her"]);
      yield* mood.hisWords("companion", "sorry, I did not mean that", OWNER_MEMBER_ID);
      assert.strictEqual(
        (yield* mood.view("companion", undefined, OWNER_MEMBER_ID)).label,
        "happy",
      );
      const rows = yield* sql<{ reason: string }>`SELECT reason FROM tessaya_affect_state`;
      assert.deepStrictEqual(rows, [{ reason: "they said sorry" }]);
    }).pipe(
      Effect.provide(
        moodLayer.pipe(
          Layer.provideMerge(
            Layer.mock(TessayaOneShot)({
              run: ({ prompt }) => {
                const said = /<said>(.*)<\/said>/s.exec(prompt)?.[1] ?? "";
                return Effect.succeed(
                  toneOnly(
                    said.includes("sorry") ? "apology" : said.includes("useless") ? "rude" : "none",
                  ),
                ) as never;
              },
            }),
          ),
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              // Full forgiveness: a sorry lets all of the hurt go (the default, 0.8, leaves her neutral).
              tessayaMood: {
                enabled: true,
                intensity: 0.6,
                bondCap: 0.15,
                personas: { companion: { forgiveness: 1 } },
              },
            }),
          ),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
);

const stateOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ state_json: string }>`
    SELECT state_json FROM tessaya_affect_state WHERE persona = 'companion'
  `;
  return JSON.parse(rows[0]?.state_json ?? "{}") as {
    general?: { flow?: { theirs: string } };
    people?: Record<string, { flow?: { theirs: string } }>;
  };
});
const moodSettings = ServerSettingsService.layerTest({
  tessayaMood: { enabled: true, intensity: 0.6, bondCap: 0.15 },
});

it.effect("a room's flow moves the general mood; a person's moves theirs", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
    const mood = yield* TessayaMood;
    yield* mood.hisWords("companion", "this build is broken again", null);
    assert.strictEqual((yield* stateOf).general?.flow?.theirs, "angry");
    yield* mood.hisWords("companion", "my exam went badly", "sara");
    const after = yield* stateOf;
    assert.strictEqual(after.people?.["sara"]?.flow?.theirs, "low");
    assert.strictEqual(after.general?.flow?.theirs, "angry");
  }).pipe(
    Effect.provide(
      moodLayer.pipe(
        Layer.provideMerge(
          Layer.mock(TessayaOneShot)({
            run: ({ prompt }) =>
              Effect.succeed({
                tone: "none",
                topic: "none",
                theirs: /<said>[^<]*exam/.test(prompt) ? "low" : "angry",
                shared: null,
              }) as never,
          }),
        ),
        Layer.provideMerge(moodSettings),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);

it.effect(
  "someone the people graph forgets takes her feelings with them, one merged moves them, and a reset clears an opinion",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
      const praised = (member: string) =>
        Effect.flatMap(TessayaMood, (m) => m.note("companion", { kind: "praise" }, member));
      yield* Effect.all([praised("ali"), praised("sam"), praised("person-new")]).pipe(
        Effect.provide(moodLayer.pipe(Layer.provideMerge(moodSettings))),
      );
      const done = yield* Deferred.make<void>();
      const impressions: Array<readonly [string, string | null]> = [];
      const people = Layer.mock(TessayaPeople)({
        // Ali forgotten, Sam found to be Sara; then the test goes on.
        forgotten: Stream.make({ id: "ali", into: undefined }, { id: "sam", into: "sara" }).pipe(
          Stream.concat(Stream.fromEffectDrain(Deferred.succeed(done, undefined))),
        ),
        setImpression: (id, text) => Effect.sync(() => void impressions.push([id, text])),
      });
      yield* Effect.gen(function* () {
        yield* Deferred.await(done);
        const mood = yield* TessayaMood;
        const rows = (yield* mood.inner("companion", OWNER_MEMBER_ID)).people;
        assert.deepStrictEqual(rows.map((p) => p.member).toSorted(), ["person-new", "sara"]);
        yield* mood.reset("companion", "person-new");
        assert.deepStrictEqual(
          (yield* mood.inner("companion", OWNER_MEMBER_ID)).people.map((p) => p.member),
          ["sara"],
        );
        // Not a member: the people graph's impression of them goes too.
        assert.deepStrictEqual(impressions, [["person-new", null]]);
      }).pipe(
        Effect.provide(moodLayer.pipe(Layer.provide(people), Layer.provideMerge(moodSettings))),
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
