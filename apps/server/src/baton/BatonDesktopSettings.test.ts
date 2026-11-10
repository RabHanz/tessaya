import type { DesktopVoiceSettings } from "@t3tools/baton-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { APPLY_WAIT, BatonDesktopSettings, layer } from "./BatonDesktopSettings.ts";

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
};

it.layer(layer)("BatonDesktopSettings", (it) => {
  it.effect("a set waits for the desktop to apply it and answers with what it then runs", () =>
    Effect.gen(function* () {
      const settings = yield* BatonDesktopSettings;
      yield* settings.sync({ effective: before, applied: 0 });
      const set = yield* settings
        .set({ dictationCleanup: "claude" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      // A second change before the desktop's next sync joins the first.
      const again = yield* settings
        .set({ pillStyle: "field" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const { change } = yield* settings.sync({ effective: before, applied: 0 });
      assert.deepStrictEqual(change?.patch, { dictationCleanup: "claude", pillStyle: "field" });
      const after = { ...before, dictationCleanup: "claude", pillStyle: "field" } as const;
      const next = yield* settings.sync({ effective: after, applied: change?.version ?? 0 });
      assert.strictEqual(next.change, null);
      for (const fiber of [set, again]) {
        const answer = yield* Fiber.join(fiber);
        assert.isTrue(answer.applied);
        assert.isTrue(answer.connected);
        assert.deepStrictEqual(answer.effective, after);
        assert.strictEqual(answer.pending, null);
      }
    }),
  );

  it.effect("a desktop that never syncs leaves the change pending, not applied", () =>
    Effect.gen(function* () {
      const settings = yield* BatonDesktopSettings;
      const set = yield* settings
        .set({ frosted: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(APPLY_WAIT);
      const answer = yield* Fiber.join(set);
      assert.isFalse(answer.applied);
      assert.deepStrictEqual(answer.pending, { frosted: true });
      const { change } = yield* settings.sync({ effective: before, applied: 0 });
      assert.deepStrictEqual(change?.patch, { frosted: true });
    }),
  );
});
