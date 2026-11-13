import { assert, it } from "@effect/vitest";
import { DesktopVoiceSettingsPatch } from "@t3tools/baton-contracts";
import { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ServerSettingsService } from "../serverSettings.ts";
import { layerMemory as BatonDatabaseMemory } from "./BatonDatabase.ts";
import { BatonDesktopSettings } from "./BatonDesktopSettings.ts";
import { BatonPhoneInbox, layer as inboxLayer } from "./BatonPhoneInbox.ts";
import { findSettings, setSetting, SETTINGS } from "./SettingsVoice.ts";

it("every setting has a voice path and a safety class; a never one says why", () => {
  const keys = SETTINGS.map((s) => `${s.store}.${s.key}`).toSorted();
  const fields = [
    ...Object.keys(ServerSettings.fields).map((k) => `server.${k}`),
    ...Object.keys(DesktopVoiceSettingsPatch.fields).map((k) => `desktop.${k}`),
  ].toSorted();
  assert.deepStrictEqual(keys, fields);
  for (const s of SETTINGS) {
    assert.isAbove(s.say.length, 5, s.key);
    if (s.class === "never") assert.isAbove(s.why?.length ?? 0, 10, s.key);
  }
});

it("finds a setting by his words", () => {
  assert.strictEqual(
    findSettings("turn off the sounds when the dictation key is pressed")[0]?.key,
    "holdKeyCues",
  );
  assert.include(
    findSettings("change the speech model").map((s) => s.key),
    "speechModelId",
  );
});

const setup = () => {
  const desktop = { holdKeyCues: true as unknown, holdKey: "F9" as unknown };
  const desktopLayer = Layer.succeed(BatonDesktopSettings)({
    get: Effect.sync(() => ({ effective: { ...desktop } }) as never),
    set: (patch) =>
      Effect.sync(() => {
        Object.assign(desktop, patch);
        return {} as never;
      }),
    sync: () => Effect.die("unused"),
  });
  const layer = Layer.mergeAll(
    desktopLayer,
    ServerSettingsService.layerTest(),
    inboxLayer.pipe(Layer.provideMerge(BatonDatabaseMemory)),
  );
  return { desktop, layer };
};

it.effect(
  "changes a free setting at once with the way back, asks his yes for a confirm one, never a never one",
  () => {
    const { desktop, layer } = setup();
    return Effect.gen(function* () {
      const quiet = yield* setSetting({
        key: "holdKeyCues",
        value: "false",
        why: "turn off the dictation sounds",
        who: "Tessaya in the room",
      });
      assert.strictEqual(quiet.status, "done");
      assert.strictEqual(desktop.holdKeyCues, false);
      assert.include(quiet.line, "set holdKeyCues to true");

      const key = yield* setSetting({ key: "holdKey", value: "F8", why: "x", who: "Tessaya" });
      assert.strictEqual(key.status, "asked");
      assert.strictEqual(desktop.holdKey, "F9");
      const inbox = yield* BatonPhoneInbox;
      const card = (yield* inbox.pending).find((p) => p.id.startsWith("setting-holdKey"));
      assert.include(card?.detail ?? "", '"F9" to "F8"');
      assert.isTrue(yield* inbox.answerPrompt(card!.id, 0));
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(desktop.holdKey, "F8");

      const secret = yield* setSetting({
        key: "dictationCleanupCredentials",
        value: {},
        why: "x",
        who: "Tessaya",
      });
      assert.strictEqual(secret.status, "refused");
      const wrong = yield* setSetting({ key: "holdKey", value: "F1", why: "x", who: "Tessaya" });
      assert.strictEqual(wrong.status, "refused");
      assert.include(wrong.line, "F9");
      const dry = yield* setSetting({
        key: "holdKeyCues",
        value: true,
        why: "x",
        who: "Tessaya",
        dryRun: true,
      });
      assert.strictEqual(dry.status, "done");
      assert.strictEqual(desktop.holdKeyCues, false);
    }).pipe(Effect.provide(layer));
  },
);
