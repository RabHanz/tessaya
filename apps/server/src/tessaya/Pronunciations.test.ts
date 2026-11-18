// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { pronunciations } from "./Pronunciations.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

it.layer(Layer.mergeAll(SqlitePersistenceMemory, ServerSettingsService.layerTest()))(
  "his pronunciations on the brain",
  (it) => {
    it.effect("a worker's teach and read land in the brain's one list; a worker keeps none", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* receiveAtBrain("pronounce", { word: "Kazi", sayAs: "Kah-zee" }),
          { ok: true, value: { Kazi: "Kah-zee" } },
        );
        assert.deepStrictEqual((yield* (yield* ServerSettingsService).getSettings).voicePronounce, {
          Kazi: "Kah-zee",
        });
        assert.deepStrictEqual(yield* receiveAtBrain("pronounce", {}), {
          ok: true,
          value: { Kazi: "Kah-zee" },
        });
        // A word alone goes back to the voice's own way.
        assert.deepStrictEqual(yield* receiveAtBrain("pronounce", { word: "Kazi" }), {
          ok: true,
          value: {},
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'home-box')`;
        assert.isFalse((yield* receiveAtBrain("pronounce", { word: "Kazi", sayAs: "x" })).ok);
        yield* sql`DELETE FROM fabric_settings WHERE key = ${HOME_KEY}`;
      }),
    );
  },
);

it.layer(NodeServices.layer)("a worker's pronunciations move to the brain", (it) => {
  it.effect(
    "its own list goes up first, additively, with a copy kept; the brain's own words win",
    () =>
      Effect.gen(function* () {
        const brain = yield* Layer.build(
          Layer.mergeAll(
            SqlitePersistenceMemory,
            ServerSettingsService.layerTest({ voicePronounce: { Onyx: "On ix", Kazi: "Kah zee" } }),
          ),
        );
        const base = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3code-pronounce-",
        });
        const config = ServerConfig.layerTest(process.cwd(), base);
        const worker = yield* Layer.build(
          Layer.mergeAll(
            SqlitePersistenceMemory,
            config,
            ServerSettingsService.layerTest({
              voicePronounce: { Kazi: "Kazzy", Tessaya: "Tess eye ya" },
            }),
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
          ),
        );
        const sql = Context.get(worker, SqlClient.SqlClient);
        yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'brain')`;
        const list = yield* pronunciations().pipe(Effect.provideContext(worker));
        assert.deepStrictEqual(Option.getOrUndefined(list), {
          Kazi: "Kah zee",
          Onyx: "On ix",
          Tessaya: "Tess eye ya",
        });
        // Moved, not copied: the worker's own is empty now, and what it held is kept beside its state.
        const { stateDir } = yield* ServerConfig.ServerConfig.pipe(Effect.provide(config));
        assert.deepStrictEqual(
          JSON.parse(
            NodeFS.readFileSync(
              NodePath.join(stateDir, "voice", "pronounce.before-brain.json"),
              "utf8",
            ),
          ),
          { Kazi: "Kazzy", Tessaya: "Tess eye ya" },
        );
        assert.deepStrictEqual(
          (yield* Context.get(worker, ServerSettingsService).getSettings).voicePronounce,
          {},
        );
      }).pipe(Effect.scoped),
  );
});
