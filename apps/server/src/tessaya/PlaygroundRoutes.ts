/**
 * The body playground's page and calls under /tessaya/playground (M-089), behind the server's own session like the
 * other Tessaya pages. A household client only: an agent's token drives the playground through MCP, not here.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { emitAction } from "../provenance/ActionLog.ts";
import { BUS_ID, pollBus, reportBus, watchBus } from "./BodyPlayground.ts";
import { PersonaLayers } from "./PersonaLayers.ts";
import { everydayBody } from "./PlaygroundAsset.ts";
import {
  DIRECT_MODELS,
  directBody,
  directModelId,
  estimateDirect,
  ratedRow,
  runOf,
  startedRun,
  type DirectModel,
  type DirectProgress,
} from "./BodyDirect.ts";
import { readPriceList } from "./TessayaJobSpend.ts";
import { PLAYGROUND_HTML, PLAYGROUND_START } from "./PlaygroundPage.ts";
import { householdCallerOf, householdRefusal } from "./TessayaRpcAuthorization.ts";
import type * as TessayaRpcHandlers from "./TessayaRpcHandlers.ts";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";

// framed only by her own pages (Personas › Lab › Body, D-038), never by another site
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; media-src blob:; frame-ancestors 'self'",
} as const;
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: HEADERS });
const ACTION = /^[a-z][a-z.-]{1,40}$/;
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRows = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
const sizeOf = (v: unknown) =>
  encodeJson(v).pipe(
    Effect.map((t) => t.length),
    Effect.orElseSucceed(() => Infinity),
  );

export interface PlaygroundWho {
  readonly owner: string;
  readonly member: string | null;
  /** userdata, for the price list and his ratings */
  readonly userdata: string;
}
const isOwner = (who: PlaygroundWho) => who.member === null || who.member === OWNER_MEMBER_ID;
const modelOf = (v: unknown): DirectModel | null => DIRECT_MODELS.find((m) => m === v) ?? null;
let runCount = 0;
const ratingsFile = (userdata: string) =>
  NodePath.join(userdata, "tessaya", "body-playground-ratings.json");

/** One call from the playground page: its bus, its state, its record, and which models to open. */
export const playgroundCall = Effect.fn("PlaygroundRoutes.call")(function* (
  op: string,
  body: Record<string, unknown>,
  who: PlaygroundWho,
) {
  const bus = typeof body["bus"] === "string" ? body["bus"] : "";
  switch (op) {
    case "poll":
      return yield* pollBus({
        bus,
        owner: who.owner,
        after: typeof body["after"] === "number" ? body["after"] : 0,
        waitMs: typeof body["wait"] === "number" ? body["wait"] : 0,
      });
    case "state":
      return { ok: reportBus({ bus, owner: who.owner, state: body["state"] }) };
    case "act": {
      const action = typeof body["action"] === "string" ? body["action"] : "";
      if (!ACTION.test(action)) return null;
      const data = body["data"];
      return {
        id: yield* emitAction({
          kind: `body.playground.${action}`,
          actor:
            who.member === null || who.member === OWNER_MEMBER_ID
              ? { kind: "owner", certainty: 1 }
              : { kind: "member", id: who.member, certainty: 1 },
          ...(typeof body["subject"] === "string"
            ? { subject: body["subject"].slice(0, 120) }
            : {}),
          ...(typeof body["cause"] === "string" ? { cause: [body["cause"].slice(0, 80)] } : {}),
          ...(data !== null && typeof data === "object" && (yield* sizeOf(data)) <= 2000
            ? { data: data as Record<string, unknown> }
            : {}),
        }),
      };
    }
    case "hello": {
      const layers = yield* Effect.serviceOption(PersonaLayers);
      const all = layers._tag === "Some" ? layers.value.all : [];
      return {
        // his own models in his layer's order; the page falls back to the CC0 Everyday only when this is empty
        models: all.flatMap((l) => l.playgroundModels?.(who.member) ?? []).slice(0, 12),
      };
    }
    // "Agent drives her": a model he picked, spending his key or plan, so his own sessions only.
    case "agent.estimate": {
      const model = modelOf(body["model"]);
      if (model === null || !isOwner(who)) return null;
      const id = yield* directModelId(model);
      const said = typeof body["said"] === "string" ? body["said"].slice(0, 300) : "";
      return { model: id, ...estimateDirect(readPriceList(who.userdata)?.table ?? null, id, said) };
    }
    case "agent.start": {
      const model = modelOf(body["model"]);
      const said = typeof body["said"] === "string" ? body["said"].trim().slice(0, 300) : "";
      if (model === null || said === "" || !isOwner(who) || !BUS_ID.test(bus)) return null;
      const id = `r${(yield* Clock.currentTimeMillis).toString(36)}${(runCount++).toString(36)}`;
      const progress: DirectProgress = {
        model,
        said,
        calls: [],
        done: false,
        reasoning: "",
        firstMotionMs: null,
        ms: null,
        graded: null,
        error: null,
      };
      startedRun(id, progress);
      yield* emitAction({
        kind: "body.playground.direct",
        actor: { kind: "owner", certainty: 1 },
        subject: model,
        data: { run: id, playground: bus, alsoHer: body["alsoHer"] === true },
      });
      yield* Effect.forkDetach(
        directBody({ said, model, playground: bus, alsoHer: body["alsoHer"] === true, progress }),
      );
      return { id };
    }
    case "agent.poll": {
      const run = typeof body["id"] === "string" ? runOf(body["id"]) : null;
      return run === null || !isOwner(who) ? null : run;
    }
    case "agent.rate": {
      const id = typeof body["id"] === "string" ? body["id"] : "";
      const run = runOf(id);
      if (run === null || !run.done || !isOwner(who)) return null;
      const good = body["good"] === true;
      const note = typeof body["note"] === "string" ? body["note"].slice(0, 500) : "";
      const row = ratedRow(id, run, good, note, yield* Clock.currentTimeMillis);
      const file = ratingsFile(who.userdata);
      const text = yield* Effect.promise(() =>
        NodeFS.promises.readFile(file, "utf8").catch(() => "[]"),
      );
      const kept = yield* decodeRows(text).pipe(Effect.orElseSucceed(() => []));
      const next = yield* encodeJson([
        ...kept.filter((r) => (r as { id?: unknown } | null)?.id !== row.id),
        row,
      ]);
      yield* Effect.promise(async () => {
        await NodeFS.promises.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFS.promises.writeFile(file, next);
      });
      yield* emitAction({
        kind: "body.playground.rated",
        actor: { kind: "owner", certainty: 1 },
        subject: run.model,
        outcome: good ? "good" : "bad",
        data: { run: id, pass: row.pass },
      });
      return { ok: true, harvest: row.pass };
    }
    default:
      return null;
  }
});

export const playgroundRoutes = Effect.fn("PlaygroundRoutes.mount")(function* (
  router: HttpRouter.HttpRouter,
  context: Context.Context<TessayaRpcHandlers.TessayaServices>,
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  userdata: string,
) {
  const whoOf = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (session._tag === "None" || householdRefusal(session.value) !== null) return null;
    const caller = householdCallerOf(session.value);
    if (caller.service) return null;
    return {
      owner: session.value.subject,
      member: caller.member,
      userdata,
    } satisfies PlaygroundWho;
  });
  const page = (body: string, contentType: string) =>
    Effect.succeed(HttpServerResponse.text(body, { contentType, headers: HEADERS }));
  yield* router.add(
    "GET",
    "/tessaya/playground",
    page(PLAYGROUND_HTML, "text/html; charset=utf-8"),
  );
  yield* router.add(
    "GET",
    "/tessaya/playground/start.js",
    page(PLAYGROUND_START, "text/javascript; charset=utf-8"),
  );
  yield* router.add(
    "GET",
    "/tessaya/playground/everyday.vrm",
    Effect.gen(function* () {
      if ((yield* whoOf) === null) return json({ message: "Not paired." }, 401);
      const bytes = yield* Effect.promise(() => everydayBody(userdata));
      return bytes === null
        ? json({ message: "The default body couldn't be fetched. Drop a model instead." }, 503)
        : HttpServerResponse.uint8Array(bytes, {
            contentType: "model/gltf-binary",
            headers: { ...HEADERS, "cache-control": "private, max-age=86400" },
          });
    }),
  );
  // The page's bus as a socket: nothing runs while nothing is published.
  yield* router.add(
    "GET",
    "/tessaya/playground/api/push",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const who = yield* whoOf;
      const bus = new URL(request.url, "http://local").searchParams.get("bus") ?? "";
      if (who === null) return json({ message: "Not paired." }, 401);
      if (request.headers["upgrade"]?.toLowerCase() !== "websocket" || !BUS_ID.test(bus))
        return json({ message: "Not here." }, 404);
      const socket = yield* request.upgrade;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const write = (yield* socket.writer).write;
          const { pull } = yield* socket.reader;
          // the page closing its end (or anything it sends) ends the push
          return yield* Effect.raceFirst(
            watchBus({ bus, owner: who.owner }, (text) => write(text)),
            Effect.forever(pull),
          );
        }),
      ).pipe(Effect.ignoreCause);
      return HttpServerResponse.empty();
    }).pipe(Effect.catchCause(() => Effect.succeed(json({ message: "Not here." }, 404)))),
  );
  yield* router.add(
    "POST",
    "/tessaya/playground/api/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const who = yield* whoOf;
      if (who === null) return json({ message: "Not paired." }, 401);
      const op = new URL(request.url, "http://local").pathname.replace(
        /^\/tessaya\/playground\/api\//,
        "",
      );
      const body = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
      const answer = yield* playgroundCall(
        op,
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {},
        who,
      ).pipe(Effect.provideContext(context));
      return answer === null ? json({ message: "Not here." }, 404) : json(answer);
    }).pipe(Effect.catchCause(() => Effect.succeed(json({ message: "That did not work." }, 500)))),
  );
});
