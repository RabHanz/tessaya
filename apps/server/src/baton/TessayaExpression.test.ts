import { assert, it } from "@effect/vitest";
import { LINE_EVENTS, lineId } from "@t3tools/baton-shared/expression";
import type { BrainRole } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonOneShot } from "./BatonOneShot.ts";
import {
  BATCHES_PER_HOUR,
  TessayaExpression,
  expressOr,
  layer as expressionLayer,
} from "./TessayaExpression.ts";

/** A brain that writes the given wordings for every moment it is asked about, and says which role paid. */
const brain = (lines: ReadonlyArray<string>, asked?: Deferred.Deferred<void>) => {
  const roles: Array<BrainRole> = [];
  const layer = Layer.mock(BatonOneShot)({
    run: ({ prompt, outputSchema, role }) =>
      Effect.gen(function* () {
        roles.push(role);
        if (asked !== undefined) yield* Deferred.succeed(asked, undefined);
        const events = [...prompt.matchAll(/^- ([a-z.]+):/gm)].map((m) => m[1]!);
        return yield* Schema.decodeUnknownEffect(outputSchema as never)({
          moments: events.map((event) => ({
            event,
            lines: lines.map((text) => ({ text, mood: "happy", gesture: "nodSmall" })),
          })),
        });
      }) as never,
  });
  return { layer, roles };
};

const setup = (
  settings: { tessayaExpression?: boolean; companionMotion?: "lively" | "calm" | "important" },
  lines: ReadonlyArray<string> = [],
  asked?: Deferred.Deferred<void>,
) => {
  const fake = brain(lines, asked);
  const layer = expressionLayer.pipe(
    Layer.provideMerge(fake.layer),
    Layer.provideMerge(ServerSettingsService.layerTest(settings)),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return { ...fake, layer };
};

it.effect("with the setting off, says today's line and never asks a model", () => {
  const t = setup({});
  return Effect.gen(function* () {
    const x = yield* TessayaExpression;
    const said = yield* x.express("job.done", { facts: { title: "Release notes" } });
    assert.strictEqual(said?.text, "Release notes is done.");
    assert.strictEqual(said?.source, "fixed");
    assert.strictEqual(said?.mood, LINE_EVENTS["job.done"].mood);
    assert.isNull(yield* x.express("moment.lifted"));
    assert.deepStrictEqual(t.roles, []);
  }).pipe(Effect.provide(t.layer));
});

it.effect("with it on, answers at once and writes ahead on her voice route", () =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<void>();
    const t = setup({ tessayaExpression: true }, ["Mm?"], asked);
    yield* Effect.gen(function* () {
      const x = yield* TessayaExpression;
      assert.isNotNull(yield* x.express("ack.name"));
      yield* Deferred.await(asked);
      assert.deepStrictEqual(t.roles, ["voice"]);
    }).pipe(Effect.provide(t.layer));
  }),
);

it.effect(
  "uses what the brain wrote, with the facts exact, and never twice in a row for one person",
  () => {
    const t = setup({ tessayaExpression: true }, ["{title}: wrapped.", "{title}, all finished."]);
    return Effect.gen(function* () {
      const x = yield* TessayaExpression;
      // The test clock starts at midnight UTC, and there is no house: night.
      yield* x.writeAhead("executive", "night", "job.done");
      const facts = { title: "Q3 report (v2)" };
      const first = yield* x.express("job.done", { person: "sara", facts });
      const second = yield* x.express("job.done", { person: "sara", facts });
      assert.strictEqual(first?.source, "cache");
      assert.notStrictEqual(first?.lineId, second?.lineId);
      for (const said of [first, second]) assert.include(said?.text ?? "", "Q3 report (v2)");
      // Another person hears the house's wordings afresh.
      const other = yield* x.express("job.done", { person: "omar", facts });
      assert.strictEqual(other?.source, "cache");
      assert.notStrictEqual(other?.lineId, lineId("job.done", "{title} is done."));
    }).pipe(Effect.provide(t.layer));
  },
);

it.effect("writes ahead at most so many times an hour", () => {
  const t = setup({ tessayaExpression: true }, []);
  return Effect.gen(function* () {
    const x = yield* TessayaExpression;
    for (let i = 0; i < BATCHES_PER_HOUR + 3; i++) yield* x.writeAhead("executive", "morning");
    assert.strictEqual(t.roles.length, BATCHES_PER_HOUR);
  }).pipe(Effect.provide(t.layer));
});

it.effect(
  "keeps unprompted lines quiet in quiet hours and on important only, never his answers or safety",
  () => {
    const t = setup({ tessayaExpression: false, companionMotion: "important" });
    return Effect.gen(function* () {
      const x = yield* TessayaExpression;
      assert.isNotNull(yield* x.express("ok.done"));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT OR REPLACE INTO fabric_settings (key, value) VALUES ('comms.quietHours', ${JSON.stringify({ from: "00:00", to: "23:59", timeZone: "UTC" })})`;
      assert.isNull(yield* x.express("job.done", { facts: { title: "Build" } }));
      assert.isNotNull(yield* x.express("alarm.clear", { facts: { label: "Smoke" } }));
      assert.isNotNull(yield* x.express("ok.done"));
    }).pipe(Effect.provide(t.layer));
  },
);

it.effect("keeps a call site's own plain words, with or without the service", () => {
  const t = setup({});
  return Effect.gen(function* () {
    const plain = "Sorry, something went wrong on my side.";
    assert.strictEqual((yield* expressOr("err.brain", { plain }))?.text, plain);
    assert.strictEqual(
      (yield* expressOr("err.brain", { plain }).pipe(Effect.provide(t.layer)))?.text,
      plain,
    );
  });
});
