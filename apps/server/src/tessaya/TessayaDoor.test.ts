import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { PeerLinkError } from "@t3tools/contracts";
import { PeerLinks, type ResolvedPeerLink } from "../peer/PeerLinks.ts";
import * as TessayaDoor from "./TessayaDoor.ts";
import { currentDoorHandler } from "./doorFront.ts";

const door = { own: "hive.home.example.com", domain: "home.example.com" };

describe("doorTarget", () => {
  const names = { nest: "env-nest" };
  it.each([
    ["hive.home.example.com", { _tag: "pass" }],
    ["home.example.com", { _tag: "pass" }],
    ["example.com", { _tag: "pass" }],
    ["192.168.1.10", { _tag: "pass" }],
    ["a.nest.home.example.com", { _tag: "pass" }],
    ["nest.home.example.com", { _tag: "machine", environmentId: "env-nest" }],
    ["wing.home.example.com", { _tag: "none" }],
  ])("%s", (host, expected) => {
    expect(TessayaDoor.doorTarget(host, door, names)).toEqual(expected);
  });

  it("passes everything when this brain is not a door", () => {
    expect(TessayaDoor.doorTarget("nest.home.example.com", null, names)).toEqual({ _tag: "pass" });
  });
});

describe("throughDoor", () => {
  it("never forwards to an address under the door's own domain, which would loop", () => {
    expect(TessayaDoor.throughDoor("https://nest.home.example.com/", "home.example.com")).toBe(
      true,
    );
    expect(TessayaDoor.throughDoor("https://home.example.com/", "home.example.com")).toBe(true);
    expect(TessayaDoor.throughDoor("http://10.9.0.5:3773/", "home.example.com")).toBe(false);
    expect(TessayaDoor.throughDoor("not a url", "home.example.com")).toBe(true);
  });
});

const NEST = EnvironmentId.make("env-nest");

const layerWith = (resolved: (id: string) => Effect.Effect<ResolvedPeerLink, PeerLinkError>) => {
  const stored = new Map<string, Uint8Array>();
  return TessayaDoor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSecretStore)({
          get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        }),
        Layer.mock(PeerLinks)({
          get: (id) => Effect.succeed(id === NEST ? Option.some({} as never) : Option.none()),
          resolve: (id) => resolved(id),
        }),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ TESSAYA_PUBLIC_HOST: "hive.home.example.com" }),
        ),
      ),
    ),
  );
};

const answered = (resolve: (id: string) => Effect.Effect<ResolvedPeerLink, PeerLinkError>) =>
  layerWith(resolve);
const at = (url: string) => (_id: string) =>
  Effect.succeed({ link: {} as never, url, token: "t", capabilities: {} as never });

const target = Effect.gen(function* () {
  const service = yield* TessayaDoor.TessayaDoor;
  expect(yield* service.setName(NEST, "nest")).toBeNull();
  const handler = currentDoorHandler();
  expect(handler?.target("nest.home.example.com")).toEqual({
    _tag: "machine",
    environmentId: NEST,
  });
  return yield* Effect.promise(() => handler!.resolve(NEST));
});

describe("TessayaDoor", () => {
  it.effect("names a linked machine and refuses bad, taken or unlinked names", () =>
    Effect.gen(function* () {
      const service = yield* TessayaDoor.TessayaDoor;
      expect(yield* service.setName(NEST, "Hive")).toBe("invalid-name");
      expect(yield* service.setName(NEST, "two.labels")).toBe("invalid-name");
      expect(yield* service.setName(EnvironmentId.make("env-stranger"), "wing")).toBe("not-linked");
      expect(yield* service.setName(NEST, "nest")).toBeNull();
      expect(yield* service.setName(EnvironmentId.make("env-stranger"), "nest")).toBe("taken");
      expect(yield* service.names).toEqual({
        domain: "home.example.com",
        names: { "env-nest": "nest" },
      });
      expect(yield* service.setName(NEST, null)).toBeNull();
      expect((yield* service.names).names).toEqual({});
    }).pipe(Effect.provide(answered(at("http://10.9.0.5:3773/")))),
  );

  it.effect("forwards to the address that answered as the machine", () =>
    Effect.map(target, (url) => expect(url).toBe("http://10.9.0.5:3773/")).pipe(
      Effect.provide(answered(at("http://10.9.0.5:3773/"))),
    ),
  );

  it.effect(
    "gives no address when no recorded address answers as that machine (wrong identity, asleep)",
    () =>
      Effect.map(target, (url) => expect(url).toBeNull()).pipe(
        Effect.provide(
          answered(() =>
            Effect.fail(
              new PeerLinkError({ reason: "unreachable", message: "did not answer as env-nest" }),
            ),
          ),
        ),
      ),
  );

  it.effect("never forwards to an address that goes back through a door", () =>
    Effect.map(target, (url) => expect(url).toBeNull()).pipe(
      Effect.provide(answered(at("https://nest.home.example.com/"))),
    ),
  );

  it.effect("takes the door down with its layer", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(answered(at("http://10.9.0.5:3773/"))));
      expect(currentDoorHandler()).toBeNull();
    }),
  );
});
