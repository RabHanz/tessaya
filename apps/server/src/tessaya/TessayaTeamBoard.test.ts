// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { ProjectId, WorkSessionId } from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaEngine } from "./TessayaEngine.ts";
import { TessayaJobService, layer as jobLayer } from "./TessayaJobService.ts";
import {
  TessayaMemoryService,
  MemoryViewer,
  layer as memoryLayer,
} from "./TessayaMemoryService.ts";
import { TessayaRecordService, layer as recordLayer } from "./TessayaRecordService.ts";
import { teamBoard } from "./TessayaTeamBoard.ts";
import { WorkSessionService, layer as workSessionLayer } from "./WorkSessionService.ts";

const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-team-"));
NodeFS.mkdirSync(NodePath.join(userdata, "operating-system"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(userdata, "operating-system", "executive.md"),
  "---\nwalled: vault\n---\n",
);

const layer = it.layer(
  memoryLayer.pipe(
    Layer.provideMerge(jobLayer),
    Layer.provideMerge(workSessionLayer),
    Layer.provideMerge(recordLayer),
    Layer.provideMerge(
      Layer.succeed(TessayaEngine, {
        projects: Effect.succeed([
          { id: "p-shop", title: "shop" },
          { id: "p-vault", title: "vault" },
        ]),
      } as unknown as TessayaEngine["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerConfig.ServerConfig, {
        dbPath: NodePath.join(userdata, "statev2.sqlite"),
      } as unknown as ServerConfig.ServerConfig["Service"]),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("the team board (P4)", (it) => {
  it.effect(
    "shows each persona's current jobs, latest conversation and Record lines, behind the walls, and only busy for a private one",
    () =>
      Effect.gen(function* () {
        const jobs = yield* TessayaJobService;
        const sessions = yield* WorkSessionService;
        const job = (id: string, project: string, title: string, persona: string) =>
          jobs.create({
            id: WorkSessionId.make(id),
            projectId: ProjectId.make(project),
            title,
            goal: title,
            permissions: { folders: [], projects: [], tools: ["read"] },
            persona,
          });
        yield* job("j-1", "p-shop", "Ship the shop", "butler");
        yield* job("j-2", "p-vault", "Rotate the vault keys", "butler");
        yield* job("j-3", "p-shop", "Old release", "butler");
        // Sebastian's only work is walled, and one job is in a project nobody can name.
        yield* job("j-4", "p-vault", "Audit the vault", "alter-ego");
        yield* job("j-5", "p-gone", "Lost project work", "companion");
        yield* sessions.settle({ id: WorkSessionId.make("j-3") });
        const memory = yield* TessayaMemoryService;
        yield* memory.add({
          kind: "episode",
          text: "Monday, 2 November 2026, with Freya: he booked dinner for eight",
          source: "thread",
          sourceRef: "conversation:companion:1-2",
        });
        yield* memory.add({
          kind: "episode",
          text: "Tuesday, 3 November 2026, with Freya: the venue is booked from six",
          source: "thread",
          sourceRef: "conversation:companion:3-4",
          scope: "project",
          scopeRef: "vault",
        });
        const record = yield* TessayaRecordService;
        yield* record.append({
          kind: "job",
          actor: "Alfred",
          project: "shop",
          subject: "Ship the shop",
          outcome: "done",
        });
        yield* record.append({
          kind: "job",
          actor: "Alfred",
          project: "vault",
          subject: "Rotate the vault keys",
          outcome: "started",
        });

        // An outside agent's view (the MCP tool): walls hold, and no persona can be named.
        const outside = yield* teamBoard({ agent: "executive", admin: true }).pipe(
          Effect.provideService(MemoryViewer, "client"),
        );
        const alfred = outside.members.find((m) => m.id === "butler")!;
        assert.deepEqual(
          alfred.jobs.map((j) => j.title),
          ["Ship the shop"],
        );
        assert.isTrue(alfred.busy);
        assert.deepEqual(
          alfred.recent.map((r) => r.subject),
          ["Ship the shop"],
        );
        assert.strictEqual(
          alfred.role,
          "life, home and admin: his calendar, errands, bookings, bills and paperwork",
        );
        const freya = outside.members.find((m) => m.id === "companion")!;
        assert.include(freya.episode?.text ?? "", "dinner for eight");
        // A project it cannot name counts as walled, and work it may not see does not show as busy either.
        assert.deepEqual(freya.jobs, []);
        assert.isFalse(freya.busy);
        assert.isFalse(outside.members.find((m) => m.id === "alter-ego")!.busy);

        // His own Now page sees through the walls.
        const his = yield* teamBoard({ admin: true }).pipe(
          Effect.provideService(MemoryViewer, "desktop"),
        );
        const all = his.members.find((m) => m.id === "butler")!;
        assert.sameMembers(
          all.jobs.map((j) => j.title),
          ["Ship the shop", "Rotate the vault keys"],
        );
        assert.include(
          his.members.find((m) => m.id === "companion")?.episode?.text ?? "",
          "venue is booked",
        );

        // A private persona (P5's flag) shows only whether it is busy.
        const hidden = yield* teamBoard({ admin: true }, (id) => id === "butler").pipe(
          Effect.provideService(MemoryViewer, "desktop"),
        );
        assert.deepInclude(
          hidden.members.find((m) => m.id === "butler"),
          {
            private: true,
            busy: true,
            jobs: [],
            episode: null,
            recent: [],
          },
        );
      }),
  );
});
