import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { AuthBatonHandsHostScope, AuthStandardClientScopes } from "@t3tools/contracts";
import { BatonMemoryService, MemoryViewer } from "./BatonMemoryService.ts";
import { BatonPrivateMemoryService, PrivateCaller } from "./BatonPrivateMemoryService.ts";
import type { RoomToolSet } from "../home/R1Brain.ts";
import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { DeskTools } from "../home/R1Tools.ts";
import { BatonRuntime } from "./BatonRpcHandlers.ts";
import { routes } from "./BatonTessayaRoutes.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

// The real router with the real routes: a path registered twice (a trailing-slash twin, say) throws when it is built, which
// is how the server crashed at start after the router changed under it.
const serve = (
  path: string,
  over: {
    readonly session?: EnvironmentAuth.AuthenticatedSession;
    readonly runtime?: Context.Context<never>;
    readonly init?: RequestInit;
    readonly deskTools?: RoomToolSet;
  } = {},
) =>
  Effect.gen(function* () {
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          routes.pipe(
            Layer.provide(Layer.succeed(BatonRuntime, (over.runtime ?? Context.empty()) as never)),
            Layer.provide(Layer.succeed(DeskTools, over.deskTools ?? null)),
            Layer.provide(
              Layer.succeed(ServerConfig.ServerConfig, {
                dbPath: "/nowhere/state.sqlite",
              } as never),
            ),
            Layer.provide(platformLayer),
            Layer.provideMerge(
              Layer.mock(EnvironmentAuth.EnvironmentAuth, {
                authenticateHttpRequest: () =>
                  over.session === undefined
                    ? Effect.fail(new Error("no session") as never)
                    : Effect.succeed(over.session),
              }),
            ),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    return yield* Effect.promise(() =>
      handler.handler(new Request(`http://t3.test${path}`, over.init)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("registers the phone routes without a duplicate and serves each of them", () =>
  Effect.gen(function* () {
    for (const [path, type] of [
      ["/tessaya", "text/html"],
      ["/tessaya/", "text/html"],
      ["/tessaya/app.js", "text/javascript"],
      ["/tessaya/sw.js", "text/javascript"],
      ["/tessaya/manifest.webmanifest", "application/manifest+json"],
    ] as const) {
      const response = yield* serve(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain(type);
    }
  }),
);

it.effect("keeps the API behind a session", () =>
  Effect.gen(function* () {
    expect((yield* serve("/tessaya/api/state")).status).toBe(401);
  }),
);

it.effect("tells memory who reads on the desktop's direct door, from the session", () =>
  Effect.gen(function* () {
    const readers: string[] = [];
    const memory = BatonMemoryService.of({
      search: () =>
        Effect.gen(function* () {
          readers.push(yield* MemoryViewer);
          return [];
        }),
    } as never);
    for (const scopes of [
      AuthStandardClientScopes,
      [...AuthStandardClientScopes, AuthBatonHandsHostScope],
    ]) {
      const response = yield* serve("/tessaya/desk/baton.memory.search", {
        session: {
          sessionId: "s" as never,
          subject: "x",
          method: "bearer-access-token",
          scopes,
        },
        runtime: Context.make(BatonMemoryService, memory) as never,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "deploy key" }),
        },
      });
      expect(response.status).toBe(200);
    }
    expect(readers).toEqual(["client", "desktop"]);
  }),
);

it.effect(
  "runs the shared tools as his desktop's Tessaya only for the desktop app's own session",
  () =>
    Effect.gen(function* () {
      const ran: Array<[string, unknown, string | undefined]> = [];
      const deskTools = {
        specs: [{ name: "settings_get", description: "Read a setting.", input_schema: {} }],
        run: (name: string, input: unknown, device?: string) =>
          Effect.sync(() => (ran.push([name, input, device]), { text: "on", isError: false })),
      };
      const call = (
        scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
        path: string,
        body: unknown,
      ) =>
        serve(`/tessaya/desk/${path}`, {
          session: { sessionId: "s" as never, subject: "x", method: "bearer-access-token", scopes },
          deskTools,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        } as never);
      const desktop = [...AuthStandardClientScopes, AuthBatonHandsHostScope];
      const ask = { name: "settings_get", args: { key: "chime" }, device: "replay-desktop" };
      expect((yield* call(AuthStandardClientScopes, "baton.tools.call", ask)).status).toBe(403);
      expect(ran).toEqual([]);
      const listed = yield* call(desktop, "baton.tools.list", {});
      expect(yield* Effect.promise(() => listed.json())).toEqual({
        value: { tools: deskTools.specs },
      });
      const called = yield* call(desktop, "baton.tools.call", ask);
      expect(yield* Effect.promise(() => called.json())).toEqual({
        value: { text: "on", isError: false },
      });
      expect(ran).toEqual([["settings_get", { key: "chime" }, "replay-desktop"]]);
      expect((yield* call(desktop, "baton.tools.call", { args: {} })).status).toBe(400);
      // The suite's pretend desktop: the R1's key, and always a rehearsal whatever device it names.
      const rehearse = (key: string) =>
        serve("/tessaya/rehearse/baton.tools.call", {
          deskTools: deskTools as RoomToolSet,
          runtime: Context.make(HomeAssistantService, {
            device: Effect.succeed({ deviceKey: "r1-key" }),
          } as never) as never,
          init: {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ ...ask, device: "r1-3d57b3" }),
          },
        });
      expect((yield* rehearse("wrong-key")).status).toBe(401);
      expect((yield* rehearse("r1-key")).status).toBe(200);
      expect(ran.at(-1)).toEqual(["settings_get", { key: "chime" }, "replay-desktop"]);
    }),
);

it.effect("serves private memory only to his own sessions, as that session, with no-store", () =>
  Effect.gen(function* () {
    const callers: unknown[] = [];
    const store = BatonPrivateMemoryService.of({
      people: Effect.gen(function* () {
        callers.push(yield* PrivateCaller);
        return [];
      }),
    } as never);
    const post = (session: EnvironmentAuth.AuthenticatedSession, body: unknown) =>
      serve("/tessaya/private", {
        session,
        runtime: Context.make(BatonPrivateMemoryService, store) as never,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      });
    const phone = {
      sessionId: "phone-1" as never,
      subject: "one-time-token",
      method: "browser-session-cookie",
      scopes: AuthStandardClientScopes,
    } as const;
    const ok = yield* post(phone, { op: "people" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(callers).toEqual([{ session: "phone-1", desktop: false, member: "owner" }]);
    expect(
      (yield* post({ ...phone, method: "bearer-access-token", subject: "x" }, { op: "people" }))
        .status,
    ).toBe(403);
    expect((yield* post(phone, { op: "recall", turn: {} })).status).toBe(400);
    expect((yield* post(phone, { op: "backup" })).status).toBe(403);
  }),
);
