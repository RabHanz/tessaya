import { it } from "@effect/vitest";
import { connectPacket } from "@t3tools/baton-shared/mqtt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { deviceGrant, makeHub, R1Hub } from "./R1Hub.ts";
import { openClaim, R1Pairing, sealClaim } from "./R1Pairing.ts";
import * as R1PairingModule from "./R1Pairing.ts";
import { R1Reach } from "./R1Reach.ts";

it("seals the claim so only the R1 with the code on its eye opens it", () => {
  const blob = sealClaim("482913", "r1-a", '{"key":"k"}');
  expect(openClaim("482913", "r1-a", blob)).toBe('{"key":"k"}');
  expect(openClaim("482914", "r1-a", blob)).toBeNull();
  expect(openClaim("482913", "r1-b", blob)).toBeNull();
});

const setup = () => {
  let record: R1Device | null = null;
  let outside: number | null = null;
  const hub = makeHub((user, pass) => Effect.sync(() => deviceGrant(record, user, pass)));
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
          device: Effect.sync(() => record),
          setDevice: (d) =>
            Effect.sync(() => {
              record = d;
              return { configured: d !== null };
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
    record: () => record,
    setOutside: (at: number) => void (outside = at),
  };
};

it.effect("claims a new R1 with a fresh key in a sealed blob, and keeps to one R1 for now", () => {
  const t = setup();
  return Effect.gen(function* () {
    const pairing = yield* R1Pairing;
    const claimed = yield* pairing.claim({ deviceId: "r1-a", oneTimeKey: "482913" });
    const opened = JSON.parse(openClaim("482913", "r1-a", claimed.blob)!);
    expect(opened.key).toBe(t.record()!.deviceKey);
    expect(opened.key).toHaveLength(64);
    expect(opened.broker).toEqual(["ws://192.168.1.20:3773/api/r1/mqtt"]);
    expect(JSON.stringify(claimed)).not.toContain(opened.key);
    const other = yield* pairing
      .claim({ deviceId: "r1-b", oneTimeKey: "111111" })
      .pipe(Effect.flip);
    expect(other.why).toContain("already has r1-a");
  }).pipe(Effect.provide(t.layer));
});

it.effect(
  "rotates over the live link, keeps the old key until then, and asks first when the key is used elsewhere",
  () => {
    const t = setup();
    return Effect.gen(function* () {
      const pairing = yield* R1Pairing;
      yield* pairing.claim({ deviceId: "r1-a", oneTimeKey: "482913" });
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
