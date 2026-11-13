import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TurnOrigin } from "../baton/TessayaTurn.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { DESK_REPLAY_CLIENT, ROOM_CLIENT } from "../mcp/toolkits/home/handlers.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { asForwarded, fromPeers, onPeer } from "./PeerVessels.ts";

const link = (id: string, label: string) => ({
  environmentId: EnvironmentId.make(id),
  label,
  status: "reachable",
});

/** His two other servers; the laptop holds the setting, the studio does not. */
const peers = (sent: Array<[string, string, unknown]>) =>
  Layer.mergeAll(
    Layer.mock(PeerLinks.PeerLinks)({
      enabled: Effect.succeed(true),
      list: Effect.succeed([link("env-studio", "studio"), link("env-laptop", "laptop")] as never),
    }),
    Layer.mock(PeerMcpClient.PeerMcpClient)({
      call: (input) =>
        Effect.sync(() => {
          sent.push([input.environmentId, input.tool, input.arguments]);
          return input.environmentId === "env-laptop"
            ? { status: "done", line: "Changed the chime." }
            : { status: "refused", line: "No setting is called desktop:chime; use settings_find." };
        }) as never,
    }),
  );

const as = (client: McpInvocationContext.McpClientCaller | undefined) =>
  Effect.provideService(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("env-home"),
    requestNamespace: "x",
    thread: undefined,
    client,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  });

const takes = (value: unknown) =>
  !String((value as { line?: string }).line).startsWith("No setting is called");

it.effect(
  "a vessel's setting asked on another server reaches the one that holds it, with the turn's vessel and his voice",
  () =>
    Effect.gen(function* () {
      const sent: Array<[string, string, unknown]> = [];
      const args = { key: "desktop:chime", value: false, why: "no chime", on: undefined };
      const found = yield* onPeer("settings_set", args, { takes }).pipe(
        Effect.provideService(TurnOrigin, {
          kind: "device",
          id: "r1",
          label: "R1",
          hisVoice: true,
        }),
        as(ROOM_CLIENT),
        Effect.provide(peers(sent)),
      );
      expect(found).toEqual({
        on: "laptop",
        value: { status: "done", line: "Changed the chime." },
      });
      expect(sent.map(([env, , a]) => [env, a])).toEqual(
        ["env-studio", "env-laptop"].map((env) => [
          env,
          { key: "desktop:chime", value: false, why: "no chime", origin: "R1", hisVoice: true },
        ]),
      );
      // `on` names the machine; a name that is none of his servers runs here.
      sent.length = 0;
      expect(
        yield* onPeer("settings_get", { key: "desktop:chime" }, { on: "Laptop", takes }).pipe(
          as(ROOM_CLIENT),
          Effect.provide(peers(sent)),
        ),
      ).toMatchObject({ on: "laptop" });
      expect(
        yield* onPeer("settings_get", { key: "x" }, { on: "home", takes }).pipe(
          as(ROOM_CLIENT),
          Effect.provide(peers(sent)),
        ),
      ).toBeNull();
      expect(sent.map(([env]) => env)).toEqual(["env-laptop"]);
      // An unverified voice carries no yes, and a find asks every server at once.
      sent.length = 0;
      const all = yield* fromPeers("settings_find", { text: "chime" }).pipe(
        Effect.provideService(TurnOrigin, {
          kind: "device",
          id: "r1",
          label: "R1",
          hisVoice: false,
        }),
        as(ROOM_CLIENT),
        Effect.provide(peers(sent)),
      );
      expect(all.map((a) => a.on)).toEqual(["studio", "laptop"]);
      expect(sent[0]![2]).toEqual({ text: "chime", origin: "R1" });
    }),
);

it.effect("never forwards a call that came over a link, or a rehearsal's", () =>
  Effect.gen(function* () {
    const sent: Array<[string, string, unknown]> = [];
    const linked = {
      sessionId: "peer",
      label: "T3 Code · home",
      access: "approval-required" as const,
      linked: true,
    };
    for (const client of [linked, DESK_REPLAY_CLIENT]) {
      expect(
        yield* onPeer("settings_set", { key: "desktop:chime" }, { takes }).pipe(
          as(client),
          Effect.provide(peers(sent)),
        ),
      ).toBeNull();
    }
    expect(sent).toEqual([]);
  }),
);

it.effect(
  "runs a forwarded call as the turn on the server that asked, and only for a linked caller",
  () =>
    Effect.gen(function* () {
      const origin = Effect.void.pipe(Effect.andThen(() => TurnOrigin));
      const input = { origin: "R1", hisVoice: true };
      const linked = {
        sessionId: "peer",
        label: "T3 Code · home",
        access: "approval-required" as const,
        linked: true,
      };
      expect(yield* asForwarded(input, origin).pipe(as(linked))).toEqual({
        kind: "mcp",
        id: "peer",
        label: "R1",
        hisVoice: true,
      });
      // An outside agent cannot claim his voice by sending the field.
      expect(
        yield* asForwarded(input, origin).pipe(
          as({ sessionId: "a", label: "Claude", access: "full-access" }),
        ),
      ).toBeNull();
    }),
);
