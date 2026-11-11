/**
 * Where the R1 posts a camera picture (`POST /camera/upload?device=<id>`, the firmware's fixed path, no auth of its
 * own). The service keeps it only when he opened a window for that device moments ago, and only in memory.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { BatonRuntime } from "../baton/BatonRpcHandlers.ts";
import { requestUrl } from "../requestUrl.ts";
import { HomeDevices, MAX_SHOT_BYTES } from "./HomeDevices.ts";

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
  }),
);
