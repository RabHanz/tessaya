import { it } from "@effect/vitest";
import { connectPacket } from "@t3tools/baton-shared/mqtt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { HomeAssistantService, r1ById, type R1Device } from "./HomeAssistantService.ts";
import { deviceGrant, makeHub, R1Hub } from "./R1Hub.ts";
import { claimKey, claimPlaintext, openClaim, R1Pairing, sealClaim } from "./R1Pairing.ts";
import * as R1PairingModule from "./R1Pairing.ts";
import { R1Reach } from "./R1Reach.ts";

const OTK = "000102030405060708090A0B0C0D0E0F";

it("seals the claim so only the R1 with the code on its eye opens it", () => {
  const blob = sealClaim(OTK, "r1-a", '{"key":"k"}');
  expect(openClaim(OTK, "r1-a", blob)).toBe('{"key":"k"}');
  expect(openClaim(OTK.replace("0F", "0E"), "r1-a", blob)).toBeNull();
  expect(openClaim(OTK, "r1-b", blob)).toBeNull();
});

// The firmware lane tests its opener against this vector (checked with Python's hmac and cryptography as well).
it("matches the firmware's known-answer vector", () => {
  const id = "R1-A1B2C3";
  expect(claimKey(OTK, id).toString("hex")).toBe(
    "ecb26ced8f6dbc055fb49419e21a484bda66800182fdd947e93a1cf64928a7c2",
  );
  const plain = JSON.stringify(
    claimPlaintext({
      deviceId: id,
      key: "11".repeat(32),
      endpoints: {
        broker: ["ws://192.168.1.20:3773/api/r1/mqtt", "wss://t-1.example.net/api/r1/mqtt"],
        proxy: "http://192.168.1.20:3773",
      },
    }),
  );
  expect(plain).toBe(
    '{"v":1,"device":"r1-a1b2c3","key":"1111111111111111111111111111111111111111111111111111111111111111","broker":["ws://192.168.1.20:3773/api/r1/mqtt","wss://t-1.example.net/api/r1/mqtt"],"proxy":"http://192.168.1.20:3773"}',
  );
  expect(sealClaim(OTK, id, plain, Buffer.from("000102030405060708090a0b", "hex"))).toBe(
    "AAECAwQFBgcICQoLbbFNePy/XPPgEvl7My+qzDBUOBpg8lTJ89EoN7EZbJJI4uM5CVSQFdh1foxyGKCgIAQUhztZmybA2YiSZobo9gcBRnSVQMltww6mWmMX9d8AU0TBqI9KuEsIvp56U5IPlYJRWjPHBp3Y2bgR0u8snIUuB5BJ+8V9EVVpUCgULYxj7gf/XSZFFvwY66OQcjtYHatNVuqs5ewHN+UIeUAT2RwQ7pEF12fyGN+ZWZ9syKfnWaNbiou1iJGRv1agpKp0k1W6Pl2T+aytzMB7fX3HR/s40MTAw/NiJcEQ2VUiyERQp4XjyXvyOfDzCy0=",
  );
  // No proxy, no field.
  expect(
    claimPlaintext({ deviceId: id, key: "k", endpoints: { broker: [], proxy: "" } }),
  ).not.toHaveProperty("proxy");
});

const setup = () => {
  let records: ReadonlyArray<R1Device> = [];
  let outside: number | null = null;
  const hub = makeHub((user, pass) =>
    Effect.sync(() => deviceGrant(r1ById(records, user), user, pass)),
  );
  const sent: Array<string> = [];
  hub.attach(["freya/r1/+/cmd/net/key"], (_t, p) => sent.push(p.toString("utf8")));
  const layer = R1PairingModule.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(R1Hub, {
          ...hub,
          busLogin: Effect.succeed({ user: "", key: "" }),
          noteKeyUse: () => Effect.void,
          keyUsedOutside: () => outside,
        }),
        Layer.mock(HomeAssistantService)({
          devices: Effect.sync(() => records),
          putDevice: (d) =>
            Effect.sync(() => {
              records = [...records.filter((r) => r.deviceId !== d.deviceId), d];
              return { configured: true };
            }),
        }),
        Layer.mock(R1Reach)({
          status: Effect.succeed({
            away: false,
            tunnel: false,
            endpoints: { broker: ["ws://192.168.1.20:3773/api/r1/mqtt"], proxy: "" },
            line: "",
          }),
        }),
      ),
    ),
  );
  const login = (pass: string) =>
    Effect.gen(function* () {
      let closed = false;
      const session = hub.open({ send: () => {}, close: () => void (closed = true) });
      yield* session.receive(
        connectPacket({ clientId: "r1-a", user: "r1-a", pass, keepAliveS: 60 }),
      );
      return { closed: () => closed };
    });
  return {
    layer,
    hub,
    sent,
    login,
    record: (id = "r1-a") => r1ById(records, id),
    setOutside: (at: number) => void (outside = at),
  };
};

it.effect("claims each R1 with a fresh key of its own in a sealed blob", () => {
  const t = setup();
  return Effect.gen(function* () {
    const pairing = yield* R1Pairing;
    const claimed = yield* pairing.claim({ deviceId: "r1-a", oneTimeKey: OTK });
    const opened = JSON.parse(openClaim(OTK, "r1-a", claimed.blob)!);
    expect(opened.key).toBe(t.record()!.deviceKey);
    expect(opened.key).toHaveLength(64);
    expect(opened).toMatchObject({
      v: 1,
      device: "r1-a",
      broker: ["ws://192.168.1.20:3773/api/r1/mqtt"],
    });
    expect(opened).not.toHaveProperty("proxy");
    const short = yield* pairing
      .claim({ deviceId: "r1-a", oneTimeKey: "482913" })
      .pipe(Effect.flip);
    expect(short.why).toContain("pairing picture");
    expect(JSON.stringify(claimed)).not.toContain(opened.key);
    // A second R1 in the same home: its own record and key, the first one untouched.
    yield* pairing.claim({ deviceId: "R1-B", oneTimeKey: OTK });
    expect(t.record("r1-b")!.deviceKey).not.toBe(t.record("r1-a")!.deviceKey);
    expect(t.record("r1-a")!.deviceKey).toBe(opened.key);
  }).pipe(Effect.provide(t.layer));
});

it.effect(
  "rotates over the live link, keeps the old key until then, and asks first when the key is used elsewhere",
  () => {
    const t = setup();
    return Effect.gen(function* () {
      const pairing = yield* R1Pairing;
      yield* pairing.claim({ deviceId: "r1-a", oneTimeKey: OTK });
      const first = t.record()!.deviceKey;
      // Offline: nothing to send it over.
      expect((yield* pairing.rotate("r1-a", false).pipe(Effect.flip)).why).toContain("online");
      const link = yield* t.login(first);
      expect(link.closed()).toBe(false);
      t.setOutside(0);
      expect((yield* pairing.rotate("r1-a", false)).status).toBe("confirm");
      expect((yield* pairing.rotate("r1-a", true)).status).toBe("done");
      const next = t.record()!.deviceKey;
      expect(JSON.parse(t.sent.at(-1)!)).toEqual({ key: next });
      expect(t.record()!.previousKey).toBe(first);
      // Both keys work until the R1 uses the new one (the hub's layer then drops the old).
      expect(deviceGrant(t.record(), "r1-a", first)).not.toBeNull();
      expect(deviceGrant(t.record(), "r1-a", next)).not.toBeNull();
      // A second rotation before the first arrived would lock the R1 out.
      expect((yield* pairing.rotate("r1-a", true).pipe(Effect.flip)).why).toContain("not reached");
      // Forget closes its live link.
      t.hub.dropDevice("r1-a");
      expect(link.closed()).toBe(true);
    }).pipe(Effect.provide(t.layer));
  },
);
