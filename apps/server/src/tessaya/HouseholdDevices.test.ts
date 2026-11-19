import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { CallerSessionId, layer as householdDevices, signOutCaller } from "./HouseholdDevices.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

const at = DateTime.makeUnsafe("2026-11-20T12:00:00Z");
const office: PeerLinkSummary = {
  environmentId: EnvironmentId.make("office"),
  label: "office",
  urls: [],
  access: "approval-required",
  linkedAt: at,
  expiresAt: at,
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};
const session = (sessionId: string, label: string) => ({ sessionId, client: { label } }) as never;

it.effect(
  "a household phone signed out on one machine is signed out on her brain and every machine it links; an expiry is not",
  () =>
    Effect.gen(function* () {
      const device = "hd-abc123def456";
      const revokedOnBrain: Array<string> = [];
      const askedThere = yield* Deferred.make<{ environmentId: string; device: string }>();
      const brainAuth = {
        listSessions: () =>
          Effect.succeed([
            session("b-phone", `Phone · ${device}`),
            session("b-other", "Phone · hd-zzzzzzzzzzzz"),
            session("b-laptop", "Chrome"),
          ]),
        revokeSession: (id: string) => Effect.sync(() => (revokedOnBrain.push(id), true)),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
      const brainMcp = {
        call: (input: { environmentId: string; tool: string; arguments: { device: string } }) =>
          Deferred.succeed(askedThere, {
            environmentId: input.environmentId,
            device: input.arguments.device,
          }).pipe(Effect.as({ revoked: 1 })),
      } as unknown as PeerMcpClient.PeerMcpClient["Service"];
      const atBrain = (op: string, payload: unknown) =>
        receiveAtBrain(op as never, payload, "approval-required").pipe(
          Effect.provideService(EnvironmentAuth.EnvironmentAuth, brainAuth),
          Effect.provideService(PeerLinks.PeerLinks, {
            list: Effect.succeed([office]),
          } as unknown as PeerLinks.PeerLinks["Service"]),
          Effect.provideService(PeerMcpClient.PeerMcpClient, brainMcp),
          Effect.provide(Layer.fresh(SqlitePersistenceMemory)),
        );
      // This machine (the laptop) names "studio" its brain and reaches it over its link.
      const laptopLinks = {
        list: Effect.succeed([
          { ...office, environmentId: EnvironmentId.make("studio"), label: "studio" },
        ]),
      } as unknown as PeerLinks.PeerLinks["Service"];
      const laptopMcp = {
        call: (input: { tool: string; arguments: { op: string; payload: unknown } }) =>
          atBrain(input.arguments.op, input.arguments.payload),
      } as unknown as PeerMcpClient.PeerMcpClient["Service"];
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'studio')`;
      // Two sessions of the device here: one expires, one is signed out in Authorized clients.
      const store = {
        listActive: () =>
          Effect.succeed([
            session("l-old", `Phone · ${device}`),
            session("l-phone", `Phone · ${device}`),
          ]),
        streamChanges: Stream.fromIterable([
          { type: "clientRemoved" as const, sessionId: "l-old" },
          { type: "clientRemoved" as const, sessionId: "l-phone" },
        ]),
      } as unknown as SessionStore["Service"];
      const repo = {
        getById: ({ sessionId }: { sessionId: string }) =>
          Effect.succeedSome({ revokedAt: sessionId === "l-phone" ? at : null }),
      } as unknown as AuthSessionRepository["Service"];

      const asked = yield* Deferred.await(askedThere).pipe(
        Effect.provide(
          householdDevices.pipe(
            Layer.provide(Layer.succeed(SessionStore, store)),
            Layer.provide(Layer.succeed(AuthSessionRepository, repo)),
            Layer.provide(Layer.succeed(PeerLinks.PeerLinks, laptopLinks)),
            Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, laptopMcp)),
          ),
        ),
      );
      expect(asked).toEqual({ environmentId: "office", device });
      expect(revokedOnBrain).toEqual(["b-phone"]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "the phone signing itself out of the household is signed out on every machine; one paired before households only here",
  () =>
    Effect.gen(function* () {
      const device = "hd-fedcba987654";
      const askedThere: Array<string> = [];
      const revoked: Array<string> = [];
      const auth = {
        listSessions: () =>
          Effect.succeed([session("p-1", `Phone · ${device}`), session("old", "Phone")]),
        revokeSession: (id: string) => Effect.sync(() => (revoked.push(id), true)),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
      const mcp = {
        call: (input: { environmentId: string }) =>
          Effect.sync(() => (askedThere.push(input.environmentId), { revoked: 1 })),
      } as unknown as PeerMcpClient.PeerMcpClient["Service"];
      const signOut = (sessionId: string) =>
        signOutCaller().pipe(
          Effect.provideService(CallerSessionId, sessionId),
          Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
          Effect.provideService(PeerLinks.PeerLinks, {
            list: Effect.succeed([office]),
          } as unknown as PeerLinks.PeerLinks["Service"]),
          Effect.provideService(PeerMcpClient.PeerMcpClient, mcp),
        );
      expect(yield* signOut("p-1")).toEqual({ everywhere: true });
      expect(askedThere).toEqual(["office"]);
      expect(revoked).toContain("p-1");
      expect(yield* signOut("old")).toEqual({ everywhere: false });
      expect(askedThere).toEqual(["office"]);
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistenceMemory))),
);
