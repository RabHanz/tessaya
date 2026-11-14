/**
 * The wake trainer's door and the vessels' (tessaya-ops research/WAKE-AUTOTRAIN-DESIGN.md, P3b). The trainer holds a
 * `tessaya:wake-trainer` token: requests, status, upload and enrolled voices only. Vessels fetch signed models with
 * their own session or an R1's device key; rollback and cancel need a session that may change settings.
 */
import { AuthSettingsWriteScope, AuthTessayaWakeTrainerScope } from "@t3tools/contracts";
import { OWNER_MEMBER_ID } from "@t3tools/baton-shared/household";
import { WAKE_TARGETS, type WakeTarget } from "@t3tools/baton-shared/wakeModels";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { HomeAssistantService, r1ByKey } from "../home/HomeAssistantService.ts";
import { requestUrl } from "../requestUrl.ts";
import { BatonRuntime } from "../baton/BatonRpcHandlers.ts";
import { TessayaWake } from "./TessayaWake.ts";

const WAKE_PATH = "/api/tessaya/wake/";
/** The largest model a trainer may send (an R1 pack is the biggest, well under this). */
const MAX_MODEL_BYTES = 32 * 1024 * 1024;

const Artifact = Schema.Struct({
  target: Schema.Literals(WAKE_TARGETS),
  format: Schema.Literals(["openwakeword-onnx", "kws-dscnn-int8", "r1-kws-pack"]),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  threshold: Schema.Number,
});
export const WakeStatusBody = Schema.Struct({
  word: Schema.String.check(Schema.isMaxLength(40)),
  version: Schema.Int,
  status: Schema.Literals(["training", "trained", "rejected", "failed"]),
  trainerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
  eval: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  artifacts: Schema.optionalKey(Schema.Array(Artifact).check(Schema.isMaxLength(3))),
});
const decodeStatus = Schema.decodeUnknownOption(WakeStatusBody);
const decodeRollback = Schema.decodeUnknownOption(
  Schema.Struct({ word: Schema.String, version: Schema.Int }),
);
const decodeCancel = Schema.decodeUnknownOption(Schema.Struct({ word: Schema.String }));

const say = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });
const answer = (r: { readonly refused: string } | object, refusedStatus = 409) =>
  "refused" in r
    ? say(refusedStatus, (r as { refused: string }).refused)
    : HttpServerResponse.jsonUnsafe(r);
/** About a minute of 16 kHz speech in base64, the most one enrolment sends. */
const MAX_ENROLMENT_BYTES = 4 * 1024 * 1024;
const decodeEnrolment = Schema.decodeUnknownOption(
  Schema.Struct({
    clips: Schema.Array(Schema.String.check(Schema.isMaxLength(1_000_000))).check(
      Schema.isMaxLength(30),
    ),
  }),
);

/** Who may use a wake route: the key is anyone's; models a paired vessel's or an R1's; the way back a settings writer's. */
export const wakeAccess = (
  route: string,
  scopes: ReadonlySet<string> | null,
  r1: boolean,
): { readonly status: number; readonly message: string } | null =>
  route === "GET key"
    ? null
    : route === "POST enrolment"
      ? r1
        ? null
        : { status: 401, message: "Only an R1's enrolment sends audio here." }
      : route === "GET models"
        ? scopes === null && !r1
          ? { status: 401, message: "Not paired." }
          : null
        : route === "POST rollback" || route === "POST cancel"
          ? scopes?.has(AuthSettingsWriteScope) === true
            ? null
            : { status: 403, message: "Only a session that may change settings can do that." }
          : scopes?.has(AuthTessayaWakeTrainerScope) === true
            ? null
            : { status: 403, message: "This token is not a wake trainer's." };

export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const context = yield* BatonRuntime;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    if (context === null) return;
    const wake = Context.getOption(context, TessayaWake);
    if (Option.isNone(wake)) return;
    const service = wake.value;
    const scopesOf = (request: HttpServerRequest.HttpServerRequest) =>
      auth.authenticateHttpRequest(request).pipe(
        Effect.map((s) => new Set<string>(s.scopes)),
        Effect.orElseSucceed(() => null),
      );
    const isR1 = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.flatMap(HomeAssistantService, (h) => h.devices).pipe(
        Effect.provideContext(context),
        Effect.map(
          (all) =>
            r1ByKey(all, (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "")) !==
            null,
        ),
        Effect.orElseSucceed(() => false),
      );

    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = Option.getOrNull(requestUrl(request));
      const parts = (url?.pathname.slice(WAKE_PATH.length) ?? "").split("/").filter(Boolean);
      const scopes = yield* scopesOf(request);
      const route = `${request.method} ${parts[0] ?? ""}`;
      const denied = wakeAccess(
        route,
        scopes,
        (route === "GET models" && scopes === null) || route === "POST enrolment"
          ? yield* isR1(request)
          : false,
      );
      if (denied !== null) return say(denied.status, denied.message);
      if (route === "GET key") return HttpServerResponse.text(yield* service.publicKey);
      if (route === "GET models" && parts.length === 3) {
        const target = parts[2] as WakeTarget;
        if (!WAKE_TARGETS.includes(target)) return say(404, "No such target.");
        const found = yield* service.model(decodeURIComponent(parts[1]!), target);
        if (found === null) return say(404, "No signed model for that word yet.");
        return HttpServerResponse.uint8Array(found.bytes, {
          contentType: "application/octet-stream",
          headers: {
            "x-tessaya-wake-version": String(found.version),
            "x-tessaya-wake-format": found.artifact.format,
            "x-tessaya-wake-sha256": found.artifact.sha256,
            "x-tessaya-wake-threshold": String(found.artifact.threshold),
            "x-tessaya-wake-signature": found.artifact.signature ?? "",
          },
        });
      }
      if (route === "POST rollback" || route === "POST cancel") {
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
        if (route === "POST cancel") {
          const input = decodeCancel(body);
          return Option.isNone(input)
            ? say(400, "That request is not valid.")
            : answer(yield* service.cancel(input.value.word));
        }
        const input = decodeRollback(body);
        return Option.isNone(input)
          ? say(400, "That request is not valid.")
          : answer(yield* service.rollback(input.value.word, input.value.version));
      }
      if (route === "GET requests") return HttpServerResponse.jsonUnsafe(yield* service.requests);
      if (route === "POST status") {
        const input = decodeStatus(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
        if (Option.isNone(input)) return say(400, "That report is not valid.");
        const { trainerId, ...status } = input.value;
        return answer(yield* service.status(status, trainerId));
      }
      if (route === "PUT models" && parts.length === 4) {
        const length = Number(request.headers["content-length"] ?? Number.NaN);
        if (!(length > 0 && length <= MAX_MODEL_BYTES)) return say(413, "Too large or empty.");
        const target = parts[3] as WakeTarget;
        const version = Number(parts[2]);
        if (!WAKE_TARGETS.includes(target) || !Number.isInteger(version))
          return say(404, "No such model.");
        const bytes = new Uint8Array(yield* request.arrayBuffer);
        return answer(yield* service.upload(decodeURIComponent(parts[1]!), version, target, bytes));
      }
      // Enrolled voices leave only with that member's switch on, checked on every call.
      if (route === "GET voices" && (parts.length === 2 || parts.length === 3)) {
        const person = decodeURIComponent(parts[1]!);
        if (parts.length === 2) return answer(yield* service.voices(person), 403);
        const wav = yield* service.voiceClip(person, parts[2]!);
        if (wav === null) return say(404, "No such clip.");
        if ("refused" in wav) return say(403, wav.refused);
        return HttpServerResponse.uint8Array(wav, { contentType: "audio/wav" });
      }
      // The R1's enrolment: his windows of speech, kept for training only while his switch is on.
      if (route === "POST enrolment") {
        const length = Number(request.headers["content-length"] ?? Number.NaN);
        if (!(length > 0 && length <= MAX_ENROLMENT_BYTES)) return say(413, "Too large or empty.");
        const body = decodeEnrolment(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
        if (Option.isNone(body)) return say(400, "That request is not valid.");
        const clips = body.value.clips.map((b64) => {
          const bytes = Buffer.from(b64, "base64");
          return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
        });
        return HttpServerResponse.jsonUnsafe(yield* service.keepEnrolment(OWNER_MEMBER_ID, clips));
      }
      return say(404, "No such wake route.");
    }).pipe(Effect.catchCause(() => Effect.succeed(say(500, "That did not work."))));
    for (const method of ["GET", "POST", "PUT"] as const)
      yield* router.add(method, `${WAKE_PATH}*`, handle);
  }),
);
