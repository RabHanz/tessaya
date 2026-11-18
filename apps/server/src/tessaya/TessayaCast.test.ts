import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { DeviceSync } from "../home/DeviceSync.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CurrentPersona from "./CurrentPersona.ts";
import { TessayaCast, layer as castLayer } from "./TessayaCast.ts";
import { TessayaDesktopSettings } from "./TessayaDesktopSettings.ts";

const device = (deviceId: string, kind: string, name: string, member?: string) =>
  ({
    deviceId,
    kind,
    name,
    firmware: null,
    via: kind === "desktop" ? "client" : "mqtt",
    online: true,
    lastSeenAt: null,
    version: null,
    items: [],
    values: [],
    ...(member === undefined ? {} : { member }),
  }) as const;

const setup = (extra: Layer.Layer<DeviceSync> | Layer.Layer<never> = Layer.empty) => {
  const controls: Array<{ id: string; value: string | boolean }> = [
    { id: "v.mascotPersona", value: "freya" },
    { id: "v.mascotFollows", value: false },
    { id: "v.mascotCrew", value: "none" },
  ];
  const devices = [
    device("r1-tumble", "agora-r1", "Tumble"),
    device("desk-1", "desktop", "Desk", "owner"),
  ];
  const registry = Layer.succeed(DeviceRegistry)(
    DeviceRegistry.of({ list: Effect.succeed(devices) } as never),
  );
  const desktop = Layer.succeed(TessayaDesktopSettings)(
    TessayaDesktopSettings.of({
      get: Effect.sync(() => ({ controls }) as never),
      setControls: (changes: ReadonlyArray<{ id: string; value: string | boolean }>) =>
        Effect.sync(() => {
          for (const c of changes) {
            const at = controls.findIndex((x) => x.id === c.id);
            controls[at] = { id: c.id, value: c.value };
          }
          return {} as never;
        }),
    } as never),
  );
  const layer = castLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        registry,
        desktop,
        ServerSettingsService.layerTest(),
        CurrentPersona.layer,
        extra,
      ),
    ),
  );
  return { controls, layer };
};

const body = (view: { bodies: ReadonlyArray<{ id: string }> }, id: string) =>
  view.bodies.find((b) => b.id === id) as unknown as {
    wearing: string | null;
    why: string;
    on: ReadonlyArray<string>;
    home: string | null;
  };

it.effect(
  "a called persona visits a Tessel for the conversation, returns home after, and stays when asked",
  () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const cast = yield* TessayaCast;
      const told: Array<[string, string | null]> = [];
      yield* cast.listen((b, p) => Effect.sync(() => void told.push([b, p])));
      yield* cast.call({ op: "home", body: "Tumble", persona: "Freya" }, true);
      expect(body(yield* cast.view, "r1-tumble")).toMatchObject({
        wearing: "companion",
        why: "home",
      });
      yield* cast.call({ op: "call", body: "r1-tumble", persona: "alfred", stay: false }, true);
      expect(yield* cast.wearing("r1-tumble")).toBe("butler");
      expect(told.at(-1)).toEqual(["r1-tumble", "butler"]);
      // A turn keeps the visit while the conversation goes on; ten quiet minutes later it is home again.
      yield* TestClock.adjust("8 minutes");
      yield* cast.touch("r1-tumble");
      yield* TestClock.adjust("8 minutes");
      expect(yield* cast.wearing("r1-tumble")).toBe("butler");
      yield* TestClock.adjust("3 minutes");
      expect(body(yield* cast.view, "r1-tumble")).toMatchObject({
        wearing: "companion",
        why: "home",
      });
      expect(told.at(-1)).toEqual(["r1-tumble", "companion"]);
      // "Stay": it holds past the conversation until he sends everyone home.
      yield* cast.call({ op: "call", body: "Tumble", persona: "onyx", stay: true }, true);
      yield* TestClock.adjust("1 hour");
      expect(body(yield* cast.view, "r1-tumble")).toMatchObject({
        wearing: "engineering",
        why: "stay",
      });
      yield* cast.call({ op: "sendHome" }, true);
      expect(yield* cast.wearing("r1-tumble")).toBe("companion");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("never moves a body for an unverified voice, so a false wake can't re-home it", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const cast = yield* TessayaCast;
    const refused = yield* Effect.flip(
      cast.call({ op: "home", body: "Tumble", persona: "alfred" }, false),
    );
    expect(refused).toContain("voice she knows");
    expect(body(yield* cast.view, "r1-tumble")).toMatchObject({ home: null, why: "lead" });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a visit for this conversation is a switch, not an act: any untainted turn may ask",
  () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const cast = yield* TessayaCast;
      // "Yes." to "want me to bring him here?" was refused for a voice too short to verify (18 Nov, 05:52).
      yield* cast.call({ op: "call", body: "Tumble", persona: "alfred", stay: false }, false, true);
      expect(yield* cast.wearing("r1-tumble")).toBe("butler");
      // Keeping it there is lasting, and her own echo never moves anyone.
      const stay = { op: "call", body: "Tumble", persona: "onyx", stay: true } as const;
      expect(yield* Effect.flip(cast.call(stay, false, true))).toContain("voice she knows");
      const echo = { op: "call", body: "Tumble", persona: "onyx", stay: false } as const;
      expect(yield* Effect.flip(cast.call(echo, false, false))).toContain("voice she knows");
      expect(yield* cast.wearing("r1-tumble")).toBe("butler");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "puts several on the desktop from its own companion settings, and a call stands beside her",
  () => {
    const { layer, controls } = setup();
    return Effect.gen(function* () {
      const cast = yield* TessayaCast;
      yield* cast.call({ op: "crew", body: "desk-1", personas: ["Alfred", "onyx"] }, true);
      expect(controls.find((c) => c.id === "v.mascotCrew")?.value).toBe("butler,engineering");
      expect(body(yield* cast.view, "desk-1").on).toEqual(["companion", "butler", "engineering"]);
      yield* cast.call({ op: "crew", body: "desk-1", personas: [] }, true);
      yield* cast.call({ op: "call", body: "Desk", persona: "Sebastian", stay: false }, true);
      expect(body(yield* cast.view, "desk-1")).toMatchObject({
        wearing: "companion",
        why: "visit",
        on: ["companion", "alter-ego"],
      });
      yield* cast.call({ op: "sendHome", body: "desk-1" }, true);
      expect(controls.find((c) => c.id === "v.mascotCrew")?.value).toBe("none");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "shares a Tessel's visit with his other servers, and takes the newer one of theirs",
  () => {
    const puts: Array<[string, string, unknown]> = [];
    let applier: ((field: string, v: unknown, at: number) => Effect.Effect<void>) | null = null;
    const sync = Layer.succeed(DeviceSync)(
      DeviceSync.of({
        put: (record: string, field: string, v: unknown) =>
          Effect.sync(() => void puts.push([record, field, v])),
        onRecord: (
          _record: string,
          apply: (field: string, v: unknown, at: number) => Effect.Effect<void>,
        ) => Effect.sync(() => void (applier = apply)),
      } as never),
    );
    const { layer } = setup(sync);
    return Effect.gen(function* () {
      const cast = yield* TessayaCast;
      yield* cast.call({ op: "call", body: "Tumble", persona: "alfred", stay: true }, true);
      const first = yield* Clock.currentTimeMillis;
      expect(puts.at(-1)).toEqual([
        "@cast",
        "body:r1-tumble",
        { persona: "butler", stay: true, at: first },
      ]);
      // Each turn re-stamps it, so his other servers keep it as long as this one does.
      yield* TestClock.adjust("5 minutes");
      yield* cast.touch("r1-tumble");
      expect((puts.at(-1)![2] as { at: number }).at).toBeGreaterThan(first);
      yield* cast.call({ op: "sendHome" }, true);
      expect(puts.at(-1)).toEqual(["@cast", "body:r1-tumble", null]);
      const now = yield* Clock.currentTimeMillis;
      yield* applier!("body:r1-tumble", { persona: "alter-ego", stay: false }, now);
      expect(yield* cast.wearing("r1-tumble")).toBe("alter-ego");
      yield* applier!("body:r1-tumble", null, now + 1);
      expect(body(yield* cast.view, "r1-tumble").why).toBe("lead");
    }).pipe(Effect.provide(layer));
  },
);
