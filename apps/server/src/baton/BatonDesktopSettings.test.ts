import type { DesktopVoiceSettings } from "@t3tools/tessaya-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { chooseDictationCleanup, ServerSettingsError } from "@t3tools/contracts";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import {
  APPLY_WAIT,
  BatonDesktopSettings,
  DesktopSettingsCaller,
  SYNC_HOLD,
  layer as settingsLayer,
} from "./BatonDesktopSettings.ts";
import { BatonRecordService, layer as recordLayer } from "./BatonRecordService.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const before: DesktopVoiceSettings = {
  dictationCleanup: "local",
  pillStyle: "pill",
  pillDesign: "tessaya",
  pillWaveform: "match",
  showWords: true,
  holdKey: "Ctrl+Shift+Win",
  holdKeyCues: false,
  frosted: false,
  doubleTap: true,
  learnWords: true,
  duckWhileDictating: "off",
  recognizeOnServers: false,
  gpuRecognition: "auto",
  openTessayaOnStart: false,
  openSessionsOnStart: true,
};

const services = () =>
  settingsLayer.pipe(
    Layer.provideMerge(recordLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  );
const layer = it.layer(services());
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

it.layer(services())("BatonDesktopSettings and the one cleanup setting", (it) => {
  it.effect(
    "the desktop's cleanup follows the one setting, and a change there or by an agent becomes it",
    () =>
      Effect.gen(function* () {
        const desktop = yield* BatonDesktopSettings;
        const server = yield* ServerSettingsService;
        const universal = server.getSettings.pipe(Effect.map((s) => s.dictationCleanup));
        const quietSync = Effect.fn("test.quietSync")(function* (
          effective: DesktopVoiceSettings,
          applied: number,
        ) {
          const fiber = yield* desktop
            .sync({ effective, applied })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(SYNC_HOLD);
          return (yield* Fiber.join(fiber)).change;
        });
        const claude = { ...before, dictationCleanup: "claude" } as const;

        // Before anyone chose, the desktop's model cleanup is his choice: it becomes the one setting.
        assert.strictEqual(yield* quietSync(claude, 0), null);
        assert.isTrue((yield* universal).enabled);
        assert.isAbove((yield* universal).updatedAt, 0);

        // Turned off elsewhere (another environment, carried here): handed to the desktop at once, code-only.
        yield* server.updateSettings({
          dictationCleanup: chooseDictationCleanup(yield* universal, { enabled: false }, 10_000),
        });
        const change = (yield* desktop.sync({ effective: claude, applied: 0 })).change;
        assert.deepStrictEqual(change?.patch, { dictationCleanup: "local" });
        // Taking it is not his own change, so the setting stays off.
        assert.strictEqual(yield* quietSync(before, change?.version ?? 0), null);
        assert.isFalse((yield* universal).enabled);

        // His own change on the desktop turns it on everywhere.
        assert.strictEqual(yield* quietSync(claude, change?.version ?? 0), null);
        assert.isTrue((yield* universal).enabled);

        // As does an agent's, through tessaya_desktop_settings.
        const set = yield* desktop
          .set({ dictationCleanup: "off" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isFalse((yield* universal).enabled);
        yield* TestClock.adjust(APPLY_WAIT);
        yield* Fiber.join(set);
      }),
  );
});

// A settings file that cannot be written (Windows holds it open): the desktop's choice cannot become the setting.
const unwritable = Layer.effect(
  ServerSettingsService,
  Effect.gen(function* () {
    const real = yield* ServerSettingsService;
    return ServerSettingsService.of({
      ...real,
      updateSettings: () =>
        Effect.fail(new ServerSettingsError({ settingsPath: "<memory>", operation: "write-file" })),
    });
  }),
).pipe(Layer.provide(ServerSettingsService.layerTest()));

it.layer(
  settingsLayer.pipe(
    Layer.provideMerge(recordLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(unwritable),
  ),
)("BatonDesktopSettings when the one setting cannot be saved", (it) => {
  it.effect("never hands the desktop a lower cleanup that nobody chose", () =>
    Effect.gen(function* () {
      const desktop = yield* BatonDesktopSettings;
      const claude = { ...before, dictationCleanup: "claude" } as const;
      for (const _ of [1, 2, 3]) {
        const fiber = yield* desktop
          .sync({ effective: claude, applied: 0 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(SYNC_HOLD);
        assert.strictEqual((yield* Fiber.join(fiber)).change, null);
      }
    }),
  );
});
