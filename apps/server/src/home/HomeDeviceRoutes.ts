// @effect-diagnostics nodeBuiltinImport:off
/**
 * Where the R1 posts a camera picture (`POST /camera/upload?device=<id>`, the firmware's fixed path, no auth of its
 * own). The service keeps it only when he opened a window for that device moments ago, and only in memory. And where
 * the room loop claims a wake for an R1 (`POST /api/devices/r1/v1/voice/arbiter`, the R1's device key), so one
 * device answers him.
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { BatonRuntime } from "../baton/BatonRpcHandlers.ts";
import { requestUrl } from "../requestUrl.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import { HomeDevices, MAX_SHOT_BYTES } from "./HomeDevices.ts";
import { serveArbiter } from "./VoiceArbiter.ts";

const digest = (s: string) => NodeCrypto.createHash("sha256").update(s).digest();
const sameKey = (given: string, expected: string) =>
  given !== "" && NodeCrypto.timingSafeEqual(digest(given), digest(expected));
const LOOP_OPS: ReadonlySet<string> = new Set(["claim", "speaking", "ended", "arbiter"]);

export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const context = yield* BatonRuntime;
    if (context === null) return;
    const upload = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const id = Option.flatMap(requestUrl(request), (url) =>
        Option.fromNullishOr(url.searchParams.get("device")),
      );
      const length = Number(request.headers["content-length"] ?? Number.NaN);
      // Checked before the body is read: anyone can reach this path.
      if (
        Option.isNone(id) ||
        !String(request.headers["content-type"]).startsWith("image/jpeg") ||
        !(length > 0 && length <= MAX_SHOT_BYTES)
      )
        return HttpServerResponse.text("No.", { status: 400 });
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      const kept = yield* Effect.flatMap(HomeDevices, (d) => d.acceptShot(id.value, bytes)).pipe(
        Effect.provideContext(context),
      );
      return HttpServerResponse.text(kept ? "ok" : "Not expected.", { status: kept ? 200 : 403 });
    }).pipe(
      Effect.catchCause(() => Effect.succeed(HttpServerResponse.text("No.", { status: 400 }))),
    );
    yield* router.add("POST", "/camera/upload", upload);
    const arbiter = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const device = yield* Effect.flatMap(HomeAssistantService, (h) => h.device).pipe(
        Effect.provideContext(context),
      );
      const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      if (device === null || !sameKey(bearer, device.deviceKey))
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "Wrong device key." },
          { status: 401 },
        );
      const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
        readonly op?: unknown;
      };
      const op = typeof body.op === "string" && LOOP_OPS.has(body.op) ? body.op : "";
      const answer = yield* serveArbiter(op, body).pipe(Effect.provideContext(context));
      return HttpServerResponse.jsonUnsafe(answer ?? { ok: false, error: "Not an arbiter op." }, {
        status: answer === null ? 400 : 200,
      });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false }, { status: 500 })),
      ),
    );
    yield* router.add("POST", "/api/devices/r1/v1/voice/arbiter", arbiter);
  }),
);
