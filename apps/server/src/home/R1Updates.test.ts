// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import type { R1FirmwarePin } from "@t3tools/baton-shared/r1Firmware";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { makeHub, R1Hub } from "./R1Hub.ts";
import { R1Reach } from "./R1Reach.ts";
import { blankWatch, IDLE_MS, otaStep, R1Updates, ROLLBACK_AFTER_MS } from "./R1Updates.ts";
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

describe("when an R1 updates", () => {
  it("waits for idle, starts once, and goes back after 420 s only with an earlier image", () => {
    const idle = { ...blankWatch(), online: true, fw: "0.3.9", lastUse: 0 };
    expect(otaStep(idle, PIN, null, IDLE_MS - 1)).toBe("wait");
    expect(otaStep(idle, PIN, null, IDLE_MS)).toBe("start");
    expect(otaStep({ ...idle, enrolling: true }, PIN, null, IDLE_MS)).toBe("wait");
    expect(otaStep({ ...idle, bluetoothAudio: true }, PIN, null, IDLE_MS)).toBe("wait");
    expect(otaStep({ ...idle, fw: "0.4.0" }, PIN, null, IDLE_MS)).toBe("wait");
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
  });

  it.effect(
    "offers the checked image on a short-lived link with a spoken notice, then says it updated",
    () =>
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
        hub.attach(["freya/r1/+/cmd/ota/start", "freya/r1/+/voice/say"], (t, p) =>
          out.push([t.split("/").slice(3).join("/"), p.toString("utf8")]),
        );
        let downloads = 0;
        const layer = Layer.effect(
          R1Updates,
          R1UpdatesModule.make({
            pin: PIN,
            download: () => Effect.sync(() => (downloads++, V2)),
          }),
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
        yield* Effect.gen(function* () {
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
          expect(start).toMatchObject({ sha256: PIN.sha256, size: PIN.size, sig: "sig-of-0.4.0" });
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
        }).pipe(Effect.provide(layer), Effect.scoped);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
  );
});
