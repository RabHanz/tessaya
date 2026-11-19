import {
  AuthStandardClientScopes,
  EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { issue, mayAskHere } from "./PhonePairing.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

const at = DateTime.makeUnsafe("2026-11-16T12:00:00Z");
const link = (
  id: string,
  access: PeerLinkSummary["access"],
  status: PeerLinkSummary["status"] = "reachable",
): PeerLinkSummary => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  urls: [],
  access,
  linkedAt: at,
  expiresAt: at,
  lastReachedAt: null,
  lastError: null,
  status,
});
const ADDRESSES: Record<string, string> = {
  studio: "https://studio.example.com",
  office: "https://office.example.com",
  laptop: "https://laptop.example.com",
  local: "http://127.0.0.1:3773",
};

it("lets only a linked machine whose link and call are both full access ask for a phone's code", () => {
  const client = (access: "full-access" | "auto", linked: boolean, narrowed?: "auto") => ({
    sessionId: "s",
    label: "peer",
    access,
    linked,
    ...(narrowed === undefined
      ? {}
      : { narrowedTo: { runtimeMode: narrowed, interactionMode: "default" as const } }),
  });
  expect(mayAskHere(undefined)).toBe(false);
  expect(mayAskHere(client("full-access", false))).toBe(false);
  expect(mayAskHere(client("auto", true))).toBe(false);
  expect(mayAskHere(client("full-access", true, "auto"))).toBe(false);
  expect(mayAskHere(client("full-access", true))).toBe(true);
});

it.effect(
  "mints a one-time standard code here and asks each full-access link for its own, saying why the rest are left out",
  () =>
    Effect.gen(function* () {
      const asked: Array<
        Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]>[0]
      > = [];
      const auth = {
        createPairingLink: (input: (typeof asked)[number]) => {
          asked.push(input);
          return Effect.succeed({
            id: "here-1",
            credential: "HERECODE",
            scopes: AuthStandardClientScopes,
            subject: "one-time-token",
            label: "Phone",
            createdAt: at,
            expiresAt: at,
          });
        },
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
      const links = {
        enabled: Effect.succeed(true),
        list: Effect.succeed([
          link("studio", "full-access"),
          link("office", "full-access"),
          link("laptop", "approval-required"),
          link("old", "full-access", "expired"),
          link("local", "full-access"),
        ]),
        resolve: (id: string) =>
          Effect.succeed({ link: link(id, "full-access"), url: ADDRESSES[id]!, token: "t" }),
      } as unknown as PeerLinks.PeerLinks["Service"];
      const mcp = {
        call: (input: { readonly environmentId: string }) =>
          input.environmentId === "office"
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "The linked environment stopped answering.",
                }),
              )
            : Effect.succeed({ credential: `CODE-${input.environmentId}`, expiresAt: at }),
      } as unknown as PeerMcpClient.PeerMcpClient["Service"];

      const result = yield* issue().pipe(
        Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
        Effect.provideService(PeerLinks.PeerLinks, links),
        Effect.provideService(PeerMcpClient.PeerMcpClient, mcp),
      );

      expect(asked).toHaveLength(1);
      expect(asked[0]?.scopes).toEqual(AuthStandardClientScopes);
      expect(Duration.toMinutes(Option.getOrThrow(Duration.fromInput(asked[0]!.ttl!)))).toBe(10);
      expect(result.here.credential).toBe("HERECODE");
      expect(result.linked).toEqual([
        {
          environmentId: "studio",
          label: "studio",
          pairingUrl: "https://studio.example.com/pair#token=CODE-studio",
          expiresAt: at,
        },
      ]);
      expect(result.missed.map((miss) => miss.label).toSorted()).toEqual([
        "laptop",
        "local",
        "office",
        "old",
      ]);
      expect(result.missed.find((miss) => miss.label === "office")?.reason).toBe(
        "The linked environment stopped answering.",
      );
    }),
);

it.effect(
  "on a machine that is not her brain, one pairing also carries the brain's code and its machines', all one household device",
  () =>
    Effect.gen(function* () {
      const labels: Array<string | undefined> = [];
      const authOf = (code: string) =>
        ({
          createPairingLink: (input: { readonly label?: string }) => {
            labels.push(input.label);
            return Effect.succeed({
              id: `${code}-1`,
              credential: code,
              scopes: AuthStandardClientScopes,
              subject: "one-time-token",
              label: input.label,
              createdAt: at,
              expiresAt: at,
            });
          },
        }) as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
      const linksOf = (listed: ReadonlyArray<PeerLinkSummary>) =>
        ({
          enabled: Effect.succeed(true),
          list: Effect.succeed(listed),
          resolve: (id: string) =>
            Effect.succeed({ link: link(id, "full-access"), url: ADDRESSES[id]!, token: "t" }),
        }) as unknown as PeerLinks.PeerLinks["Service"];
      const env = (id: string) =>
        ({
          getEnvironmentId: Effect.succeed(EnvironmentId.make(id)),
        }) as unknown as ServerEnvironment.ServerEnvironment["Service"];
      // Her brain ("studio") links the laptop (this machine) and the office; it mints its own code and asks the office.
      const brainMcp = {
        call: (input: {
          readonly environmentId: string;
          readonly arguments: { device?: string };
        }) =>
          Effect.succeed({
            credential: `CODE-${input.environmentId}-${input.arguments.device}`,
            expiresAt: at,
          }),
      } as unknown as PeerMcpClient.PeerMcpClient["Service"];
      const atBrain = (payload: unknown, access: string) =>
        receiveAtBrain("phoneCodes", payload, access).pipe(
          Effect.provideService(EnvironmentAuth.EnvironmentAuth, authOf("BRAINCODE")),
          Effect.provideService(
            PeerLinks.PeerLinks,
            linksOf([link("laptop", "full-access"), link("office", "full-access")]),
          ),
          Effect.provideService(PeerMcpClient.PeerMcpClient, brainMcp),
          Effect.provideService(ServerEnvironment.ServerEnvironment, env("studio")),
          // its own database: no home named, so it is the brain
          Effect.provide(Layer.fresh(SqlitePersistenceMemory)),
        );
      // The laptop reaches the brain over its link with full access, as the brain tool does.
      const laptopMcp = {
        call: (input: {
          readonly tool: string;
          readonly arguments: { op: string; payload: unknown };
        }) =>
          input.tool === "tessaya_brain"
            ? atBrain(input.arguments.payload, "full-access")
            : Effect.die("the laptop asks only its brain here"),
      } as unknown as PeerMcpClient.PeerMcpClient["Service"];
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'studio')`;

      const result = yield* issue().pipe(
        Effect.provideService(EnvironmentAuth.EnvironmentAuth, authOf("HERECODE")),
        Effect.provideService(PeerLinks.PeerLinks, linksOf([link("studio", "full-access")])),
        Effect.provideService(PeerMcpClient.PeerMcpClient, laptopMcp),
        Effect.provideService(ServerEnvironment.ServerEnvironment, env("laptop")),
      );

      expect(result.device).toMatch(/^hd-[a-z0-9]{12}$/);
      expect(result.brain).toBe("studio");
      // Every code of this pairing carries the one device: a sign-out anywhere finds them all.
      expect(labels).toEqual([`Phone · ${result.device}`, `Phone · ${result.device}`]);
      expect(result.linked.map((l) => [l.environmentId, l.pairingUrl])).toEqual([
        ["studio", "https://studio.example.com/pair#token=BRAINCODE"],
        ["office", `https://office.example.com/pair#token=CODE-office-${result.device}`],
      ]);
      expect(result.missed).toEqual([]);
      // A link with less than full access gets no codes from the brain.
      const refused = yield* atBrain({ device: result.device, skip: [] }, "approval-required");
      expect(refused.ok).toBe(false);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
