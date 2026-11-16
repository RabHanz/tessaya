import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
    assert.include(back, "He was away 9 h");
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
  "each person sees only their own row; the owner sees all; an owned device shows its owner's until someone else is heard there",
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
      // The Tessel tied to Sara with her mood on: hers at rest; a guest heard there, the general mood; Sara again, hers.
      assert.strictEqual((yield* mood.atDevice("tessel-1", "companion")).label, "hurt");
      yield* mood.here("tessel-1", null);
      assert.strictEqual((yield* mood.atDevice("tessel-1", "companion")).label, "neutral");
      yield* mood.here("tessel-1", OWNER_MEMBER_ID);
      assert.strictEqual((yield* mood.atDevice("tessel-1", "companion")).label, "proud");
      yield* TestClock.adjust("11 minutes");
      // Quiet a while: its owner's again, never his.
      assert.deepStrictEqual((yield* mood.atDevice("tessel-1", "companion")).why, [
        "they were rude to her",
      ]);
      // An untied device shows only the general mood.
      assert.strictEqual((yield* mood.atDevice("tessel-2", "companion")).label, "neutral");
    }).pipe(
      Effect.provide(
        moodLayer.pipe(
          Layer.provideMerge(
            Layer.mock(TessayaOneShot)({
              run: ({ prompt }) =>
                Effect.succeed({
                  tone: prompt.includes("useless") ? "rude" : "praise",
                }) as never,
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
                return Effect.succeed({
                  tone: said.includes("sorry")
                    ? "apology"
                    : said.includes("useless")
                      ? "rude"
                      : "none",
                }) as never;
              },
            }),
          ),
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              tessayaMood: { enabled: true, intensity: 0.6, bondCap: 0.15 },
            }),
          ),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
);
