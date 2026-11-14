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

it.effect("his return after hours is in his next turn once; others get no mood in words", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2027-01-02T09:00:00.000Z"));
    assert.notInclude(yield* blockOf(his), "away");
    yield* TestClock.adjust("9 hours");
    // Sara's turn neither hears the mood nor resolves his absence.
    assert.notInclude(yield* blockOf({ ...his, member: "sara" }), "away");
    const back = yield* blockOf(his);
    assert.include(back, "He was away 9 h");
    assert.include(back, "Your mood now: sulky");
    assert.notInclude(yield* blockOf(his), "away");
    // The face on every vessel takes the same label while the return lasts (Freya is Playful).
    const said = yield* Effect.flatMap(TessayaExpression, (x) =>
      x.express("msg.private", { persona: "companion", facts: { from: "Sara" } }),
    );
    assert.strictEqual(said?.mood, "sulky");
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
    assert.deepStrictEqual(rows, [{ persona: "butler", reason: "he corrected her" }]);
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
