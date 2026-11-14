// @effect-diagnostics nodeBuiltinImport:off
/**
 * The pack's door on the home server (SPINE-UNIFY §10, P4): another of his servers reads the pack with any paired
 * session and writes a file with one that may change settings. The same layer runs this server's sync with its
 * home, once a minute, when it has one.
 */
import * as NodePath from "node:path";

import { AuthSettingsWriteScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { TessayaRuntime } from "./TessayaRpcHandlers.ts";
import { PACK_DIR_NAME } from "./OperatingSystemPack.ts";
import * as ServerConfig from "../config.ts";
import { acceptPackPush, readPackFiles, syncPackWithHome } from "./TessayaPack.ts";

const decodePush = Schema.decodeUnknownOption(
  Schema.Struct({
    path: Schema.String.check(Schema.isMaxLength(200)),
    text: Schema.NullOr(Schema.String),
    base: Schema.NullOr(Schema.String),
  }),
);

export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const context = yield* TessayaRuntime;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const config = yield* ServerConfig.ServerConfig;
    if (context === null) return;
    const dir = NodePath.join(NodePath.dirname(config.dbPath), PACK_DIR_NAME);
    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      if (Option.isNone(session))
        return HttpServerResponse.jsonUnsafe({ message: "Not paired." }, { status: 401 });
      if (request.method === "GET")
        return HttpServerResponse.jsonUnsafe({
          files: yield* Effect.sync(() => readPackFiles(dir)),
        });
      if (!session.value.scopes.includes(AuthSettingsWriteScope))
        return HttpServerResponse.jsonUnsafe(
          { message: "Only a session that may change settings can change the pack." },
          { status: 403 },
        );
      const body = decodePush(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
      if (Option.isNone(body))
        return HttpServerResponse.jsonUnsafe(
          { message: "That request is not valid." },
          { status: 400 },
        );
      const done = yield* Effect.sync(() =>
        acceptPackPush(dir, body.value.path, body.value.text, body.value.base),
      );
      return "refused" in done
        ? HttpServerResponse.jsonUnsafe({ message: done.refused }, { status: 409 })
        : HttpServerResponse.jsonUnsafe(done);
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ message: "That did not work." }, { status: 500 }),
        ),
      ),
    );
    yield* router.add("GET", "/api/tessaya/pack", handle);
    yield* router.add("PUT", "/api/tessaya/pack", handle);
    // This server's copy kept in step with its home's; a round that fails waits for the next minute.
    yield* syncPackWithHome(dir).pipe(
      Effect.provideContext(context),
      Effect.catchCause((cause) => Effect.logWarning("pack sync failed", cause)),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  }),
);
