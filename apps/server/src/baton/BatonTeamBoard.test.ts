// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { ProjectId, WorkSessionId } from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { BatonJobService, layer as jobLayer } from "./BatonJobService.ts";
import { BatonMemoryService, MemoryViewer, layer as memoryLayer } from "./BatonMemoryService.ts";
import { BatonRecordService, layer as recordLayer } from "./BatonRecordService.ts";
import { teamBoard } from "./BatonTeamBoard.ts";
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
      Layer.succeed(BatonEngine, {
        projects: Effect.succeed([
          { id: "p-shop", title: "shop" },
          { id: "p-vault", title: "vault" },
        ]),
      } as unknown as BatonEngine["Service"]),
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
        const jobs = yield* BatonJobService;
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
        yield* job("j-1", "p-shop", "Ship the shop", "engineering");
        yield* job("j-2", "p-vault", "Rotate the vault keys", "engineering");
        yield* job("j-3", "p-shop", "Old release", "engineering");
        // Sebastian's only work is walled, and one job is in a project nobody can name.
        yield* job("j-4", "p-vault", "Audit the vault", "research");
        yield* job("j-5", "p-gone", "Lost project work", "operations");
        yield* sessions.settle({ id: WorkSessionId.make("j-3") });
        const memory = yield* BatonMemoryService;
        yield* memory.add({
          kind: "episode",
          text: "Monday, 2 November 2026, with Freya: he booked dinner for eight",
          source: "thread",
          sourceRef: "conversation:operations:1-2",
        });
        yield* memory.add({
          kind: "episode",
          text: "Tuesday, 3 November 2026, with Freya: the venue is booked from six",
          source: "thread",
          sourceRef: "conversation:operations:3-4",
          scope: "project",
          scopeRef: "vault",
        });
        const record = yield* BatonRecordService;
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
        const alfred = outside.members.find((m) => m.id === "engineering")!;
        assert.deepEqual(
          alfred.jobs.map((j) => j.title),
          ["Ship the shop"],
        );
        assert.isTrue(alfred.busy);
        assert.deepEqual(
          alfred.recent.map((r) => r.subject),
          ["Ship the shop"],
        );
        assert.strictEqual(alfred.role, "sessions, builds and releases");
        const freya = outside.members.find((m) => m.id === "operations")!;
        assert.include(freya.episode?.text ?? "", "dinner for eight");
        // A project it cannot name counts as walled, and work it may not see does not show as busy either.
        assert.deepEqual(freya.jobs, []);
        assert.isFalse(freya.busy);
        assert.isFalse(outside.members.find((m) => m.id === "research")!.busy);

        // His own Now page sees through the walls.
        const his = yield* teamBoard({ admin: true }).pipe(
          Effect.provideService(MemoryViewer, "desktop"),
        );
        const all = his.members.find((m) => m.id === "engineering")!;
        assert.sameMembers(
          all.jobs.map((j) => j.title),
          ["Ship the shop", "Rotate the vault keys"],
        );
        assert.include(
          his.members.find((m) => m.id === "operations")?.episode?.text ?? "",
          "venue is booked",
        );

        // A private persona (P5's flag) shows only whether it is busy.
        const hidden = yield* teamBoard({ admin: true }, (id) => id === "engineering").pipe(
          Effect.provideService(MemoryViewer, "desktop"),
        );
        assert.deepInclude(
          hidden.members.find((m) => m.id === "engineering"),
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
