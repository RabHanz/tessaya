import { it } from "@effect/vitest";
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
import type { CastView } from "@t3tools/tessaya-contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

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
  "one Cast on her brain: a worker's rule moves up once with a copy kept, and its calls change the brain's",
  () =>
    Effect.gen(function* () {
      // the brain has its own store (a worker's would make it think it isn't the brain)
      const brain = yield* Layer.build(Layer.mergeAll(setup().layer, SqlitePersistenceMemory));
      const base = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3code-cast-",
      });
      const worker = yield* Layer.build(
        castLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(DeviceRegistry)(
                DeviceRegistry.of({
                  list: Effect.succeed([device("desk-2", "desktop", "Laptop")]),
                } as never),
              ),
              ServerSettingsService.layerTest({
                tessayaCast: { "r1-tumble": { home: "engineering" } },
              }),
              CurrentPersona.layer,
              ServerConfig.layerTest(process.cwd(), base),
              Layer.succeed(PeerLinks.PeerLinks, {
                enabled: Effect.succeed(true),
                list: Effect.succeed([
                  { ...descriptorOf("env-brain", "brain"), label: "brain", status: "ok" } as never,
                ]),
              } as never),
              Layer.succeed(
                PeerMcpClient.PeerMcpClient,
                PeerMcpClient.PeerMcpClient.of({
                  call: (input) =>
                    receiveAtBrain(input.arguments["op"] as never, input.arguments["payload"]).pipe(
                      Effect.provideContext(brain),
                    ) as never,
                }),
              ),
              SqlitePersistenceMemory,
            ),
          ),
        ),
      );
      const sql = Context.get(worker, SqlClient.SqlClient);
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'brain')`;
      const onWorker = (e: Effect.Effect<CastView, string, TessayaCast>) =>
        e.pipe(Effect.provideContext(worker));
      // the worker sees Tumble as the brain holds it, its rule moved up: one rule, on the brain
      const seen = yield* onWorker(Effect.flatMap(TessayaCast, (c) => c.view));
      expect(body(seen, "r1-tumble").home).toBe("engineering");
      expect(
        (yield* Effect.flatMap(ServerSettingsService, (s) => s.getSettings).pipe(
          Effect.provideContext(worker),
        )).tessayaCast,
      ).toEqual({});
      expect(
        (yield* Effect.flatMap(ServerSettingsService, (s) => s.getSettings).pipe(
          Effect.provideContext(brain),
        )).tessayaCast["r1-tumble"],
      ).toEqual({ home: "engineering" });
      // his change from the worker lands on the brain; its own desktop stays answered where it syncs
      yield* onWorker(
        Effect.flatMap(TessayaCast, (c) =>
          c.call({ op: "home", body: "Tumble", persona: "companion" }, true),
        ),
      );
      expect(
        body(
          yield* Effect.flatMap(TessayaCast, (c) => c.view).pipe(Effect.provideContext(brain)),
          "r1-tumble",
        ).home,
      ).toBe("companion");
      expect(
        (yield* onWorker(Effect.flatMap(TessayaCast, (c) => c.view))).bodies.map((b) => b.id),
      ).toContain("desk-2");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
