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
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { issue, mayAskHere } from "./PhonePairing.ts";

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
  hetzner: "https://hetzner.example.ts.net",
  onnyx: "https://onnyx.example.ts.net",
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
        createPairingLink: (input) => {
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
      } as EnvironmentAuth.EnvironmentAuth["Service"];
      const links = {
        enabled: Effect.succeed(true),
        list: Effect.succeed([
          link("hetzner", "full-access"),
          link("onnyx", "full-access"),
          link("laptop", "approval-required"),
          link("old", "full-access", "expired"),
          link("local", "full-access"),
        ]),
        resolve: (id) =>
          Effect.succeed({ link: link(id, "full-access"), url: ADDRESSES[id]!, token: "t" }),
      } as PeerLinks.PeerLinks["Service"];
      const mcp = {
        call: (input) =>
          input.environmentId === "onnyx"
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "The linked environment stopped answering.",
                }),
              )
            : Effect.succeed({ credential: `CODE-${input.environmentId}`, expiresAt: at }),
      } as PeerMcpClient.PeerMcpClient["Service"];

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
          environmentId: "hetzner",
          label: "hetzner",
          pairingUrl: "https://hetzner.example.ts.net/pair#token=CODE-hetzner",
          expiresAt: at,
        },
      ]);
      expect(result.missed.map((miss) => miss.label).toSorted()).toEqual([
        "laptop",
        "local",
        "old",
        "onnyx",
      ]);
      expect(result.missed.find((miss) => miss.label === "onnyx")?.reason).toBe(
        "The linked environment stopped answering.",
      );
    }),
);
