import { it } from "@effect/vitest";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { expect } from "vite-plus/test";

import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { syncOnce } from "./HouseholdSettings.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

it.effect(
  "a worker takes the brain's household settings, and its own edit is never reverted while the brain is away",
  () =>
    Effect.gen(function* () {
      const brain = yield* Layer.build(
        Layer.mergeAll(ServerSettingsService.layerTest(), SqlitePersistenceMemory),
      );
      const brainSettings = Context.get(brain, ServerSettingsService);
      yield* brainSettings.updateSettings({
        tessayaFeedback: "developer",
        tessayaExpression: true,
      });
      let reachable = true;
      let access = "full-access";
      const peers = Layer.mergeAll(
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
              reachable
                ? (receiveAtBrain(
                    input.arguments["op"] as never,
                    input.arguments["payload"],
                    access,
                  ).pipe(Effect.provideContext(brain)) as never)
                : Effect.fail(
                    new OrchestratorMcpFailure({ code: "orchestration_error", message: "away" }),
                  ),
          }),
        ),
      );
      const worker = yield* Layer.build(
        Layer.mergeAll(ServerSettingsService.layerTest(), SqlitePersistenceMemory, peers),
      );
      const here = Context.get(worker, ServerSettingsService);
      const sync = syncOnce.pipe(Effect.provideContext(worker));
      const sql = Context.get(worker, SqlClient.SqlClient);
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'brain')`;

      // 21 Nov: a worker had none of the brain's; the brain's copy is the one.
      expect(yield* sync).toBe("taken");
      expect((yield* here.getSettings).tessayaFeedback).toBe("developer");
      // An edit at the desk while the brain is away stays, minute after minute, and reaches it once it is back.
      yield* here.updateSettings({ tessayaFeedback: "silent" });
      reachable = false;
      expect(yield* sync).toBe("kept");
      expect(yield* sync).toBe("kept");
      expect((yield* here.getSettings).tessayaFeedback).toBe("silent");
      reachable = true;
      expect(yield* sync).toBe("sent");
      expect((yield* brainSettings.getSettings).tessayaFeedback).toBe("silent");
      expect(yield* sync).toBe("taken");
      // A link without full access gets nothing (the cleanup key travels with these settings).
      access = "approval-required";
      yield* brainSettings.updateSettings({ tessayaFeedback: "off" });
      expect(yield* sync).toBe("away");
      expect((yield* here.getSettings).tessayaFeedback).toBe("silent");
    }).pipe(Effect.scoped),
);
