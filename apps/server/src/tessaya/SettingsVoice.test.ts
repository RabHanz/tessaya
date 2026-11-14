import { assert, it } from "@effect/vitest";
import { DesktopVoiceSettingsPatch } from "@t3tools/tessaya-contracts";
import { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ServerSettingsService } from "../serverSettings.ts";
import { layerMemory as TessayaDatabaseMemory } from "./TessayaDatabase.ts";
import { TessayaDesktopSettings } from "./TessayaDesktopSettings.ts";
import { TessayaPhoneInbox, layer as inboxLayer } from "./TessayaPhoneInbox.ts";
import { allSettings, choicesOf, findSettings, setSetting, SETTINGS } from "./SettingsVoice.ts";

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

it("the model a kind of her work runs on lists the models he can name", () => {
  // Without a list she would not guess one: "talk to me on Opus" failed 1 of 3 (13 Nov suite).
  const models = SETTINGS.find((s) => s.store === "server" && s.key === "brainModels")!;
  const choices = choicesOf(models) ?? [];
  for (const name of ["haiku", "sonnet", "opus"]) assert.include(choices, name);
});

const setup = () => {
  const desktop = { holdKeyCues: true as unknown, holdKey: "F9" as unknown, connected: true };
  const controlled: Array<{ id: string; value: string | boolean }> = [];
  // What the desktop publishes of its own Settings (its voice speed, its chime).
  const controls = [
    {
      id: "v.rate",
      label: "How fast she speaks",
      section: "Voice",
      value: "normal",
      options: ["slower", "normal", "faster"],
      voice: "free" as const,
    },
    {
      id: "v.chime",
      label: "The listening chime",
      section: "Voice",
      value: true,
      voice: "free" as const,
    },
  ];
  const desktopLayer = Layer.succeed(TessayaDesktopSettings)({
    get: Effect.sync(
      () => ({ connected: desktop.connected, effective: { ...desktop }, controls }) as never,
    ),
    setControls: (changes) => Effect.sync(() => (controlled.push(...changes), {} as never)),
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
    inboxLayer.pipe(Layer.provideMerge(TessayaDatabaseMemory)),
  );
  return { desktop, controlled, layer };
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
      const inbox = yield* TessayaPhoneInbox;
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
      // A desktop that answers to another server is not changed from here, and she is told so.
      desktop.connected = false;
      const away = yield* setSetting({ key: "showWords", value: true, why: "x", who: "Tessaya" });
      assert.strictEqual(away.status, "failed");
      assert.include(away.line, "not connected to this server");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "reaches the desktop's own Settings by voice: its voice speed and its chime (13 Nov)",
  () => {
    const { controlled, layer } = setup();
    return Effect.gen(function* () {
      const all = yield* allSettings;
      // The closest few go to the model, which picks by meaning.
      assert.include(
        findSettings("make her voice slower", all).map((s) => s.key),
        "desktop:v.rate",
      );
      assert.strictEqual(
        findSettings("turn off the listening chime", all)[0]?.key,
        "desktop:v.chime",
      );
      const slower = yield* setSetting({
        key: "desktop:v.rate",
        value: "Slower",
        why: "x",
        who: "Tessaya",
      });
      assert.strictEqual(slower.status, "done");
      const quiet = yield* setSetting({
        key: "desktop:v.chime",
        value: "off",
        why: "x",
        who: "Tessaya",
      });
      assert.strictEqual(quiet.status, "done");
      assert.deepStrictEqual(controlled, [
        { id: "v.rate", value: "slower" },
        { id: "v.chime", value: false },
      ]);
      const wrong = yield* setSetting({
        key: "desktop:v.rate",
        value: "loud",
        why: "x",
        who: "Tessaya",
      });
      assert.strictEqual(wrong.status, "refused");
    }).pipe(Effect.provide(layer));
  },
);
