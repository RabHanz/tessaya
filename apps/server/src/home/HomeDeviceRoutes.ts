// @effect-diagnostics nodeBuiltinImport:off
/**
 * The R1's own routes: its camera upload (`POST /camera/upload?device=<id>`, kept only inside a window he opened), the
 * room loop's wake claims, step-ups and enrolments (the device key), and its MQTT hub (`/api/r1/mqtt`, R1Hub.ts).
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { BatonRuntime } from "../baton/BatonRpcHandlers.ts";
import { requestUrl } from "../requestUrl.ts";
import { StepUps } from "./StepUps.ts";
import { HomeAssistantService, r1ById, r1ByKey } from "./HomeAssistantService.ts";
import { HomeDevices, MAX_SHOT_BYTES } from "./HomeDevices.ts";
import { serveArbiter } from "./VoiceArbiter.ts";
import { noteDeviceKeyUse, R1_HUB_PATH, R1Hub, runHubSocket } from "./R1Hub.ts";
import { R1_FIRMWARE_PATH, R1Updates } from "./R1Updates.ts";
import { OWNER_MEMBER_ID } from "@t3tools/baton-shared/household";
import * as Schema from "effect/Schema";
import { HouseholdCaller, TessayaHousehold } from "../baton/TessayaHousehold.ts";

/**
 * What the room loop sends after enrolling: the profile less what the server decides (the member, the version). A post
 * with no `fresh` is a new enrolment; the loop's copy from before sharing is sent with `fresh: false`.
 */
export const VoiceUpload = Schema.Struct({
  profile: Schema.Struct({
    name: Schema.String.check(Schema.isMaxLength(60)),
    kind: Schema.Literals(["owner", "saved"]),
    model: Schema.String.check(Schema.isMaxLength(120)),
    centroid: Schema.String.check(Schema.isMaxLength(16_384)),
    samples: Schema.Int,
    sources: Schema.optionalKey(Schema.Array(Schema.Literals(["wispr", "spoken", "adapted"]))),
    enrolledAt: Schema.String.check(Schema.isMaxLength(40)),
    consentNote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
  }),
  fresh: Schema.optionalKey(Schema.Boolean),
});

const digest = (s: string) => NodeCrypto.createHash("sha256").update(s).digest();
const sameKey = (given: string, expected: string) =>
  given !== "" && NodeCrypto.timingSafeEqual(digest(given), digest(expected));

/**
 * Whether a camera upload may be taken. Over the T3 Connect tunnel (Cloudflare adds `cf-connecting-ip`) anyone on the
 * internet can reach the path, so it needs the device key as a bearer; on the LAN it stays open, as older firmware
 * sends no key.
 */
export const uploadAuthorized = (
  headers: Readonly<Record<string, string | undefined>>,
  deviceKey: string | null,
): boolean =>
  headers["cf-connecting-ip"] === undefined ||
  (deviceKey !== null &&
    sameKey((headers["authorization"] ?? "").replace(/^Bearer\s+/i, ""), deviceKey));

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
      const device = r1ById(
        yield* Effect.flatMap(HomeAssistantService, (h) => h.devices).pipe(
          Effect.provideContext(context),
        ),
        id.value,
      );
      if (!uploadAuthorized(request.headers, device?.deviceKey ?? null))
        return HttpServerResponse.text("Wrong device key.", { status: 401 });
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      const kept = yield* Effect.flatMap(HomeDevices, (d) => d.acceptShot(id.value, bytes)).pipe(
        Effect.provideContext(context),
      );
      return HttpServerResponse.text(kept ? "ok" : "Not expected.", { status: kept ? 200 : 403 });
    }).pipe(
      Effect.catchCause(() => Effect.succeed(HttpServerResponse.text("No.", { status: 400 }))),
    );
    yield* router.add("POST", "/camera/upload", upload);
    // The R1's firmware image, on the short-lived link this server gave it (R1Updates).
    const updates = Context.getOption(context, R1Updates);
    yield* router.add(
      "GET",
      `${R1_FIRMWARE_PATH}*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = Option.getOrNull(requestUrl(request));
        const file = url?.pathname.slice(R1_FIRMWARE_PATH.length) ?? "";
        const bytes = Option.isNone(updates)
          ? null
          : yield* updates.value.image(file, url?.searchParams.get("t") ?? "");
        return bytes === null
          ? HttpServerResponse.text("No.", { status: 404 })
          : HttpServerResponse.uint8Array(bytes, { contentType: "application/octet-stream" });
      }),
    );
    // The R1's own MQTT hub. No auth here: the firmware cannot add headers, so the CONNECT's login is the auth.
    const hub = Context.get(context, R1Hub);
    yield* router.add(
      "GET",
      R1_HUB_PATH,
      Effect.gen(function* () {
        const socket = yield* Effect.flatMap(HttpServerRequest.HttpServerRequest, (r) => r.upgrade);
        yield* runHubSocket(socket, hub).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
    );
    const arbiter = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      // Any R1's key: each R1's room loop calls with its own.
      const device = r1ByKey(
        yield* Effect.flatMap(HomeAssistantService, (h) => h.devices).pipe(
          Effect.provideContext(context),
        ),
        bearer,
      );
      if (device === null)
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "Wrong device key." },
          { status: 401 },
        );
      yield* noteDeviceKeyUse(request).pipe(Effect.provideContext(context));
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
    // The loop's answer to a step-up over HTTP, as on `voice/stepup/done` (the live suite's way in, too): whether it ran.
    const stepUp = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      // Any R1's key: each R1's room loop calls with its own.
      const device = r1ByKey(
        yield* Effect.flatMap(HomeAssistantService, (h) => h.devices).pipe(
          Effect.provideContext(context),
        ),
        bearer,
      );
      if (device === null)
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "Wrong device key." },
          { status: 401 },
        );
      yield* noteDeviceKeyUse(request).pipe(Effect.provideContext(context));
      const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as Record<
        string,
        unknown
      >;
      if (typeof body["device"] !== "string" || typeof body["act"] !== "string")
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "Name the device and the act." },
          {
            status: 400,
          },
        );
      const from = body["device"];
      const done = {
        act: body["act"],
        ok: body["ok"] === true,
        how: typeof body["how"] === "string" ? body["how"] : "",
        member: typeof body["member"] === "string" ? body["member"] : null,
      };
      const ran = yield* Effect.serviceOption(StepUps).pipe(
        Effect.flatMap((s) =>
          Option.isSome(s) ? s.value.settle(from, done) : Effect.succeed(false),
        ),
        Effect.provideContext(context),
      );
      return HttpServerResponse.jsonUnsafe({ ok: true, ran });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false }, { status: 500 })),
      ),
    );
    yield* router.add("POST", "/api/devices/r1/v1/voice/stepup", stepUp);
    // The room loop's enrolment, or a profile it already had (moving to one profile per member): saved on the home
    // as the owner's, never a member the loop names; it re-enrols only the owner today.
    const decodeVoice = Schema.decodeUnknownOption(VoiceUpload);
    const voice = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      // Any R1's key: each R1's room loop calls with its own.
      const device = r1ByKey(
        yield* Effect.flatMap(HomeAssistantService, (h) => h.devices).pipe(
          Effect.provideContext(context),
        ),
        bearer,
      );
      if (device === null)
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "Wrong device key." },
          { status: 401 },
        );
      yield* noteDeviceKeyUse(request).pipe(Effect.provideContext(context));
      const body = decodeVoice(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
      if (Option.isNone(body) || body.value.profile.kind !== "owner")
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "Send the owner's profile and whether it is a new enrolment." },
          { status: 400 },
        );
      const result = yield* Effect.flatMap(TessayaHousehold, (h) =>
        h.call({
          op: "saveVoice",
          profile: {
            ...body.value.profile,
            id: OWNER_MEMBER_ID,
            sources: body.value.profile.sources ?? ["spoken"],
          },
          fresh: body.value.fresh ?? true,
        }),
      ).pipe(
        Effect.provideService(HouseholdCaller, {
          member: OWNER_MEMBER_ID,
          assurance: 2,
          via: "the R1's enrolment",
        }),
        Effect.provideContext(context),
      );
      return HttpServerResponse.jsonUnsafe(
        { ok: result.status === "done", line: result.line },
        { status: result.status === "done" ? 200 : 409 },
      );
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false }, { status: 500 })),
      ),
    );
    yield* router.add("POST", "/api/devices/r1/v1/voice/profile", voice);
  }),
);
