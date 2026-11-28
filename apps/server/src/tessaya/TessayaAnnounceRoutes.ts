/**
 * The Margin's door (tessaya_announce): `POST /api/tessaya/announce` with a `tessaya:announce` bearer, which reaches
 * nothing else. The body is an item due for the owner; TessayaMargin decides whether it is said now, and where, or
 * left as a card. The token is a session minted on this server (`t3 auth session issue --scope tessaya:announce`),
 * so revoking that session ends it.
 */
import { AuthTessayaAnnounceScope } from "@t3tools/contracts";
import { MARGIN_ANNOUNCE_KINDS, MARGIN_PRIORITIES } from "@t3tools/tessaya-shared/margin";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { TessayaMargin } from "./TessayaMargin.ts";
import { TessayaRuntime } from "./TessayaRpcHandlers.ts";

export const ANNOUNCE_PATH = "/api/tessaya/announce";
const MAX_BODY_BYTES = 8 * 1024;

export const AnnounceBody = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  due: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  priority: Schema.optionalKey(Schema.Literals(MARGIN_PRIORITIES)),
  kind: Schema.optionalKey(Schema.Literals(MARGIN_ANNOUNCE_KINDS)),
  private: Schema.optionalKey(Schema.Boolean),
  id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
const decodeBody = Schema.decodeUnknownOption(AnnounceBody);

const say = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

/** Only an announce token may push; any other session, even an admin's, is refused so the door stays single-purpose. */
export const announceAccess = (scopes: ReadonlySet<string> | null) =>
  scopes === null
    ? { status: 401, message: "Not signed in." }
    : scopes.has(AuthTessayaAnnounceScope)
      ? null
      : { status: 403, message: "This token is not an announce token." };

export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const context = yield* TessayaRuntime;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    if (context === null) return;
    const margin = Context.getOption(context, TessayaMargin);
    if (Option.isNone(margin)) return;
    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const scopes = yield* auth.authenticateHttpRequest(request).pipe(
        Effect.map((s) => new Set<string>(s.scopes)),
        Effect.orElseSucceed(() => null),
      );
      const denied = announceAccess(scopes);
      if (denied !== null) return say(denied.status, denied.message);
      const length = Number(request.headers["content-length"] ?? Number.NaN);
      if (!(length > 0 && length <= MAX_BODY_BYTES)) return say(413, "Too large or empty.");
      const body = decodeBody(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
      if (Option.isNone(body))
        return say(400, "Send {text, due?, priority?, kind?, private?, id?}.");
      const result = yield* margin.value.announce(body.value).pipe(Effect.provideContext(context));
      return HttpServerResponse.jsonUnsafe(result, {
        status: result.status === "refused" ? 422 : 200,
      });
    }).pipe(Effect.catchCause(() => Effect.succeed(say(500, "That did not work."))));
    yield* router.add("POST", ANNOUNCE_PATH, handle);
  }),
);
