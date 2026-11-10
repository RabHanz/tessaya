import type { DesktopVoiceSettings } from "@t3tools/baton-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import {
  APPLY_WAIT,
  BatonDesktopSettings,
  DesktopSettingsCaller,
  SYNC_HOLD,
  layer as settingsLayer,
} from "./BatonDesktopSettings.ts";
import { BatonRecordService, layer as recordLayer } from "./BatonRecordService.ts";

const before: DesktopVoiceSettings = {
  dictationCleanup: "local",
  pillStyle: "pill",
  showWords: true,
  holdKey: "Ctrl+Shift+Win",
  holdKeyCues: false,
  frosted: false,
  doubleTap: true,
  learnWords: true,
  duckWhileDictating: "off",
  recognizeOnServers: false,
  gpuRecognition: "auto",
};

const layer = it.layer(
  settingsLayer.pipe(Layer.provideMerge(recordLayer), Layer.provideMerge(SqlitePersistenceMemory)),
);
const manager = { actor: 'outside:"manager"', scope: "mcp full-access: orchestration" };

layer("BatonDesktopSettings", (it) => {
  it.effect(
    "a held sync wakes on a set, which answers with what the desktop then runs, on the Record",
    () =>
      Effect.gen(function* () {
        const settings = yield* BatonDesktopSettings;
        const held = yield* settings
          .sync({ effective: before, applied: 0 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        const set = yield* settings
          .set({ dictationCleanup: "claude" })
          .pipe(
            Effect.provideService(DesktopSettingsCaller, manager),
            Effect.forkChild({ startImmediately: true }),
          );
        assert.strictEqual((yield* Fiber.join(held)).change?.patch.dictationCleanup, "claude");
        // A second change before the desktop takes the first joins it.
        const again = yield* settings
          .set({ pillStyle: "field" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        const { change } = yield* settings.sync({ effective: before, applied: 0 });
        assert.deepStrictEqual(change?.patch, { dictationCleanup: "claude", pillStyle: "field" });
        const after = { ...before, dictationCleanup: "claude", pillStyle: "field" } as const;
        const idle = yield* settings
          .sync({ effective: after, applied: change?.version ?? 0 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        for (const fiber of [set, again]) {
          const answer = yield* Fiber.join(fiber);
          assert.isTrue(answer.applied);
          assert.deepStrictEqual(answer.effective, after);
          assert.strictEqual(answer.pending, null);
        }
        // With nothing waiting, the desktop's sync rests until the hold runs out.
        yield* TestClock.adjust(SYNC_HOLD);
        assert.strictEqual((yield* Fiber.join(idle)).change, null);
        const rows = yield* (yield* BatonRecordService).query({ kind: "desktop_settings" });
        const mine = rows.find((row) => row.actor === manager.actor);
        assert.strictEqual(mine?.outcome, "applied");
        assert.include(mine?.subject ?? "", '"dictationCleanup":"claude"');
        assert.deepStrictEqual(JSON.parse(mine?.detail ?? "{}"), {
          scope: manager.scope,
          before,
          after,
        });
        // Unset, the caller is the desktop app's own session.
        assert.isTrue(rows.some((row) => row.actor === "desktop app"));
      }),
  );

  it.effect("a change the desktop does not take in time is dropped, never applied late", () =>
    Effect.gen(function* () {
      const settings = yield* BatonDesktopSettings;
      const set = yield* settings
        .set({ frosted: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(APPLY_WAIT);
      const answer = yield* Fiber.join(set);
      assert.isFalse(answer.applied);
      assert.strictEqual(answer.pending, null);
      const woken = yield* settings
        .sync({ effective: before, applied: 0 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(SYNC_HOLD);
      assert.strictEqual((yield* Fiber.join(woken)).change, null);
      const rows = yield* (yield* BatonRecordService).query({ kind: "desktop_settings" });
      assert.strictEqual(rows[0]?.outcome, "not applied");
    }),
  );
});
