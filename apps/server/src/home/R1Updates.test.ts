// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import type { R1FirmwarePin, R1KwsPin, R1ReleaseManifest } from "@t3tools/baton-shared/r1Firmware";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { makeHub, R1Hub } from "./R1Hub.ts";
import { R1Reach } from "./R1Reach.ts";
import {
  blankWatch,
  IDLE_MS,
  kwsStep,
  otaStep,
  R1Updates,
  ROLLBACK_AFTER_MS,
} from "./R1Updates.ts";
import * as R1UpdatesModule from "./R1Updates.ts";

const imageOf = (text: string) => new TextEncoder().encode(text);
const pinOf = (version: string, bytes: Uint8Array): R1FirmwarePin => ({
  version,
  url: `https://example.test/${version}.rbl`,
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  sig: `sig-of-${version}`,
});
const V2 = imageOf("firmware 0.4.0");
const PIN = pinOf("0.4.0", V2);
/** A fake wake model pack, signed the way the release pipeline signs: ECDSA P-256 over its sha256. */
const KEYS = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const PACK = imageOf("kws pack 1");
const KWS: R1KwsPin = {
  version: 1,
  size: PACK.length,
  sha256: NodeCrypto.createHash("sha256").update(PACK).digest("hex"),
  url: "https://example.test/kws-1.bin",
  // ECDSA with SHA-256 over the pack: the signed digest is the pack's sha256.
  sig: NodeCrypto.sign("sha256", PACK, {
    key: KEYS.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("hex"),
  threshold: 0.9,
};

/** R1Updates over a real hub with one R1 on it; `out` collects what the server sends the R1 (topic tail, payload). */
const withUpdates = <A, E>(
  pin: R1ReleaseManifest | R1FirmwarePin,
  download: (url: string) => Uint8Array,
  topics: ReadonlyArray<string>,
  body: (
    hub: ReturnType<typeof makeHub>,
    out: Array<[string, string]>,
  ) => Effect.Effect<A, E, R1Updates>,
) =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "r1-updates-"));
    const hub = makeHub(() => Effect.succeed(null));
    const record: R1Device = {
      deviceKey: "k".repeat(32),
      deviceId: "r1-a",
      mqttUrl: null,
      mqttUser: null,
      mqttPass: null,
    };
    const out: Array<[string, string]> = [];
    hub.attach(topics, (t, p) => out.push([t.split("/").slice(3).join("/"), p.toString("utf8")]));
    const layer = Layer.effect(
      R1Updates,
      R1UpdatesModule.make({ pin, download: (url) => Effect.sync(() => download(url)) }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(R1Hub, {
            ...hub,
            busLogin: Effect.succeed({ user: "", key: "" }),
            noteKeyUse: () => Effect.void,
            keyUsedOutside: () => null,
          }),
          Layer.mock(HomeAssistantService)({ devices: Effect.succeed([record]) }),
          Layer.mock(R1Reach)({
            status: Effect.succeed({
              away: false,
              offered: true,
              tunnel: false,
              endpoints: { broker: [], proxy: "http://192.168.1.20:3773" },
              line: "",
            }),
          }),
          // Unused: the test hands in its own download.
          FetchHttpClient.layer,
          Layer.succeed(ServerConfig.ServerConfig, {
            dbPath: NodePath.join(dir, "state.sqlite"),
          } as never),
        ),
      ),
    );
    yield* body(hub, out).pipe(Effect.provide(layer), Effect.scoped);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

describe("when an R1 updates", () => {
  it("waits for idle, starts once, and goes back after 420 s only with an earlier image", () => {
    const idle = { ...blankWatch(), online: true, fw: "0.3.9", lastUse: 0 };
    expect(otaStep(idle, PIN, null, IDLE_MS - 1)).toBe("wait");
    expect(otaStep(idle, PIN, null, IDLE_MS)).toBe("start");
    expect(otaStep({ ...idle, enrolling: true }, PIN, null, IDLE_MS)).toBe("wait");
    expect(otaStep({ ...idle, bluetoothAudio: true }, PIN, null, IDLE_MS)).toBe("wait");
    // Only ever forward: equal is up to date, a newer R1 is never taken back to an older pin.
    expect(otaStep({ ...idle, fw: "0.4.0" }, PIN, null, IDLE_MS)).toBe("wait");
    expect(otaStep({ ...idle, fw: "smp-0.4.0" }, PIN, null, IDLE_MS)).toBe("wait");
    expect(otaStep({ ...idle, fw: "0.4.1" }, PIN, null, IDLE_MS)).toBe("wait");
    expect(otaStep({ ...idle, fw: "0.10.0" }, PIN, null, IDLE_MS)).toBe("wait");
    expect(otaStep({ ...idle, fw: "smp-0.3.93" }, pinOf("smp-0.3.76", V2), null, IDLE_MS)).toBe(
      "wait",
    );
    expect(otaStep({ ...idle, fw: "smp-0.3.76" }, pinOf("smp-0.3.93", V2), null, IDLE_MS)).toBe(
      "start",
    );
    expect(otaStep({ ...idle, fw: "custom" }, PIN, null, IDLE_MS)).toBe("wait");
    // An image larger than the R1's OTA package cap is never offered.
    expect(otaStep(idle, { ...PIN, size: 2748 * 1024 }, null, IDLE_MS)).toBe("start");
    expect(otaStep(idle, { ...PIN, size: 2748 * 1024 + 1 }, null, IDLE_MS)).toBe("wait");
    expect(otaStep(idle, null, null, IDLE_MS)).toBe("wait");
    // A version that failed here is not tried again by itself.
    expect(otaStep({ ...idle, stopped: { version: "0.4.0", why: "" } }, PIN, null, IDLE_MS)).toBe(
      "wait",
    );
    const going = { ...idle, update: { version: "0.4.0", startedAt: 0, rollback: false } };
    expect(otaStep(going, PIN, null, ROLLBACK_AFTER_MS - 1)).toBe("wait");
    expect(otaStep({ ...going, fw: "0.4.0" }, PIN, null, 1)).toBe("done");
    expect(otaStep(going, PIN, pinOf("0.3.9", imageOf("old")), ROLLBACK_AFTER_MS)).toBe("rollback");
    expect(otaStep(going, PIN, null, ROLLBACK_AFTER_MS)).toBe("give-up");
    // The way back never goes below what the R1 last reported running.
    expect(otaStep(going, PIN, pinOf("0.3.8", imageOf("old")), ROLLBACK_AFTER_MS)).toBe("give-up");
  });

  it.effect(
    "offers the checked image on a short-lived link with a spoken notice, then says it updated",
    () => {
      let downloads = 0;
      return withUpdates(
        PIN,
        () => (downloads++, V2),
        ["freya/r1/+/cmd/ota/start", "freya/r1/+/voice/say"],
        (hub, out) =>
          Effect.gen(function* () {
            const updates = yield* R1Updates;
            hub.publish("freya/r1/r1-a/state/online", "1", true);
            hub.publish("freya/r1/r1-a/state/caps", '{"fw":"0.3.9"}', true);
            hub.publish("freya/r1/r1-a/voice/up", "frame");
            yield* updates.tick;
            // In use just now: nothing yet.
            expect(out).toEqual([]);
            yield* TestClock.adjust(IDLE_MS + 1);
            yield* updates.tick;
            expect(out.map(([t]) => t)).toEqual(["voice/say", "cmd/ota/start"]);
            expect(JSON.parse(out[0]![1]).text).toBe("I'm updating; back in a minute.");
            const start = JSON.parse(out[1]![1]) as {
              url: string;
              sha256: string;
              size: number;
              sig: string;
            };
            expect(start).toMatchObject({
              version: "0.4.0",
              sha256: PIN.sha256,
              size: PIN.size,
              sig: "sig-of-0.4.0",
            });
            expect(start).not.toHaveProperty("allow_downgrade");
            expect(
              start.url.startsWith(`http://192.168.1.20:3773/api/r1/firmware/${PIN.sha256}.rbl?t=`),
            ).toBe(true);
            const ticket = new URL(start.url).searchParams.get("t")!;
            expect(yield* updates.image(`${PIN.sha256}.rbl`, ticket)).toEqual(V2);
            expect(yield* updates.image(`${PIN.sha256}.rbl`, "wrong")).toBeNull();
            expect(downloads).toBe(1);
            // It comes back on the new version.
            hub.publish("freya/r1/r1-a/state/caps", '{"fw":"0.4.0"}', true);
            yield* updates.tick;
            expect(out.at(-1)).toEqual(["voice/say", '{"text":"I\'ve updated."}']);
            expect((yield* updates.view).devices[0]!.line).toBe("Up to date.");
            // The link stops working after 10 minutes.
            yield* TestClock.adjust("11 minutes");
            yield* updates.tick;
            expect(yield* updates.image(`${PIN.sha256}.rbl`, ticket)).toBeNull();
          }),
      );
    },
  );

  it("loads the wake model only on the pinned firmware, idle, and between updates", () => {
    const idle = { ...blankWatch(), online: true, fw: "0.4.0", lastUse: 0 };
    expect(kwsStep(idle, KWS, PIN, IDLE_MS)).toBe("start");
    expect(kwsStep(idle, KWS, PIN, IDLE_MS - 1)).toBe("wait");
    expect(kwsStep(idle, null, PIN, IDLE_MS)).toBe("wait");
    expect(kwsStep({ ...idle, fw: "0.3.9" }, KWS, PIN, IDLE_MS)).toBe("wait");
    expect(kwsStep({ ...idle, fw: "0.4.1" }, KWS, PIN, IDLE_MS)).toBe("start");
    // Its retained state/model already names this pack: nothing to send.
    const running = { version: 1, sha256: KWS.sha256, ok: true, why: null };
    expect(kwsStep({ ...idle, model: running }, KWS, PIN, IDLE_MS)).toBe("wait");
    expect(kwsStep({ ...idle, model: { ...running, ok: false } }, KWS, PIN, IDLE_MS)).toBe("start");
    expect(kwsStep(idle, { ...KWS, size: 476 * 1024 + 1 }, PIN, IDLE_MS)).toBe("wait");
    const failed = { version: KWS.version, why: "" };
    expect(kwsStep({ ...idle, modelStopped: failed }, KWS, PIN, IDLE_MS)).toBe("wait");
    const going = { ...idle, modelLoad: { version: KWS.version, startedAt: 0 } };
    expect(kwsStep(going, KWS, PIN, ROLLBACK_AFTER_MS - 1)).toBe("wait");
    expect(kwsStep(going, KWS, PIN, ROLLBACK_AFTER_MS)).toBe("give-up");
    // A firmware update waits for a load in flight: the R1 takes one transfer at a time.
    expect(otaStep({ ...going, fw: "0.3.9" }, PIN, null, IDLE_MS)).toBe("wait");
  });

  it.effect("passes a signed wake model pack on as it came, and hears whether it loaded", () =>
    withUpdates(
      { artifacts: { firmware: PIN, kws: KWS } },
      (url) => (url === KWS.url ? PACK : V2),
      ["freya/r1/+/cmd/#"],
      (hub, out) =>
        Effect.gen(function* () {
          const updates = yield* R1Updates;
          hub.publish("freya/r1/r1-a/state/online", "1", true);
          hub.publish("freya/r1/r1-a/state/caps", '{"fw":"0.4.0"}', true);
          yield* TestClock.adjust(IDLE_MS + 1);
          yield* updates.tick;
          expect(out.map(([t]) => t)).toEqual(["cmd/model/load"]);
          const load = JSON.parse(out[0]![1]) as {
            url: string;
            size: number;
            sha256: string;
            sig: string;
          };
          expect(load).toMatchObject({
            version: KWS.version,
            size: KWS.size,
            sha256: KWS.sha256,
            sig: KWS.sig,
          });
          const ticket = new URL(load.url).searchParams.get("t")!;
          const served = yield* updates.image(`${KWS.sha256}.kws`, ticket);
          expect(served).toEqual(PACK);
          // What the R1 fetches and the signature it was handed check out, as the R1 checks them.
          expect(
            NodeCrypto.verify(
              "sha256",
              served!,
              { key: KEYS.publicKey, dsaEncoding: "ieee-p1363" },
              Buffer.from(load.sig, "hex"),
            ),
          ).toBe(true);
          // A ticket for the pack does not fetch the firmware.
          expect(yield* updates.image(`${PIN.sha256}.rbl`, ticket)).toBeNull();
          expect((yield* updates.view).devices[0]!.kws).toContain("loading pack 1");
          hub.publish("freya/r1/r1-a/state/net/ack", '{"op":"model","ok":true}');
          hub.publish(
            "freya/r1/r1-a/state/model",
            `{"version":1,"threshold":0.9,"ok":true,"why":"","sha256":"${KWS.sha256}"}`,
            true,
          );
          hub.publish("freya/r1/r1-a/state/voice/kws", '{"mode":"shadow"}', true);
          yield* TestClock.adjust(IDLE_MS + 1);
          yield* updates.tick;
          expect((yield* updates.view).devices[0]).toMatchObject({
            line: "Up to date.",
            kws: "Own wake model: shadow; pack 1.",
          });
          expect(out).toHaveLength(1);
          // Unloaded from Settings: it stays so, until he turns the wake model on again.
          hub.publish("freya/r1/r1-a/state/net/ack", '{"op":"model.clear","ok":true}');
          hub.publish(
            "freya/r1/r1-a/state/model",
            '{"version":null,"ok":false,"why":"cleared"}',
            true,
          );
          yield* updates.tick;
          expect(out).toHaveLength(1);
          expect((yield* updates.view).devices[0]!.kws).toContain("Unloaded");
          hub.publish("freya/r1/r1-a/state/voice/kws", '{"mode":"shadow"}', true);
          yield* updates.tick;
          expect(out.map(([t]) => t)).toEqual(["cmd/model/load", "cmd/model/load"]);
        }),
    ),
  );

  it.effect("stops offering a wake model pack the R1 could not load", () =>
    withUpdates(
      { artifacts: { firmware: PIN, kws: KWS } },
      () => PACK,
      ["freya/r1/+/cmd/#"],
      (hub, out) =>
        Effect.gen(function* () {
          const updates = yield* R1Updates;
          hub.publish("freya/r1/r1-a/state/online", "1", true);
          hub.publish("freya/r1/r1-a/state/caps", '{"fw":"0.4.0"}', true);
          yield* TestClock.adjust(IDLE_MS + 1);
          yield* updates.tick;
          // Busy (an OTA or another load on the R1): tried again on a later idle pass.
          hub.publish("freya/r1/r1-a/state/net/ack", '{"op":"model","ok":false,"error":"busy"}');
          yield* TestClock.adjust(IDLE_MS + 1);
          yield* updates.tick;
          expect(out).toHaveLength(2);
          hub.publish(
            "freya/r1/r1-a/state/net/ack",
            '{"op":"model","ok":false,"error":"not signed by the release key"}',
          );
          yield* TestClock.adjust(IDLE_MS + 1);
          yield* updates.tick;
          expect(out).toHaveLength(2);
          expect((yield* updates.view).devices[0]!.kws).toContain("not signed by the release key");
        }),
    ),
  );
});
